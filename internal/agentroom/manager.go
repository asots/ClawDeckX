package agentroom

import (
	"context"
	"encoding/json"
	"sync"

	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/openclaw"
)

// Manager 保存全局 orchestrator 注册表：一个房间对应一个后台 goroutine。
// 创建房间时懒启动；关闭/归档时停止。
//
// v0.4：Manager 持有 *Bridge（OpenClaw Gateway RPC 适配器）替代原来的
// ToolBridge + configPath。所有 LLM 推理走 bridge；纯本地工具 approval 已移除。
type Manager struct {
	mu            sync.RWMutex
	repo          *Repo
	broker        *Broker
	projector     *Projector
	bridge        *Bridge
	orchestrators map[string]*Orchestrator
	rootCtx       context.Context
	rootCancel    context.CancelFunc
	// v0.4：上下文压缩实时事件总线 —— 订阅 gateway `agent` 流，
	// 按 sessionKey 分发给 bridge.Run 当前订阅者，取代纯 history polling。
	// 见 compaction_bus.go 与 ocbridge.go 的使用点。
	gw            *openclaw.GWClient
	compactionBus *CompactionBus
}

// gwEventListenerName 是本 Manager 在 GWClient fan-out 里的唯一名字。
// 单例 Manager 预设；多实例场景不会出现在该仓库里，因此不做唯一化处理。
const gwEventListenerName = "agentroom.compaction"

// NewManager 构造 Manager。gw 可为 nil（测试 / gateway 未就绪时），
// orchestrator 遇到不可用 bridge 会把该轮次标记为错误并继续，不会崩溃。
func NewManager(repo *Repo, broker *Broker, gw *openclaw.GWClient) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	bus := NewCompactionBus()
	bridge := NewBridge(gw)
	bridge.SetCompactionBus(bus)
	return &Manager{
		repo:          repo,
		broker:        broker,
		projector:     NewProjector(nil),
		bridge:        bridge,
		orchestrators: make(map[string]*Orchestrator),
		rootCtx:       ctx,
		rootCancel:    cancel,
		gw:            gw,
		compactionBus: bus,
	}
}

// Bootstrap 启动恢复：
//  1. 建立 / 校验 FTS5 虚表 + 触发器
//  2. 清理 stale streaming 消息
//  3. 预热所有 state=active 房间
//
// 失败不致命，只打日志。
func (m *Manager) Bootstrap() {
	if err := EnsureFTS(); err != nil {
		logger.Log.Warn().Err(err).Msg("agentroom: ensure FTS5 failed; full-text search will be unavailable")
	}
	if err := EnsureDocFTS(); err != nil {
		logger.Log.Warn().Err(err).Msg("agentroom: ensure doc FTS5 failed; RAG search will be unavailable")
	}
	// 一次性迁移：清理历史模板遗留在 agentroom_members.model 里的硬编码模型名。
	// 这些值（claude-sonnet-4.5 / claude-opus-4 / claude-haiku-4）在 OpenClaw 侧根本不存在，
	// 会导致 agent 返回空回复。清空后走 agent 默认模型（用户在 OpenClaw 里实际配置的那个）。
	if n, err := m.repo.SanitizeLegacyMemberModels(); err != nil {
		logger.Log.Warn().Err(err).Msg("agentroom: sanitize legacy member models failed")
	} else if n > 0 {
		logger.Log.Info().Int64("members", n).Msg("agentroom: cleared legacy hardcoded model names from member rows")
	}
	if count, err := m.repo.CountBuiltInRoleProfiles(); err != nil {
		logger.Log.Warn().Err(err).Msg("agentroom: count built-in role profiles failed")
	} else if count == 0 {
		if err := m.repo.SeedBuiltInRoleProfiles(BuiltInRoleProfileSeeds()); err != nil {
			logger.Log.Warn().Err(err).Msg("agentroom: seed built-in role profiles failed")
		} else {
			logger.Log.Info().Msg("agentroom: seeded built-in role profiles from templates")
		}
	}
	if n, err := m.repo.ResetStaleStreaming(); err != nil {
		logger.Log.Warn().Err(err).Msg("agentroom: reset stale streaming failed")
	} else if n > 0 {
		logger.Log.Info().Int64("count", n).Msg("agentroom: reset stale streaming messages")
	}
	ids, err := m.repo.ListActiveRoomIDs()
	if err != nil {
		logger.Log.Warn().Err(err).Msg("agentroom: list active rooms failed")
		return
	}
	for _, id := range ids {
		_ = m.Get(id) // 懒启动一次即挂后台 goroutine
	}
	if len(ids) > 0 {
		logger.Log.Info().Int("rooms", len(ids)).Msg("agentroom: warmed up active rooms")
	}
	// v0.4：挂载 gateway `agent` 事件监听器，将 auto_compaction_start/end 等
	// 流实时路由到 CompactionBus，给 UI 带来 ~100ms 级的压缩横幅响应速度
	// （原 history polling 最坏 ~500ms + 依赖 session.history RPC 来回）。
	// GWClient 的 fan-out 保证 gwcollector 的原有 onEvent 不受影响。
	if m.gw != nil {
		m.gw.AddEventListener(gwEventListenerName, m.handleGatewayEvent)
		logger.Log.Info().Msg("agentroom: subscribed to gateway events for realtime compaction signals")
	}
}

// handleGatewayEvent 是 GWClient 副听众入口。目前只消费 `agent` 流，
// 忽略其他事件（session.updated / cron.* / log 等已被 gwcollector 处理）。
// 回调 MUST 快速返回；ParseCompactionEvent 是纯 JSON 解析，无 I/O。
func (m *Manager) handleGatewayEvent(event string, payload json.RawMessage) {
	if event != "agent" || m.compactionBus == nil {
		return
	}
	sessionKey, phase, summary, willRetry, ok := ParseCompactionEvent(payload)
	if !ok {
		return
	}
	m.compactionBus.Dispatch(sessionKey, phase, summary, willRetry)
}

// SetProjectionHook 允许外部在运行时注入 platform+channelID → URL 解析器。
func (m *Manager) SetProjectionHook(hook func(platform, channelID string) string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.projector = NewProjector(hook)
}

// Shutdown 关闭所有 orchestrator。
func (m *Manager) Shutdown() {
	// 先撤销 gateway 监听，避免停机过程中还在处理事件
	if m.gw != nil {
		m.gw.RemoveEventListener(gwEventListenerName)
	}
	m.rootCancel()
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, o := range m.orchestrators {
		o.Stop()
	}
	m.orchestrators = map[string]*Orchestrator{}
}

// Get 取（或懒启动）某房间的 orchestrator。
func (m *Manager) Get(roomID string) *Orchestrator {
	m.mu.RLock()
	if o, ok := m.orchestrators[roomID]; ok {
		m.mu.RUnlock()
		return o
	}
	m.mu.RUnlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if o, ok := m.orchestrators[roomID]; ok {
		return o
	}
	o := NewOrchestrator(roomID, Config{
		Repo:      m.repo,
		Broker:    m.broker,
		Projector: m.projector,
		Bridge:    m.bridge,
	})
	o.Start(m.rootCtx)
	m.orchestrators[roomID] = o
	return o
}

// GetIfExists 取已存在的 orchestrator，不存在时返回 nil（不会懒创建）。
// 用于动态增减成员时通知 orchestrator 刷新——房间未加载说明没有活跃调度，无需通知。
func (m *Manager) GetIfExists(roomID string) *Orchestrator {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.orchestrators[roomID]
}

// Drop 移除某房间的 orchestrator（删除/归档时调用）。
func (m *Manager) Drop(roomID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if o, ok := m.orchestrators[roomID]; ok {
		o.Stop()
		delete(m.orchestrators, roomID)
	}
}

// Broker 返回全局广播 broker。
func (m *Manager) Broker() *Broker { return m.broker }

// Repo 返回底层仓库，方便 handler 在不走 orchestrator 的只读操作中使用。
func (m *Manager) Repo() *Repo { return m.repo }

// ActiveOrchestratorCount 返回内存中已 warm-up 的 orchestrator 数量。
// 用于 Prometheus gauge。
func (m *Manager) ActiveOrchestratorCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.orchestrators)
}

// Bridge 返回 OpenClaw Gateway RPC 桥接器（handler 用于 session 生命周期、
// agents.list 代理等）。
func (m *Manager) Bridge() *Bridge { return m.bridge }
