// AgentRoom 服务层 —— 真实后端接入（/api/v1/agentroom/*）+ WS 频道订阅（agentroom:{roomId}）
//
// 对外导出接口与旧 mock 版本完全兼容，组件无需修改：
//   roomEvents           —— EventBus，.on('message.append' / 'message.update' / ...) 订阅
//   subscribeRoomChannel —— 打开房间的 WS 频道（引用计数；组件 mount/unmount 配对）
//   SUGGESTED_MODELS / SUGGESTED_EMOJIS —— 自定义向导下拉
//   list/get/create/update/fork/delete room、message、member、fact、task、intervention、emergencyStop、forceNextSpeaker
//
// 实现要点：
//   - HTTP 走 services/request.ts（统一 cookie/JWT + 错误码翻译）
//   - WS 复用 /api/v1/ws，发送 `{action:"subscribe", channels:["agentroom:<id>"]}`
//   - 服务端广播的 {type, data:{roomId,type,payload}} 被映射成 roomEvents

import type {
  Room, Member, Message, RoomTemplate, RoomMetrics,
  RoomPolicy, InterventionEvent, RoomState, RoomFact, RoomTask,
  RoomProjection, ProjectionTarget,
  ToolResult, GatewayAgentInfo, GatewayStatus,
  TemplateMemberOverride,
  // v0.7 真实会议环节
  AgendaItem, OpenQuestion, ParkingLotItem, Risk, Vote, VoteBallot, VoteMode,
  Retro, CloseoutResult, OutcomeBundle, PlaybookV7, PlaybookStep, RoleProfile,
} from './types';
import { get, post, put as putReq, del } from '../../services/request';
import { gwApi } from '../../services/api';

// ── 简易事件总线（订阅新消息等）──
type Listener<T> = (payload: T) => void;
class EventBus<Events extends Record<string, any>> {
  private listeners = new Map<keyof Events, Set<Listener<any>>>();
  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }
  emit<K extends keyof Events>(event: K, payload: Events[K]) {
    this.listeners.get(event)?.forEach(fn => fn(payload));
  }
}

export const roomEvents = new EventBus<{
  'message.append': { roomId: string; message: Message };
  'message.update': { roomId: string; messageId: string; patch: Partial<Message> };
  'member.update': { roomId: string; memberId: string; patch: Partial<Member> };
  'member.added': { roomId: string; member: Member };
  'member.removed': { roomId: string; memberId: string; cascade: boolean };
  'room.update': { roomId: string; patch: Partial<Room> };
  'intervention': InterventionEvent;
  'bidding.start': { roomId: string; agentIds: string[] };
  'bidding.snapshot': { roomId: string; scores: { memberId: string; score: number }[] };
  // planned policy：phase / queue / ownerIdx 变化
  'planning.update': { roomId: string; phase: 'discussion' | 'executing' | 'review'; queue: string[]; executionOwnerIdx: number };
  // WS 连接状态（open/closed/reconnected）——前端用于显示断线条 + 重连后重拉状态
  'ws.status': { status: 'connecting' | 'open' | 'closed'; reconnected: boolean };
  // v0.4：OpenClaw 上下文压缩事件 —— orchestrator/bridge 检测到某成员 session 正在压缩上下文时转发，
  // UI 据此渲染"正在压缩上下文"顶部横幅，避免用户以为模型卡死。
  'context.compaction': {
    roomId: string;
    memberId?: string;
    sessionKey?: string;
    phase: 'start' | 'end';
    willRetry?: boolean;
    summary?: string; // 压缩后 summary（phase==='end' 时可能有）
  };
  // v0.4：OpenClaw 原生执行的工具结果（后端 ocbridge.broadcastToolCalls 推送）。
  // 注意：工具调用的审批由 OpenClaw 自己的 exec.approval 流处理，不再走 AgentRoom。
  'tool.result': { roomId: string; messageId: string; result: ToolResult };
  // v0.4：OpenClaw Gateway 桥接状态变更，UI 据此显示"桥接离线"提示。
  'gateway.status': { available: boolean };
  // 通用 API 错误（用于 toast）
  'api.error': { message: string; code?: string };
}>();

// ──────────────────────────────────────────────────────────
// WS 频道订阅（单例 + 引用计数）
// ──────────────────────────────────────────────────────────

class RoomWSBus {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private heartbeat: number | null = null;
  private backoffMs = 800;
  private subscribedChannels = new Set<string>();
  private refcount = new Map<string, number>();
  private hadOpen = false; // 曾经打开过 → 下次 onopen 是 "reconnected"
  // 当前 WS 状态：组件重挂载（例如关掉再打开 AI 会议窗口）时，
  // useState 初始值回落到 'connecting' 但底层 WS 可能已经 OPEN，
  // 没有新的 onopen 回调触发；这里缓存一份，让 subscribe 时立即回放当前状态。
  private currentStatus: 'connecting' | 'open' | 'closed' = 'closed';

  subscribe(roomId: string): () => void {
    const ch = `agentroom:${roomId}`;
    this.refcount.set(ch, (this.refcount.get(ch) ?? 0) + 1);
    this.subscribedChannels.add(ch);
    this.ensureConnected();
    this.sendSubscribe([ch]);
    // 立刻把当前状态回放给新订阅者 —— 解决组件重挂载时 'connecting' 卡死的问题。
    // reconnected=false：这是一次重放，不是真的重连成功，避免触发 refetch。
    roomEvents.emit('ws.status', { status: this.currentStatus, reconnected: false });
    return () => {
      const n = (this.refcount.get(ch) ?? 1) - 1;
      if (n <= 0) {
        this.refcount.delete(ch);
        this.subscribedChannels.delete(ch);
        this.sendUnsubscribe(ch);
      } else {
        this.refcount.set(ch, n);
      }
    };
  }

  private ensureConnected() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.connect();
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.currentStatus = 'connecting';
    roomEvents.emit('ws.status', { status: 'connecting', reconnected: false });
    const ws = new WebSocket(`${proto}//${location.host}/api/v1/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = 800;
      if (this.subscribedChannels.size > 0) {
        this.sendSubscribe([...this.subscribedChannels]);
      }
      this.startHeartbeat();
      const reconnected = this.hadOpen;
      this.hadOpen = true;
      this.currentStatus = 'open';
      roomEvents.emit('ws.status', { status: 'open', reconnected });
    };
    ws.onmessage = (evt) => this.handleMessage(evt.data);
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.stopHeartbeat();
      this.currentStatus = 'closed';
      roomEvents.emit('ws.status', { status: 'closed', reconnected: false });
      if (this.refcount.size > 0) this.scheduleReconnect();
    };
    ws.onerror = () => { /* rely on onclose */ };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) return;
    const jitter = 1 + (Math.random() * 0.4 - 0.2);
    const d = Math.floor(this.backoffMs * jitter);
    this.backoffMs = Math.min(Math.floor(this.backoffMs * 1.7), 15000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, d);
  }

  private sendSubscribe(channels: string[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify({ action: 'subscribe', channels })); } catch { /* ignore */ }
  }
  private sendUnsubscribe(channel: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify({ action: 'unsubscribe', channel })); } catch { /* ignore */ }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try { this.ws.send(JSON.stringify({ action: 'ping' })); } catch { /* ignore */ }
    }, 30000);
  }
  private stopHeartbeat() {
    if (this.heartbeat != null) { window.clearInterval(this.heartbeat); this.heartbeat = null; }
  }

  private handleMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || msg.action === 'pong') return;
    // 服务端 WSMessage 形状：{ type: <eventType>, data: <Event> }
    // Event 形状：{ roomId, type, payload }
    const eventType: string = msg.type || '';
    const evt = msg.data;
    if (!evt || typeof evt !== 'object') return;
    const roomId: string = evt.roomId;
    const payload = evt.payload;
    if (!roomId || payload == null) return;

    switch (eventType) {
      case 'message.append':
        if (payload.message) roomEvents.emit('message.append', { roomId, message: payload.message });
        break;
      case 'message.update':
        if (payload.messageId) {
          roomEvents.emit('message.update', {
            roomId, messageId: payload.messageId, patch: payload.patch || {},
          });
        }
        break;
      case 'member.update':
        if (payload.memberId) {
          roomEvents.emit('member.update', {
            roomId, memberId: payload.memberId, patch: payload.patch || {},
          });
        }
        break;
      case 'member.added':
        if (payload.member) {
          roomEvents.emit('member.added', { roomId, member: payload.member });
        }
        break;
      case 'member.removed':
        if (payload.memberId) {
          roomEvents.emit('member.removed', {
            roomId, memberId: payload.memberId, cascade: !!payload.cascade,
          });
        }
        break;
      case 'room.update':
        roomEvents.emit('room.update', { roomId, patch: payload.patch || {} });
        break;
      case 'intervention':
        roomEvents.emit('intervention', payload as InterventionEvent);
        break;
      case 'bidding.start':
        roomEvents.emit('bidding.start', {
          roomId, agentIds: payload.agentIds || [],
        });
        break;
      case 'bidding.snapshot':
        roomEvents.emit('bidding.snapshot', {
          roomId, scores: payload.scores || [],
        });
        break;
      case 'planning.update':
        roomEvents.emit('planning.update', {
          roomId,
          phase: payload.phase || 'discussion',
          queue: payload.queue || [],
          executionOwnerIdx: payload.executionOwnerIdx ?? 0,
        });
        break;
      case 'tool.result':
        if (payload.result) {
          roomEvents.emit('tool.result', {
            roomId,
            messageId: payload.messageId || '',
            result: payload.result,
          });
        }
        break;
      case 'context.compaction':
        if (payload.phase === 'start' || payload.phase === 'end') {
          roomEvents.emit('context.compaction', {
            roomId,
            memberId: payload.memberId,
            sessionKey: payload.sessionKey,
            phase: payload.phase,
            willRetry: payload.willRetry,
            summary: payload.summary,
          });
        }
        break;
      default:
        // v0.9：agentroom 的子域事件（room.agenda.* / room.question.* / room.risk.* /
        // room.vote.* / room.task.* / room.artifact.* / room.closeout.* / room.decision.*）
        // 之前没有显式 case，结果 VotePanel / RisksPanel / QuestionsPanel 等订阅了却收不到，
        // 面板只能靠初次 fetch 拉数据，agent 或别的用户新增的项无法实时同步。
        // 这里做一个通用透传：把 payload 平铺到事件 payload 上，保持 roomId 字段。
        // 事件消费者期望的 shape 由 broker 侧定义（例如 { roomId, vote }），这样刚好对得上。
        if (eventType.startsWith('room.')) {
          const merged = { roomId, ...(payload as Record<string, unknown>) };
          roomEvents.emit(eventType as never, merged as never);
        }
        break;
    }
  }
}

const roomBus = new RoomWSBus();

/** 订阅指定房间的实时事件。返回 unsubscribe 函数。组件 mount 时调用，unmount 时执行返回值。 */
export function subscribeRoomChannel(roomId: string): () => void {
  return roomBus.subscribe(roomId);
}

// ──────────────────────────────────────────────────────────
// HTTP 端点
// ──────────────────────────────────────────────────────────

const API = '/api/v1/agentroom';

// withToast 包裹一个 Promise：失败时发 api.error 事件（供 UI toast 消费），
// 同时把错误再次抛出，调用方仍可以捕获/忽略。
function withToast<T>(p: Promise<T>, fallbackMsg = '操作失败'): Promise<T> {
  return p.catch(err => {
    const e = err as { code?: string; message?: string } | undefined;
    roomEvents.emit('api.error', {
      message: e?.message || fallbackMsg,
      code: e?.code,
    });
    throw err;
  });
}

// ── 模板 ──

export async function listTemplates(): Promise<RoomTemplate[]> {
  return await get<RoomTemplate[]>(`${API}/templates`);
}

export async function getTemplate(id: string): Promise<RoomTemplate | null> {
  const all = await listTemplates();
  return all.find(t => t.id === id) || null;
}

// ── v0.7+ 调参 / preset / prompt defaults ──
// 这三个接口都是"全局只读资源"，不属于某个房间，缓存一次即可（getCached 30s）。
// 应用到房间则走 updateRoom({ policyOptions: {...} }) —— 已有通道，无需新 endpoint。

import type { PolicyPresetMeta, PromptPack } from './types';

/** 列出所有可选调参预设（轻松闲聊 / 深度工作 / 辩论 / 头脑风暴 / 计划执行） */
export async function listPresets(): Promise<PolicyPresetMeta[]> {
  return await get<PolicyPresetMeta[]>(`${API}/presets`);
}

/** 获取默认 PromptPack —— 供 RoomTuningModal 占位符、"恢复默认"按钮使用 */
export async function getPromptDefaults(): Promise<PromptPack> {
  return await get<PromptPack>(`${API}/prompt-defaults`);
}

// ── 房间 CRUD ──

export async function listRooms(): Promise<Room[]> {
  return await get<Room[]>(`${API}/rooms`);
}

export async function getRoom(id: string): Promise<Room | null> {
  try {
    return await get<Room>(`${API}/rooms/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

export async function createRoomFromTemplate(templateId: string, opts: {
  title?: string;
  initialPrompt?: string;
  budgetCNY?: number;
  // v0.4：按 roleId 覆盖模板 member 的 agent / thinking / model。
  memberOverrides?: TemplateMemberOverride[];
  // v0.4：房间级辅助模型（竞言 / 纪要 / 决议概括等调用），空 = 跟随全局默认
  auxModel?: string;
  // v0.8：建房时选的冲突驱动模式（'review' / 'debate'），覆盖模板 preset。
  conflictMode?: '' | 'review' | 'debate';
}): Promise<Room> {
  return await withToast(post<Room>(`${API}/rooms`, {
    kind: 'template',
    templateId,
    title: opts.title,
    initialPrompt: opts.initialPrompt,
    budgetCNY: opts.budgetCNY,
    memberOverrides: opts.memberOverrides,
    auxModel: opts.auxModel,
    policyOptions: opts.conflictMode ? { conflictMode: opts.conflictMode } : undefined,
  }), '创建房间失败');
}

// ── 自定义房间（"自己搭建" 5 步）──

export interface CustomMemberSpec {
  role: string;
  roleProfileId?: string;
  emoji?: string;
  model?: string;
  isModerator?: boolean;
  systemPrompt?: string;
  // v0.4：绑定上游 OpenClaw agent。空 = 用 "default"。
  agentId?: string;
  // "off" | "low" | "medium" | "high"，空 = 用 agent 默认。
  thinking?: string;
}

export async function createCustomRoom(opts: {
  title: string;
  goal?: string;
  members: CustomMemberSpec[];
  policy: RoomPolicy;
  budgetCNY: number;
  initialPrompt?: string;
  // v0.4：房间级辅助模型
  auxModel?: string;
  // v0.8：建房时选的冲突驱动模式（'review' / 'debate'）。
  conflictMode?: '' | 'review' | 'debate';
  // v0.9：房间级协作节奏 —— 轮次硬闸（0/undefined = 无上限）+ 协作风格一句话。
  // 后端 Room 结构体直接绑定这两个字段；create 时透传等同进房后 PATCH。
  roundBudget?: number;
  collaborationStyle?: string;
}): Promise<Room> {
  return await withToast(post<Room>(`${API}/rooms`, {
    kind: 'custom',
    title: opts.title,
    goal: opts.goal,
    members: opts.members.map(m => ({
      roleId: m.role,
      roleProfileId: m.roleProfileId,
      role: m.role,
      emoji: m.emoji,
      model: m.model,
      isModerator: m.isModerator,
      systemPrompt: m.systemPrompt,
      agentId: m.agentId,
      thinking: m.thinking,
    })),
    policy: opts.policy,
    budgetCNY: opts.budgetCNY,
    initialPrompt: opts.initialPrompt,
    auxModel: opts.auxModel,
    roundBudget: opts.roundBudget,
    collaborationStyle: opts.collaborationStyle,
    policyOptions: opts.conflictMode ? { conflictMode: opts.conflictMode } : undefined,
  }), '创建房间失败');
}

export async function listRoleProfiles(category?: string): Promise<RoleProfile[]> {
  const q = category ? `?category=${encodeURIComponent(category)}` : '';
  return await withToast(get<RoleProfile[]>(`${API}/role-profiles${q}`), '加载角色库失败');
}

export async function createRoleProfile(payload: Partial<RoleProfile>): Promise<RoleProfile> {
  return await withToast(post<RoleProfile>(`${API}/role-profiles`, payload), '创建角色失败');
}

export async function updateRoleProfile(id: string, payload: Partial<RoleProfile>): Promise<RoleProfile> {
  return await withToast(putReq<RoleProfile>(`${API}/role-profiles/${id}`, payload), '保存角色失败');
}

export async function deleteRoleProfile(id: string): Promise<void> {
  await withToast(del(`${API}/role-profiles/${id}`), '删除角色失败');
}

// ── AgentRoom 全局设置（目前只含 aux_model）──
//
// 全局默认 aux 模型 —— 所有房间未设置自己 auxModel 时 fallback 到这里。
// UI 在 RoomSettingsModal 的"全局默认"区维护。

export interface AgentRoomSettings {
  auxModel: string; // "" = 未设置（走成员主模型）
}

export async function getAgentRoomSettings(): Promise<AgentRoomSettings> {
  try {
    return await get<AgentRoomSettings>(`${API}/settings`);
  } catch {
    return { auxModel: '' };
  }
}

export async function updateAgentRoomSettings(patch: Partial<AgentRoomSettings>): Promise<AgentRoomSettings> {
  return await withToast(
    putReq<AgentRoomSettings>(`${API}/settings`, { auxModel: patch.auxModel ?? '' }),
    '保存全局设置失败',
  );
}

// 不再维护硬编码 fallback：用户只应该看到真实已配置的模型，
// 否则选了个网关上根本没有的型号，agent 会返回空回复而用户不知为何。
// gateway 不可用时返回空列表，UI 侧渲染「无可用模型，请检查网关」。
const FALLBACK_MODELS: string[] = [];

// 向后兼容：旧代码 import SUGGESTED_MODELS 仍可用（始终为空数组）
export const SUGGESTED_MODELS = FALLBACK_MODELS;

export interface SystemModel {
  // v0.4：id 统一为 "provider/model" 格式（与 OpenClaw sessions.patch 接收的 model 字段一致）。
  id: string;          // e.g. "metapi/gpt-5.4"
  label: string;       // e.g. "metapi / gpt-5.4"
  provider?: string;   // e.g. "metapi"
  modelName?: string;  // e.g. "gpt-5.4"（不带 provider 前缀，用于紧凑展示）
}

let _cachedModels: SystemModel[] | null = null;
let _cacheTs = 0;
const MODEL_CACHE_TTL = 30_000; // 30s

// v0.4：对齐 Sessions.tsx —— 从 OpenClaw `config.get` 读 models.providers，
// 展开所有 provider × model 对为 `provider/model` 格式。
// 这是 OpenClaw sessions.patch 接受的标准 model 字段格式。
export async function fetchSystemModels(force = false): Promise<SystemModel[]> {
  const now = Date.now();
  if (!force && _cachedModels && now - _cacheTs < MODEL_CACHE_TTL) return _cachedModels;
  try {
    const cfg: any = await gwApi.configGet();
    const providers =
      cfg?.models?.providers ||
      cfg?.parsed?.models?.providers ||
      cfg?.config?.models?.providers ||
      {};
    const out: SystemModel[] = [];
    const seen = new Set<string>();
    for (const [pName, pCfgRaw] of Object.entries(providers) as [string, any][]) {
      const pModels = Array.isArray(pCfgRaw?.models) ? pCfgRaw.models : [];
      for (const m of pModels) {
        const id = typeof m === 'string' ? m : m?.id;
        if (!id) continue;
        const path = `${pName}/${id}`;
        if (seen.has(path)) continue;
        seen.add(path);
        const displayName = typeof m === 'object' && m?.name ? m.name : id;
        out.push({
          id: path,
          label: `${pName} / ${displayName}`,
          provider: pName,
          modelName: id,
        });
      }
    }
    if (out.length > 0) {
      _cachedModels = out;
      _cacheTs = now;
      return out;
    }
  } catch { /* ignore, fall through to empty list */ }
  // gateway 不可用 / 未返回模型：返回空。调用方应展示「无可用模型，请检查网关」。
  return [];
}

// v0.9：彻底删除前端的"工具配置"概念 — SUGGESTED_TOOLS 常量、
// Member.tools / RoleProfile.tools / CustomMemberSpec.tools 字段、UI 展示/编辑全部拿掉。
// 原因：前端从未接入 OpenClaw gateway 的工具路由 — gateway 端工具的启用/鉴权
// 走独立通道，前端列的 web_search / code_execute 这类 id 只是 UI 占位。保留仅误导用户。

// 推荐 emoji（首字快选）
export const SUGGESTED_EMOJIS = ['🧠','💡','🎨','⚙️','🔍','📊','✍️','🗣️','🎯','🛡️','🚀','🌟','🔥','💼','📝','🎓','👨‍💻','🦉','🐢','🦊','🐉','🤖'];

export async function updateRoom(id: string, patch: Partial<Room>): Promise<Room> {
  return await withToast(putReq<Room>(`${API}/rooms/${encodeURIComponent(id)}`, patch), '更新房间失败');
}

export async function setRoomState(id: string, state: RoomState): Promise<Room> {
  return updateRoom(id, { state });
}

export async function setRoomPolicy(id: string, policy: RoomPolicy): Promise<Room> {
  return updateRoom(id, { policy });
}

export async function deleteRoom(id: string): Promise<void> {
  await withToast(del(`${API}/rooms/${encodeURIComponent(id)}`), '删除房间失败');
}

export async function forkRoom(sourceId: string, fromMessageId: string, resetPolicy?: boolean): Promise<Room> {
  return await withToast(post<Room>(`${API}/rooms/${encodeURIComponent(sourceId)}/fork`, { fromMessageId, ...(resetPolicy ? { resetPolicy: true } : {}) }), '分支房间失败');
}

// ── 成员 ──

export async function listMembers(roomId: string): Promise<Member[]> {
  return await get<Member[]>(`${API}/rooms/${encodeURIComponent(roomId)}/members`);
}

async function memberAction(memberId: string, action: 'kick' | 'unkick' | 'mute' | 'unmute') {
  await withToast(post(`${API}/members/${encodeURIComponent(memberId)}/action`, { action }), '成员操作失败');
}

export async function kickMember(_roomId: string, memberId: string) {
  await memberAction(memberId, 'kick');
}

// v0.8：将"离席"的成员请回 —— 与 kickMember 对偶。本质上是 unkick action。
// 命名"inviteBack"更贴近 UI 语义（"邀回"按钮）；房间数据不受影响，只恢复发言权。
export async function inviteBackMember(_roomId: string, memberId: string) {
  await memberAction(memberId, 'unkick');
}

export async function toggleMute(roomId: string, memberId: string) {
  // 先查当前状态再决定 mute/unmute（乐观：若不在缓存，默认 mute）
  try {
    const list = await listMembers(roomId);
    const cur = list.find(m => m.id === memberId);
    await memberAction(memberId, cur?.isMuted ? 'unmute' : 'mute');
  } catch {
    await memberAction(memberId, 'mute');
  }
}

export async function updateMember(_roomId: string, _memberId: string, _patch: Partial<Member>) {
  // 通用 patch 暂不开放；用专门 action（kick/mute/set_model）代替。保留签名以免老组件编译失败。
  return;
}

export async function updateMemberModel(memberId: string, model: string) {
  await withToast(
    post(`${API}/members/${encodeURIComponent(memberId)}/action`, { action: 'set_model', model }),
    '修改模型失败',
  );
}

// v0.4：切换成员绑定的 OpenClaw agent（会切换底层 session key —— 旧 session 被 OpenClaw gc 回收）。
export async function updateMemberAgent(memberId: string, agentId: string) {
  await withToast(
    post(`${API}/members/${encodeURIComponent(memberId)}/action`, { action: 'set_agent', agentId }),
    '切换 agent 失败',
  );
}

// v0.4：调整成员思考强度（off|low|medium|high；空字符串 = 恢复 agent 默认）。
export async function updateMemberThinking(memberId: string, thinking: string) {
  await withToast(
    post(`${API}/members/${encodeURIComponent(memberId)}/action`, { action: 'set_thinking', thinking }),
    '修改 thinking 失败',
  );
}

// v0.8：仅清理房间的 OpenClaw gateway session，不删 DB 任何数据。
// 适用于"关闭会议"后一段时间确认不再续轮，想回收 gateway 侧资源但保留本地会议记录。
// 返回 { status: 'ok', purged: number }。
export async function purgeRoomSessions(roomId: string): Promise<{ status: string; purged: number }> {
  return await withToast(
    post(`${API}/rooms/${encodeURIComponent(roomId)}/purge-sessions`, {}),
    '清理 AI 会话失败',
  );
}

// v0.8：编辑成员角色 SystemPrompt。空字符串 = 清空（后端回退到模板/默认提示词）。
// 后端会同步 patch OpenClaw session，下一轮发言立刻生效。
export async function updateMemberSystemPrompt(memberId: string, systemPrompt: string) {
  await withToast(
    post(`${API}/members/${encodeURIComponent(memberId)}/action`, { action: 'set_system_prompt', systemPrompt }),
    '修改系统提示词失败',
  );
}

// 动态添加成员到已有房间
export interface AddMemberParams {
  role: string;
  emoji?: string;
  model?: string;
  agentId?: string;
  thinking?: string;
  systemPrompt?: string;
  isModerator?: boolean;
  stance?: string;
  roleProfileId?: string;
}
export async function addMember(roomId: string, params: AddMemberParams): Promise<Member> {
  return await withToast(
    post(`${API}/rooms/${encodeURIComponent(roomId)}/members`, params),
    '添加成员失败',
  );
}

// 真删除成员（cascade=true 同时删除该成员的消息；cascade=false 仅删成员保留消息）
export async function removeMember(memberId: string, cascade: boolean): Promise<void> {
  await withToast(
    del(`${API}/members/${encodeURIComponent(memberId)}?cascade=${cascade}`),
    '删除成员失败',
  );
}

// ── 消息 ──

export async function listMessages(roomId: string): Promise<Message[]> {
  return await get<Message[]>(`${API}/rooms/${encodeURIComponent(roomId)}/messages`);
}

export async function postUserMessage(roomId: string, authorId: string, content: string, opts?: {
  mentionIds?: string[];
  actingAsId?: string;
  referenceMessageId?: string;
  whisperTargetIds?: string[];
  idempotencyKey?: string;
  // v0.9.1：图片附件（data URL 剥掉 prefix 后的纯 base64）。Composer 读文件后填充。
  // 走同一条 POST /messages，由后端存 DB 并转发给 OpenClaw agent RPC 的 attachments 参数。
  attachments?: import('./types').MessageAttachment[];
}): Promise<Message> {
  // 自动生成 idempotency key 用于防止网络重试产生重复消息
  const idem = opts?.idempotencyKey || (`ck_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
  await withToast(post(`${API}/rooms/${encodeURIComponent(roomId)}/messages`, {
    authorId,
    content,
    attachments: opts?.attachments,
    mentionIds: opts?.mentionIds,
    actingAsId: opts?.actingAsId,
    referenceMessageId: opts?.referenceMessageId,
    whisperTargetIds: opts?.whisperTargetIds,
    idempotencyKey: idem,
  }), '发送消息失败');
  // 服务端真正的 Message 通过 WS 'message.append' 推回；返回一个占位对象让调用方能继续。
  // 占位 id / idempotencyKey 都带上同一个 idem，让 useRoom 收到真实消息时能去重。
  return {
    id: '__pending_' + idem,
    roomId,
    authorId,
    actingAsId: opts?.actingAsId,
    kind: opts?.whisperTargetIds?.length ? 'whisper' : 'chat',
    content,
    attachments: opts?.attachments,
    mentionIds: opts?.mentionIds,
    whisperTargetIds: opts?.whisperTargetIds,
    referenceMessageId: opts?.referenceMessageId,
    timestamp: Date.now(),
    idempotencyKey: idem,
  };
}

// exportRoom 让浏览器下载房间的 markdown / json 备份。format 默认 markdown。
export async function exportRoom(roomId: string, format: 'markdown' | 'json' = 'markdown'): Promise<void> {
  const url = `${API}/rooms/${encodeURIComponent(roomId)}/export?format=${format}`;
  // 直接走浏览器下载，不经 fetch（走 Cookie 鉴权）
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// listAudits 返回房间审计流水。
export async function listAudits(roomId: string): Promise<Array<{
  id: number; roomId: string; userId: number; action: string; targetId: string; detail: string; ip: string; createdAt: string;
}>> {
  return await get(`${API}/rooms/${encodeURIComponent(roomId)}/audits`);
}

// ── RAG（Room Memory）──

export interface RoomDoc {
  id: string;
  roomId: string;
  title: string;
  sizeBytes: number;
  chunkCount: number;
  mime: string;
  uploaderId: number;
  createdAt: string;
}

export async function listRoomDocs(roomId: string): Promise<RoomDoc[]> {
  return await get<RoomDoc[]>(`${API}/rooms/${encodeURIComponent(roomId)}/docs`);
}

// uploadRoomDoc 通过 multipart 上传 .md / .txt；失败走 withToast。
export async function uploadRoomDoc(roomId: string, file: File, title?: string): Promise<RoomDoc> {
  const fd = new FormData();
  fd.append('file', file);
  if (title && title.trim()) fd.append('title', title.trim());
  return await withToast(
    fetch(`${API}/rooms/${encodeURIComponent(roomId)}/docs`, {
      method: 'POST',
      body: fd,
      credentials: 'include',
    }).then(async resp => {
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json?.ok) {
        const err = { code: json?.error_code, message: json?.message || '上传失败' };
        return Promise.reject(err);
      }
      return json.data as RoomDoc;
    }),
    '上传失败',
  );
}

export async function deleteRoomDoc(roomId: string, docId: string): Promise<void> {
  await withToast(
    del(`${API}/rooms/${encodeURIComponent(roomId)}/docs/${encodeURIComponent(docId)}`),
    '删除资料失败',
  );
}

// searchMessages FTS5 搜索。空查询返回空数组。
export async function searchMessages(roomId: string, query: string, limit = 50): Promise<Message[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const url = `${API}/rooms/${encodeURIComponent(roomId)}/search?q=${encodeURIComponent(q)}&limit=${limit}`;
  return await get<Message[]>(url);
}

// loadMessagesBefore 向上翻页加载历史。beforeSeq 指定游标，空则加载最新。
export async function loadMessagesBefore(roomId: string, beforeSeq: number, limit = 100): Promise<Message[]> {
  const url = `${API}/rooms/${encodeURIComponent(roomId)}/messages?before=${beforeSeq}&limit=${limit}&paged=1`;
  return await get<Message[]>(url);
}

export async function editMessage(_roomId: string, messageId: string, newContent: string) {
  await withToast(putReq(`${API}/messages/${encodeURIComponent(messageId)}`, { content: newContent }), '编辑消息失败');
}

export async function deleteMessage(_roomId: string, messageId: string) {
  await withToast(del(`${API}/messages/${encodeURIComponent(messageId)}`), '删除消息失败');
}

export async function reactMessage(_roomId: string, messageId: string, emoji: string, memberId: string) {
  await post(`${API}/messages/${encodeURIComponent(messageId)}/react`, { emoji, memberId });
}

// ── Room Memory / Tasks / Whiteboard ──

export async function upsertFact(roomId: string, fact: RoomFact) {
  await post(`${API}/rooms/${encodeURIComponent(roomId)}/facts`, {
    key: fact.key, value: fact.value, authorId: fact.authorId,
  });
}

export async function deleteFact(roomId: string, key: string) {
  await del(`${API}/rooms/${encodeURIComponent(roomId)}/facts/${encodeURIComponent(key)}`);
}

export async function setWhiteboard(roomId: string, content: string) {
  await updateRoom(roomId, { whiteboard: content });
}

export async function setCollaborationStyle(roomId: string, content: string) {
  await updateRoom(roomId, { collaborationStyle: content } as Partial<Room>);
}

// 安全开关 —— 两个都支持独立切换；后端通过 UpdateRoom 接受 readonly / mutationDryRun 字段。
export async function setRoomSafety(roomId: string, patch: { readonly?: boolean; mutationDryRun?: boolean }) {
  await updateRoom(roomId, patch as Partial<Room>);
}

// ── Planned 执行编排 ──

export async function setExecutionQueue(roomId: string, queue: string[]): Promise<void> {
  await withToast(
    post<{ status: string }>(`${API}/rooms/${encodeURIComponent(roomId)}/execution/queue`, { queue }),
    '保存执行队列失败',
  );
}

export async function startExecution(roomId: string): Promise<void> {
  await withToast(
    post<{ status: string }>(`${API}/rooms/${encodeURIComponent(roomId)}/execution/start`, {}),
    '启动执行失败',
  );
}

export async function continueDiscussion(roomId: string): Promise<void> {
  await withToast(
    post<{ status: string }>(`${API}/rooms/${encodeURIComponent(roomId)}/execution/continue`, {}),
    '切换到讨论失败',
  );
}

// ── v0.6 协作质量 / 决策 / Artifact / Playbook / Persona Memory ──

import type { Artifact, Playbook, PersonaMemory } from './types';

// 房间级质量字段（一次性 patch）
export async function setRoomQuality(roomId: string, patch: {
  goal?: string; roundBudget?: number; selfCritique?: boolean; constitution?: string;
}) {
  await updateRoom(roomId, patch as Partial<Room>);
}

// 决策锚
export async function promoteDecision(messageId: string, summary?: string): Promise<void> {
  await withToast(
    post<{ status: string }>(`${API}/messages/${encodeURIComponent(messageId)}/promote-decision`,
      { summary: summary ?? '' }),
    '推为决策失败',
  );
}
export async function demoteDecision(messageId: string): Promise<void> {
  await withToast(
    del<{ status: string }>(`${API}/messages/${encodeURIComponent(messageId)}/promote-decision`),
    '撤销决策失败',
  );
}
export async function listDecisions(roomId: string): Promise<Message[]> {
  return await get<Message[]>(`${API}/rooms/${encodeURIComponent(roomId)}/decisions`);
}

// Artifact CRUD
export async function listArtifacts(roomId: string): Promise<Artifact[]> {
  return await get<Artifact[]>(`${API}/rooms/${encodeURIComponent(roomId)}/artifacts`);
}
export async function createArtifact(roomId: string, a: Pick<Artifact, 'title' | 'kind' | 'content'> & { language?: string }): Promise<Artifact> {
  return await withToast(post<Artifact>(`${API}/rooms/${encodeURIComponent(roomId)}/artifacts`, a), '创建 Artifact 失败');
}
export async function updateArtifact(artifactId: string, patch: Partial<Pick<Artifact, 'title' | 'kind' | 'language' | 'content'>>): Promise<Artifact> {
  return await withToast(putReq<Artifact>(`${API}/artifacts/${encodeURIComponent(artifactId)}`, patch), '更新 Artifact 失败');
}
export async function deleteArtifact(artifactId: string): Promise<void> {
  await withToast(del(`${API}/artifacts/${encodeURIComponent(artifactId)}`), '删除 Artifact 失败');
}

// 会议纪要 / extract-todo / rerun / ask-all
export async function synthesizeMinutes(roomId: string, template: 'minutes' | 'prd' | 'adr' | 'review' = 'minutes', close = false): Promise<{ artifactId: string; messageId: string }> {
  return await withToast(
    post<{ artifactId: string; messageId: string }>(`${API}/rooms/${encodeURIComponent(roomId)}/close/synthesize`, { template, close }),
    '生成纪要失败',
  );
}
export async function extractTodo(roomId: string): Promise<{ tasks: RoomTask[] }> {
  return await withToast(
    post<{ tasks: RoomTask[] }>(`${API}/rooms/${encodeURIComponent(roomId)}/extract-todo`, {}),
    '提取 todo 失败',
  );
}
// v0.9：按钮一键抽取。后端从最近 60 条消息里挑出开放问题 / 风险，批量写库并
// 广播 room.question.append / room.risk.append —— QuestionsPanel / RisksPanel
// 已订阅这些事件会实时刷新，右栏折叠状态下未读绿点也会亮起。
export async function extractQuestions(roomId: string): Promise<{ questions: OpenQuestion[] }> {
  return await withToast(
    post<{ questions: OpenQuestion[] }>(`${API}/rooms/${encodeURIComponent(roomId)}/extract-questions`, {}),
    '抽取未决问题失败',
  );
}
export async function extractRisks(roomId: string): Promise<{ risks: Risk[] }> {
  return await withToast(
    post<{ risks: Risk[] }>(`${API}/rooms/${encodeURIComponent(roomId)}/extract-risks`, {}),
    '抽取风险失败',
  );
}
export async function rerunMessage(messageId: string, model?: string): Promise<{ newMessageId: string }> {
  return await withToast(
    post<{ newMessageId: string }>(`${API}/messages/${encodeURIComponent(messageId)}/rerun`, { model }),
    '重跑失败',
  );
}
export async function askAll(roomId: string, question: string): Promise<void> {
  await withToast(
    post<{ status: string }>(`${API}/rooms/${encodeURIComponent(roomId)}/ask-all`, { question }),
    '群询失败',
  );
}

// Persona Memory
export async function getPersonaMemory(key: string): Promise<PersonaMemory> {
  return await get<PersonaMemory>(`${API}/persona-memory/${encodeURIComponent(key)}`);
}
export async function upsertPersonaMemory(key: string, content: string, append = false): Promise<PersonaMemory> {
  return await withToast(
    putReq<PersonaMemory>(`${API}/persona-memory/${encodeURIComponent(key)}`, { content, append }),
    '保存长期记忆失败',
  );
}
export async function deletePersonaMemory(key: string): Promise<void> {
  await withToast(del(`${API}/persona-memory/${encodeURIComponent(key)}`), '删除长期记忆失败');
}
export async function listPersonaMemories(): Promise<PersonaMemory[]> {
  return await get<PersonaMemory[]>(`${API}/persona-memory`);
}

// Playbook
export async function listPlaybooks(): Promise<Playbook[]> {
  return await get<Playbook[]>(`${API}/playbooks`);
}
export async function createPlaybook(p: Partial<Playbook> & { fromRoomId?: string }): Promise<Playbook> {
  return await withToast(post<Playbook>(`${API}/playbooks`, p), '创建 Playbook 失败');
}
export async function deletePlaybook(id: string): Promise<void> {
  await withToast(del(`${API}/playbooks/${encodeURIComponent(id)}`), '删除 Playbook 失败');
}

// 应用 Playbook 到当前房间：把 4 段内容作为 summary 消息注入
export async function applyPlaybookToRoom(roomId: string, playbookId: string): Promise<{ messageId: string }> {
  return await withToast(
    post<{ messageId: string }>(
      `${API}/rooms/${encodeURIComponent(roomId)}/playbooks/${encodeURIComponent(playbookId)}/apply`,
      {},
    ),
    '应用 Playbook 失败',
  );
}

export async function addTask(roomId: string, task: Omit<RoomTask, 'id' | 'createdAt'>) {
  return await post<RoomTask>(`${API}/rooms/${encodeURIComponent(roomId)}/tasks`, {
    text: task.text,
    assigneeId: task.assigneeId,
    creatorId: task.creatorId,
    status: task.status,
    dueAt: task.dueAt,
  });
}

export async function updateTask(_roomId: string, taskId: string, patch: Partial<RoomTask>) {
  await putReq(`${API}/tasks/${encodeURIComponent(taskId)}`, {
    status: patch.status,
    text: patch.text,
    assigneeId: patch.assigneeId,
  });
}

// ── 投影 ──

export async function setProjection(roomId: string, projection: RoomProjection) {
  return updateRoom(roomId, { projection });
}

export async function addProjectionTarget(roomId: string, target: ProjectionTarget) {
  const r = await getRoom(roomId);
  if (!r) return;
  const cur = r.projection || { enabled: false, targets: [], inboundEnabled: false };
  cur.targets.push(target);
  return setProjection(roomId, cur);
}

// ── 行为指标 / 干预 ──

export async function getMetrics(roomId: string): Promise<RoomMetrics | null> {
  try {
    return await get<RoomMetrics>(`${API}/rooms/${encodeURIComponent(roomId)}/metrics`);
  } catch {
    return null;
  }
}

export async function listInterventions(roomId: string): Promise<InterventionEvent[]> {
  return await get<InterventionEvent[]>(`${API}/rooms/${encodeURIComponent(roomId)}/interventions`);
}

export async function recordIntervention(_ev: InterventionEvent) {
  // 干预事件由服务端在 force-next / emergency-stop 等动作中自动记录；此函数保留签名。
  return;
}

// ── 紧急刹车 ──

export async function emergencyStop(roomId: string, reason?: string) {
  await withToast(post(`${API}/rooms/${encodeURIComponent(roomId)}/emergency-stop`, { reason }), '紧急停止失败');
}

// v0.8 Nudge：让会议自然续跑一轮（"继续会议"按钮 + /continue 命令）。
// 后端插入一条 human:nudge chat 消息 → 重置 MaxConsecutive 计数 → 触发下一轮。
// paused 状态下也会自动 resume 到 active。
export async function nudgeRoom(roomId: string, text?: string) {
  await withToast(post(`${API}/rooms/${encodeURIComponent(roomId)}/nudge`, { text: text || '' }), '继续会议失败');
}

// ── 发言控制 ──

export async function forceNextSpeaker(roomId: string, memberId: string) {
  await withToast(post(`${API}/rooms/${encodeURIComponent(roomId)}/force-next`, { memberId }), '指定发言者失败');
}

// ── v0.4：OpenClaw Gateway 桥接代理 ──

/**
 * 从 OpenClaw Gateway 拉取 agents.list（Member 编辑器下拉数据源）。
 * 当 Gateway 未连接时服务端返回 503，调用方会 toast 提示并回退到"default" agent。
 */
export async function listGatewayAgents(): Promise<GatewayAgentInfo[]> {
  try {
    const res = await get<{ agents: GatewayAgentInfo[] }>(`${API}/gateway/agents`);
    return Array.isArray(res?.agents) ? res.agents : [];
  } catch {
    return [];
  }
}

/** 查询 OpenClaw Gateway 桥接是否就绪（房间向导检测用）。 */
export async function getGatewayStatus(): Promise<GatewayStatus> {
  try {
    return await get<GatewayStatus>(`${API}/gateway/status`);
  } catch {
    return { available: false };
  }
}

// ══════════════════════════════════════════════════════════
// v0.7 真实会议环节 API
// ══════════════════════════════════════════════════════════

// ── Agenda ──

export async function listAgenda(roomId: string): Promise<AgendaItem[]> {
  try {
    return await get<AgendaItem[]>(`${API}/rooms/${encodeURIComponent(roomId)}/agenda`);
  } catch {
    return [];
  }
}

export async function createAgendaItem(roomId: string, item: {
  title: string;
  description?: string;
  targetOutcome?: string;
  policy?: string;
  roundBudget?: number;
  assigneeIds?: string[];
}): Promise<AgendaItem> {
  return await withToast(
    post<AgendaItem>(`${API}/rooms/${encodeURIComponent(roomId)}/agenda`, item),
    '添加议程失败',
  );
}

export async function updateAgendaItem(itemId: string, patch: {
  title?: string;
  description?: string;
  targetOutcome?: string;
  policy?: string;
  roundBudget?: number;
  assigneeIds?: string[];
}): Promise<AgendaItem> {
  return await withToast(
    putReq<AgendaItem>(`${API}/agenda-items/${encodeURIComponent(itemId)}`, patch),
    '更新议程失败',
  );
}

export async function deleteAgendaItem(itemId: string): Promise<void> {
  await withToast(del(`${API}/agenda-items/${encodeURIComponent(itemId)}`), '删除议程失败');
}

export async function parkAgendaItem(itemId: string): Promise<void> {
  await withToast(
    post(`${API}/agenda-items/${encodeURIComponent(itemId)}/park`, {}),
    '挂起议程失败',
  );
}

export async function advanceAgenda(roomId: string): Promise<{ nextItemId: string }> {
  return await withToast(
    post<{ nextItemId: string }>(`${API}/rooms/${encodeURIComponent(roomId)}/agenda/advance`, {}),
    '推进议程失败',
  );
}

export async function reorderAgenda(roomId: string, orderedIds: string[]): Promise<void> {
  await withToast(
    post(`${API}/rooms/${encodeURIComponent(roomId)}/agenda/reorder`, { orderedIds }),
    '重排议程失败',
  );
}

// ── OpenQuestion ──

export async function listQuestions(roomId: string): Promise<OpenQuestion[]> {
  try {
    return await get<OpenQuestion[]>(`${API}/rooms/${encodeURIComponent(roomId)}/questions`);
  } catch {
    return [];
  }
}

export async function createQuestion(roomId: string, text: string, opts?: {
  agendaItemId?: string;
  raisedById?: string;
}): Promise<OpenQuestion> {
  return await withToast(
    post<OpenQuestion>(`${API}/rooms/${encodeURIComponent(roomId)}/questions`, {
      text, agendaItemId: opts?.agendaItemId, raisedById: opts?.raisedById,
    }),
    '添加问题失败',
  );
}

export async function updateQuestion(qid: string, patch: {
  text?: string;
  status?: OpenQuestion['status'];
  answerMessageId?: string;
  answerText?: string;
}): Promise<OpenQuestion> {
  return await withToast(
    putReq<OpenQuestion>(`${API}/questions/${encodeURIComponent(qid)}`, patch),
    '更新问题失败',
  );
}

export async function deleteQuestion(qid: string): Promise<void> {
  await withToast(del(`${API}/questions/${encodeURIComponent(qid)}`), '删除问题失败');
}

// ── ParkingLot ──

export async function listParking(roomId: string): Promise<ParkingLotItem[]> {
  try {
    return await get<ParkingLotItem[]>(`${API}/rooms/${encodeURIComponent(roomId)}/parking`);
  } catch {
    return [];
  }
}

export async function createParkingItem(roomId: string, text: string, raisedById?: string): Promise<ParkingLotItem> {
  return await withToast(
    post<ParkingLotItem>(`${API}/rooms/${encodeURIComponent(roomId)}/parking`, { text, raisedById }),
    '加入 parking lot 失败',
  );
}

export async function updateParkingItem(pid: string, patch: { text?: string; resolution?: ParkingLotItem['resolution'] }): Promise<ParkingLotItem> {
  return await withToast(
    putReq<ParkingLotItem>(`${API}/parking/${encodeURIComponent(pid)}`, patch),
    '更新 parking 失败',
  );
}

export async function deleteParkingItem(pid: string): Promise<void> {
  await withToast(del(`${API}/parking/${encodeURIComponent(pid)}`), '删除 parking 失败');
}

// ── Risk ──

export async function listRisks(roomId: string): Promise<Risk[]> {
  try {
    return await get<Risk[]>(`${API}/rooms/${encodeURIComponent(roomId)}/risks`);
  } catch {
    return [];
  }
}

export async function createRisk(roomId: string, risk: {
  text: string;
  severity?: Risk['severity'];
  ownerId?: string;
}): Promise<Risk> {
  return await withToast(
    post<Risk>(`${API}/rooms/${encodeURIComponent(roomId)}/risks`, risk),
    '添加风险失败',
  );
}

export async function updateRisk(rid: string, patch: {
  text?: string;
  severity?: Risk['severity'];
  ownerId?: string;
  status?: Risk['status'];
}): Promise<Risk> {
  return await withToast(
    putReq<Risk>(`${API}/risks/${encodeURIComponent(rid)}`, patch),
    '更新风险失败',
  );
}

export async function deleteRisk(rid: string): Promise<void> {
  await withToast(del(`${API}/risks/${encodeURIComponent(rid)}`), '删除风险失败');
}

// ── Vote ──

export async function listVotes(roomId: string): Promise<Vote[]> {
  try {
    return await get<Vote[]>(`${API}/rooms/${encodeURIComponent(roomId)}/votes`);
  } catch {
    return [];
  }
}

export async function createVote(roomId: string, vote: {
  question: string;
  options: string[];
  mode?: VoteMode;
  voterIds?: string[];
  agendaItemId?: string;
}): Promise<Vote> {
  return await withToast(
    post<Vote>(`${API}/rooms/${encodeURIComponent(roomId)}/votes`, vote),
    '创建投票失败',
  );
}

export async function castBallot(voteId: string, choice: string, rationale?: string, voterId?: string): Promise<{ ballots: number }> {
  return await withToast(
    post<{ ballots: number }>(`${API}/votes/${encodeURIComponent(voteId)}/ballot`, {
      choice, rationale, voterId,
    }),
    '投票失败',
  );
}

export async function tallyVote(voteId: string): Promise<Vote> {
  return await withToast(
    post<Vote>(`${API}/votes/${encodeURIComponent(voteId)}/tally`, {}),
    '计票失败',
  );
}

export async function deleteVote(voteId: string): Promise<void> {
  await withToast(del(`${API}/votes/${encodeURIComponent(voteId)}`), '删除投票失败');
}

// ── Closeout / Outcome ──

export async function runCloseout(roomId: string, closeRoom = true): Promise<CloseoutResult> {
  return await withToast(
    post<CloseoutResult>(`${API}/rooms/${encodeURIComponent(roomId)}/closeout`, { closeRoom }),
    '关闭仪式失败',
  );
}

/**
 * cancelCloseout —— 打断正在跑的 Closeout 流水线。
 * 幂等：没有在跑时也返回 ok。服务端会通过 WS 广播剩余步骤的 skipped 事件，
 * 前端监听 room.closeout.step 即可实时更新；调用此 API 不需要等响应。
 */
export async function cancelCloseout(roomId: string): Promise<{ status: string }> {
  return await post<{ status: string }>(`${API}/rooms/${encodeURIComponent(roomId)}/closeout/cancel`, {});
}

/**
 * closeRoomOnly —— v0.9.1：仅把房间切换到 closed 状态，不跑 Closeout 流水线。
 * 适用于已经手动整理过纪要 / 不需要 AI 总结的场景，省下几秒到一两分钟的 LLM 调用 + 费用。
 * 不产出 minutes / todos / playbook / retro / bundle；DeliverInterRoomBus 也不会触发。
 */
export async function closeRoomOnly(roomId: string): Promise<{ status: string }> {
  return await withToast(
    post<{ status: string }>(`${API}/rooms/${encodeURIComponent(roomId)}/close`, {}),
    '关闭会议失败',
  );
}

/**
 * reopenRoom —— v0.9.1：把 closed 房间重新开启到 paused 状态。
 * 只允许在 closed 态下调用；其它状态后端会返回 REOPEN_FAILED。
 * 产出物（纪要/Todo/Playbook/复盘）保留，供继续会议时参考。
 */
export async function reopenRoom(roomId: string): Promise<{ status: string }> {
  return await withToast(
    post<{ status: string }>(`${API}/rooms/${encodeURIComponent(roomId)}/reopen`, {}),
    '重启会议失败',
  );
}

export async function getOutcome(roomId: string): Promise<{
  hasBundle: boolean;
  bundleArtifactId?: string;
  bundle?: { id: string; title: string; content: string; updatedAt: number };
  retro?: Retro;
}> {
  return await get(`${API}/rooms/${encodeURIComponent(roomId)}/outcome`);
}

// ── Retro ──

export async function getRetro(roomId: string): Promise<Retro | null> {
  try {
    return await get<Retro | null>(`${API}/rooms/${encodeURIComponent(roomId)}/retro`);
  } catch {
    return null;
  }
}

export async function updateRetro(roomId: string, patch: Partial<Retro>): Promise<Retro> {
  return await withToast(
    putReq<Retro>(`${API}/rooms/${encodeURIComponent(roomId)}/retro`, patch),
    '更新复盘失败',
  );
}

export async function regenerateRetro(roomId: string): Promise<Retro> {
  return await withToast(
    post<Retro>(`${API}/rooms/${encodeURIComponent(roomId)}/retro/regenerate`, {}),
    '重新生成复盘失败',
  );
}

export async function listAllRetros(): Promise<Retro[]> {
  try {
    return await get<Retro[]>(`${API}/retros`);
  } catch {
    return [];
  }
}

// ── Playbook V7 ──

export async function listPlaybooksV7(): Promise<PlaybookV7[]> {
  try {
    return await get<PlaybookV7[]>(`${API}/playbooks`);
  } catch {
    return [];
  }
}

export async function getPlaybookV7(id: string): Promise<PlaybookV7 | null> {
  try {
    return await get<PlaybookV7>(`${API}/playbooks/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

export async function updatePlaybookV7(id: string, patch: Partial<PlaybookV7> & { steps?: PlaybookStep[] }): Promise<PlaybookV7> {
  return await withToast(
    putReq<PlaybookV7>(`${API}/playbooks/${encodeURIComponent(id)}`, patch),
    '保存 Playbook 失败',
  );
}

export async function searchPlaybooks(q: string, limit = 50): Promise<PlaybookV7[]> {
  try {
    return await get<PlaybookV7[]>(`${API}/playbooks/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  } catch {
    return [];
  }
}

export async function recommendPlaybooks(goal: string, templateId?: string): Promise<PlaybookV7[]> {
  const qs = new URLSearchParams();
  if (goal) qs.set('goal', goal);
  if (templateId) qs.set('templateId', templateId);
  try {
    return await get<PlaybookV7[]>(`${API}/playbooks/recommend?${qs.toString()}`);
  } catch {
    return [];
  }
}

export async function togglePlaybookFavorite(id: string): Promise<PlaybookV7> {
  return await withToast(
    post<PlaybookV7>(`${API}/playbooks/${encodeURIComponent(id)}/favorite`, {}),
    '收藏失败',
  );
}
