// AgentRoom 核心类型定义
// 遵循 DESIGN.md v0.2 §3 术语表 + §4.4 架构决策
// DeckX 作 Single Source of Truth — 所有类型描述 DeckX 端的权威数据

export type MemberKind = 'agent' | 'human' | 'observer';

export type MemberStatus =
  | 'idle'
  | 'thinking'
  | 'speaking'
  | 'tool_call'
  | 'tool_running'
  | 'tool_waiting_approval'
  | 'muted'
  | 'error'
  | 'offline';

export interface Member {
  id: string;
  roomId: string;
  kind: MemberKind;
  name: string;
  role: string;            // 角色标签，如 "产品经理" / "架构师"
  emoji?: string;           // 头像 emoji（新手友好，避免复杂头像素材）
  avatarColor?: string;     // fallback 色块
  model?: string;           // 例 "claude-opus-4" / "deepseek-v3.5"
  // v0.9：Member.tools 字段删除 — 前端从未真正接入 OpenClaw gateway 的工具路由，
  // gateway 端工具的启用/鉴权走独立通道，前端列的 web_search 等 id 对 agent 实际行为无影响。
  // v0.8 角色系统提示词（可编辑）。空字符串 = 用模板默认。
  systemPrompt?: string;
  tokenUsage: number;       // 本房间累计 token
  // 最近一次 runAgentTurn 的 prompt token 数（近似模型这一轮消化的上下文大小）
  lastPromptTokens?: number;
  // 模型上下文窗口 token 估计；0/缺失 = 未知（UI 隐藏压力条）
  contextLimit?: number;
  costCNY: number;          // 本房间累计 ¥
  status: MemberStatus;
  isModerator?: boolean;
  isMuted?: boolean;
  isKicked?: boolean;
  // v0.7+ 辩论立场 —— pro | con | neutral | ''（未设置）。
  // 与房间 policy=='debate' 联动：scheduler 按 stance 轮转；prompt 中注入角色说明。
  // 在非 debate 房间设置此字段 目前不会触发额外行为（前端保留为"人设提示"）。
  stance?: 'pro' | 'con' | 'neutral' | '';
  // v0.4 (OpenClaw bridge)：
  //   agentId    ── 绑定的上游 OpenClaw agent id（从 gateway agents.list 拉取；默认 "default"）
  //   sessionKey ── agent:<agentId>:agentroom:<roomId>:<memberId>（后端自动生成）
  //   thinking   ── "off" | "low" | "medium" | "high"（空 = 用 agent 默认）
  agentId?: string;
  sessionKey?: string;
  thinking?: string;
  roleProfileId?: string;
  roleProfileMode?: 'builtin' | 'user' | 'template' | 'custom_snapshot';
  createdAt: number;
}

// v0.4 OpenClaw Gateway 代理返回的 agent 目录条目（Member 编辑器下拉数据源）
export interface GatewayAgentInfo {
  id: string;
  name?: string;
  model?: string;
  description?: string;
  isDefault?: boolean;
  toolCount?: number;
  channelCount?: number;
}

// v0.4 Gateway 桥接状态（房间向导检测用）
export interface GatewayStatus {
  available: boolean;
}

export type RoomPolicy =
  | 'free'         // 自由
  | 'reactive'     // 反应式（只 @ 触发）
  | 'roundRobin'   // 轮流
  | 'moderator'    // 主持人
  | 'bidding'      // 竞价发言
  | 'observer'     // 静默观察
  | 'planned'      // 结构化执行（discussion → executing → review）
  | 'parallel'     // v0.7+ 并行 fanout：一次触发 → N 个 agent 同时独立回复
  | 'debate';      // v0.7+ 辩论：按成员 stance 轮转 pro → con → pro …

// ── v0.7+ 房间调参（对应后端 agentroom.PolicyOptions） ──
//
// 所有字段都是可选 + "0/空 = 用默认"。RoomTuningModal 上每个控件都对应其中一项。
// 前端"恢复默认"按钮 = 把对应字段删掉（undefined），而非传 0。
export interface PolicyOptions {
  // ── 发言顺序 / 基础 ──
  /** roundRobin 的自定义顺序（成员 id 列表）；空 = 按成员创建顺序 */
  roundRobinOrder?: string[];
  /** 静音踢出秒数（保留字段，目前未启用） */
  silenceKickSec?: number;
  /** reactive 严格模式；true = 不被 @ 绝不发言（包括 bidding 后备） */
  reactiveMentionOnly?: boolean;

  // ── 阈值 / 数值 ──
  /** bidding 策略抢麦阈值；默认 5.0 */
  biddingThreshold?: number;
  /** activeInterjection 抢麦阈值；默认 6.0（比 bidding 高一米） */
  interjectionThreshold?: number;
  /** 一次触发内连续 agent 发言的硬上限；默认 8 */
  maxConsecutive?: number;
  /** parallel 策略的 fanout 数；<=0 = min(3, 活跃 agent 数) */
  parallelFanout?: number;
  /** debate 策略下一次触发跑多少轮对抗；<=0 = min(4, 活跃 agent 数) */
  debateRounds?: number;
  /** debate 是否把 neutral 成员也排进对抗轮次；默认 false */
  includeNeutralInDebate?: boolean;

  // ── 功能开关 ──
  /** free / moderator / reactive 策略下是否叠加主动抢麦（每轮静默 bid + 阈值覆盖） */
  activeInterjection?: boolean;
  /**
   * v0.8 冲突驱动模式。对抗"AI 礼貌点头型会议"。
   *   ''        空 = 不注入（闲聊、接龙等轻量场景默认）
   *   'review'  评审挑战：允许部分同意，但每轮必须带新视角/风险
   *   'debate'  硬对抗：必须带具体反驳/证据/新论点，禁止点头式同意
   * 应用层从 PromptPack.reviewChallenge / conflictDrive 拿实际文案，允许覆盖。
   */
  conflictMode?: '' | 'review' | 'debate';
  meetingStyle?: string;
  relationshipMode?: 'balanced' | 'collaborative' | 'adversarial' | 'review' | 'command' | '';
  relationshipTension?: number;
  moderatorIntervention?: number;
  judgeIntervention?: number;
  consecutivePenalty?: number;
  repetitionPenalty?: number;
  topicStallPenalty?: number;
  topicFatigueThreshold?: number;
  continuationBias?: number;
  interruptionBias?: number;
  closureBias?: number;
  responseLength?: number;
  directness?: number;
  evidenceBias?: number;
  noveltyBias?: number;

  // ── 会议节奏到期行为 ──
  /** 到达 RoundBudget 时的行为：'remind'(默认仅提醒) | 'pause'(强制暂停) | 'summarize'(自动总结后暂停) */
  deadlineAction?: '' | 'remind' | 'pause' | 'summarize';

  // ── 上下文压缩（旧"硬编码常量"） ──
  /** tail 窗口条数上限；默认 20。base token 超过 T1 降到 Med，超过 T2 降到 Small。 */
  contextTailWindow?: number;
  /** 要点回顾最大条数；默认 8 */
  contextHighlightsCap?: number;
  /** 软 token 上限；超过触发硬截；默认 6000 */
  contextTokenSoftLimit?: number;
  /** 硬 rune 上限；超过从头截 2000 runes；默认 14000 */
  contextRuneHardLimit?: number;
  /** earlier 段人类消息"全部保留"的上限；默认 3 */
  contextKeepHumanMaxN?: number;
  /** tail 自适应第一档 token 阈值；默认 1500 */
  contextBasePromoteT1?: number;
  /** tail 自适应第二档 token 阈值；默认 2500 */
  contextBasePromoteT2?: number;
  /** 第一档降到的 tail 窗口；默认 12 */
  contextTailMed?: number;
  /** 第二档降到的 tail 窗口；默认 8 */
  contextTailSmall?: number;

  // ── 人设 / 文案模板 ──
  /** 覆盖默认 system prompt 片段。字段为空字符串 = 该段用默认。整个 prompts=undefined = 全默认。 */
  prompts?: PromptPack;

  // ── preset 标记（只读；应用 preset 时后端回填） ──
  presetId?: string;
}

// v0.7+ PromptPack —— 注入到每轮 system prompt 的文案模板（Go text/template 语法）。
// 每条字段留空 = 用默认。
export interface PromptPack {
  /** debate 正方职责说明（无变量） */
  stancePro?: string;
  /** debate 反方职责说明（无变量） */
  stanceCon?: string;
  /** debate 中立职责说明（无变量） */
  stanceNeutral?: string;
  /** 议程协议块。变量：{{.ActiveIdx}} {{.Total}} {{.AgendaTitle}} {{.TargetOutcome}} {{.HasBudget}} {{.RoundBudget}} {{.RoundsUsed}} */
  agendaProtocol?: string;
  /** agent 接棒提示。变量：{{.PrevAgentName}} {{.PrevAgentSnippet}} */
  relayContinuation?: string;
  /** bidding scorer system prompt。变量：{{.MemberName}} {{.MemberRole}}。必须仍产出 JSON {score,reason}。 */
  biddingScorer?: string;
  /** 抢麦 system notice。变量：{{.Name}} {{.Reason}} */
  interjectionNotice?: string;
  /** 辩论每轮开始提示。变量：{{.Round}} {{.TotalRounds}} */
  debateRoundNotice?: string;
  /** 并行开始提示。变量：{{.Fanout}} */
  parallelStartNotice?: string;
  /** 辩论结束提示（无变量） */
  debateEndNotice?: string;
  /** v0.8 硬对抗模式推动词（无变量），ConflictMode='debate' 时注入到 extraSys 尾部 */
  conflictDrive?: string;
  /** v0.8 评审挑战模式推动词（无变量），ConflictMode='review' 时注入到 extraSys 尾部 */
  reviewChallenge?: string;

  // ── v0.9 结构化副产物 ──
  /** 结构化副产物诱导（无变量）：让 agent 在回复里用 <open_question>/<risk> tag 标注 */
  structuredCapture?: string;

  // ── v1.0 soft-tag / 真实性增强 ──
  /** soft-tag 指令（无变量）：让 agent 在发言末输出 #stance/#novelty/#concrete 等标签 */
  softTagInstruction?: string;
  /** 鼓励说"我不确定"（无变量） */
  uncertaintyEncouragement?: string;
  /** 精细化回应，部分同意部分反对（无变量） */
  partialAgreement?: string;
  /** 允许中途自我修正（无变量） */
  selfCorrection?: string;

  // ── v1.0 协作执行 ──
  /** 并行整合指令。变量：{{.AgentSummaries}} */
  parallelSynthesis?: string;

  // ── v1.0 会议节奏 ──
  /** 阶段提示 · 开场。变量：{{.RoundsUsed}} {{.RoundBudget}} */
  phaseOpening?: string;
  /** 阶段提示 · 深入。变量：{{.RoundsUsed}} {{.RoundBudget}} */
  phaseDeepDive?: string;
  /** 阶段提示 · 疲劳。变量：{{.RoundsUsed}} {{.RoundBudget}} */
  phaseFatigue?: string;
  /** 阶段提示 · 收束。变量：{{.RoundsUsed}} {{.RoundBudget}} */
  phaseConvergence?: string;

  // ── v1.0 情绪连续性 ──
  /** 情绪 · 被支持。变量：{{.Supporters}} {{.Challengers}} {{.Label}} */
  emotionSupported?: string;
  /** 情绪 · 被挑战。变量：{{.Supporters}} {{.Challengers}} {{.Label}} */
  emotionChallenged?: string;
  /** 情绪 · 混合。变量：{{.Supporters}} {{.Challengers}} {{.Label}} */
  emotionMixed?: string;

  // ── v1.0 沉默 / 盲区 ──
  /** 沉默力学提示（无变量） */
  silenceBuildup?: string;
  /** 知识盲区全局后缀（无变量） */
  blindSpotSuffix?: string;

  // ── v1.0 会议健康 D1-D8 ──
  /** D1 僵局干预。变量：{{.NameA}} {{.NameB}} */
  deadlockIntervention?: string;
  /** D2 人类被遗忘。变量：{{.HumanName}} {{.Rounds}} */
  humanForgotten?: string;
  /** D3 篇幅警告（无变量） */
  monopolizerWarning?: string;
  /** D4 情绪降温。变量：{{.Rounds}} */
  escalationCooldown?: string;
  /** D5 共识锁定。变量：{{.Count}} {{.Snippet}} */
  consensusLock?: string;
  /** D6 承诺提醒。变量：{{.Names}} */
  commitmentReminder?: string;
  /** D7 元反思。变量：{{.RoundsUsed}} */
  metaReflection?: string;
  /** D8 提议通知。变量：{{.ProposerName}} */
  proposalNotice?: string;

  // ── v1.0 协作执行 C1-C7 ──
  /** 步骤移交。变量：{{.Step}} {{.Total}} {{.NextName}} {{.PrevSummary}} */
  handoffPrompt?: string;
  /** 能力检查（无变量） */
  capabilityCheck?: string;
  /** 协作标签（无变量） */
  collaborationTags?: string;

  // ── v1.0 氛围个性化 T1-T6 ──
  /** T1 语气指令（无变量） */
  toneDirective?: string;
  /** T2 发言长度引导。变量：{{.Phase}} {{.Policy}} */
  lengthGuidance?: string;
  /** T3 创意激发（无变量） */
  creativityBoost?: string;
  /** T4 群体思维警告。变量：{{.Rounds}} */
  groupthinkAlert?: string;
  /** T5 类比叙事引导（无变量） */
  analogyCue?: string;
  /** T6 话题锚定。变量：{{.Goal}} */
  topicAnchor?: string;

  // ── v1.0 真实世界增强 R1-R6 ──
  /** R1 突破势能。变量：{{.AuthorName}} {{.Snippet}} */
  breakthroughMomentum?: string;
  /** R2 少数派保护。变量：{{.MinorityName}} */
  minorityVoice?: string;
  /** R3 假设追踪。变量：{{.Count}} */
  assumptionChallenge?: string;
  /** R4 决策质量门。变量：{{.MissingItems}} */
  decisionGate?: string;
  /** R5 紧迫感 · 中度。变量：{{.RoundsUsed}} {{.RoundBudget}} {{.Remaining}} */
  urgencyMild?: string;
  /** R5 紧迫感 · 高度。变量：{{.RoundsUsed}} {{.RoundBudget}} {{.Remaining}} */
  urgencyCritical?: string;
  /** R6 复读警告。变量：{{.SpeakerName}} {{.EchoedName}} */
  echoWarning?: string;
}

// v0.7+ Preset —— 后端 /api/v1/agentroom/presets 返回的元数据。
// 前端 RoomTuningModal 第一个 tab 渲染成"预设卡片"供用户一键应用。
export interface PolicyPresetMeta {
  id: string;          // 'chat' | 'deep' | 'debate' | 'brainstorm' | 'planning'
  name: string;
  emoji: string;
  description: string;
  /** 应用后的参数预览，UI 可显示"应用后 biddingThreshold=6.5 ..." */
  preview: PolicyOptions;
}

export interface RoleInteractionProfile {
  relationshipMode?: string;
  preferredTargets?: string[];
  counterTargets?: string[];
  supportTargets?: string[];
  challengeStyle?: string;
  closureStyle?: string;
  notes?: string;
}

export interface RoleProfile {
  id: string;
  ownerUserId?: number;
  slug?: string;
  name: string;
  role: string;
  emoji?: string;
  description?: string;
  category?: string;
  systemPrompt?: string;
  stylePrompt?: string;
  model?: string;
  agentId?: string;
  thinking?: string;
  memoryKey?: string;
  isModerator?: boolean;
  stance?: 'pro' | 'con' | 'neutral' | '';
  interactionProfile?: RoleInteractionProfile;
  builtin?: boolean;
  visibility?: string;
  sortOrder?: number;
  createdAt?: number;
  updatedAt?: number;
}

export type RoomState = 'draft' | 'active' | 'paused' | 'closed' | 'archived';

export interface RoomBudget {
  limitCNY: number;        // 预算硬上限
  usedCNY: number;          // 已消耗
  tokensUsed: number;
  warnAt: number;           // 0-1，默认 0.7
  hardStopAt: number;       // 0-1，默认 1.0
}

export interface Room {
  id: string;
  title: string;
  state: RoomState;
  policy: RoomPolicy;
  strictApproval?: boolean;  // §10.5 严格模式开关
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  budget: RoomBudget;
  memberIds: string[];
  moderatorId?: string;
  facts: RoomFact[];
  whiteboard: string;        // Markdown 内容
  collaborationStyle?: string; // 房间级协作风格（注入每一轮 system prompt）
  // 安全开关：
  //   readonly=true       → agent 全部静默（scheduler 兜底）；prompt 里注明"只读房间"。
  //   mutationDryRun=true → 仍允许发言，prompt 里要求不要真的调用会产生副作用的工具。
  readonly?: boolean;
  mutationDryRun?: boolean;
  // v0.6 协作质量
  goal?: string;              // 房间目标一句话，注入 system prompt
  roundBudget?: number;       // 预期 agent 轮次；0/缺失 = 无上限
  roundsUsed?: number;        // 已消耗轮次（runAgentTurn 每调一次 +1）
  selfCritique?: boolean;     // 自我批判回合开关
  constitution?: string;      // 房间级红线列表（一行一条）
  // v0.4：本房间辅助 LLM 调用使用的模型（竞言打分 / 会议纪要 / extract-todo 等）。
  // 空/undefined = 跟随全局默认（`agentroom.aux_model`）；全局默认也为空时退化到成员主模型。
  auxModel?: string;
  // v0.7+ 全部可配置的"房间调参"：阈值 / 上下文 / PromptPack 全在这里。
  // 新手通过 RoomTuningModal 的"预设风格"tab 一键填好；高级用户在另外 3 个 tab 细调。
  // undefined 或空对象 = 全部用后端默认（见 agentroom.DefaultPromptPack 与 tuning 默认常量）。
  policyOptions?: PolicyOptions;
  tasks: RoomTask[];
  locker: RoomFile[];
  projection?: RoomProjection;
  templateId?: string;       // 来源模板
  parentRoomId?: string;     // fork 来源
  parentMessageId?: string;  // fork 起点
  // planned policy 状态（其它策略下可忽略）
  executionPhase?: 'discussion' | 'executing' | 'review';
  executionQueue?: string[];
  executionOwnerIdx?: number;
}

export interface RoomFact {
  key: string;
  value: string;
  authorId: string;
  updatedAt: number;
  history?: { value: string; authorId: string; at: number }[];
}

// 任务状态。v0.2 扩展为工作单状态机（后端常量见 internal/agentroom/types.go）：
//   todo / doing                      —— 旧字段，保持兼容
//   assigned / in_progress / review   —— 派发→执行→待验收
//   done / cancelled / blocked        —— 终态 / 阻塞
export type TaskStatus =
  | 'todo'
  | 'doing'
  | 'assigned'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'cancelled'
  | 'blocked';

// 验收结论（reviewer 给出的判定）。空字符串/undefined = 未提交验收。
export type AcceptanceStatus = '' | 'accepted' | 'rework' | 'needs_human' | 'blocked';

// 任务执行模式（v0.2 仅做字段承载，派发链路在 Phase C 实现）。
export type TaskExecutionMode = '' | 'manual' | 'member_agent' | 'subagent';

export interface RoomTask {
  id: string;
  roomId?: string;            // 所属房间（后端 DTO 始终携带；跨房间 dashboard 用到。前端创建草稿可省）
  text: string;
  assigneeId?: string;        // 执行人 member id
  creatorId: string;
  status: TaskStatus;
  dueAt?: number;
  refMessageId?: string;
  createdAt: number;
  completedAt?: number;

  // v0.2 工作单字段（后端 GAP G1+G3）。所有字段都可选，老房间任务自然为空。
  reviewerId?: string;            // 审查/验收人 member id
  deliverable?: string;           // 期望交付物
  definitionOfDone?: string;      // DoD（多行文本）
  sourceDecisionId?: string;      // 来源决策消息 id
  sourceMessageId?: string;       // 来源普通消息 id
  executionMode?: TaskExecutionMode;
  resultSummary?: string;         // 执行/手动结果摘要
  acceptanceStatus?: AcceptanceStatus;
  acceptanceNote?: string;        // 验收说明 / 返工要求
  passedCriteria?: string[];      // 已达标 DoD 项
  failedCriteria?: string[];      // 未达标 DoD 项
  reworkCount?: number;           // 已返工次数
  reviewedAt?: number;            // 上次提交验收时间
  // v0.3 主题 C：跨房间血缘
  parentTaskId?: string;
  rootRoomId?: string;
  // v0.3 主题 D：任务依赖（同房间）。dispatch 前会校验所有依赖必须 done。
  dependsOn?: string[];
}

// v0.3 主题 C：跨房间血缘 / dashboard / lineage 类型
export interface RoomBrief {
  id: string;
  title: string;
  state: string;
}

export interface RoomLineage {
  current: RoomBrief;
  parent: RoomBrief | null;
  root: RoomBrief | null;
  children: RoomBrief[];
}

export interface TaskLineage {
  task: RoomTask;
  sourceDecision: Message | null;
  sourceMessage: Message | null;
  parentTask: RoomTask | null;
  childTasks: RoomTask[];
  executions: TaskExecution[];
}

export interface RoomDashboardSummary {
  id: string;
  title: string;
  state: string;
  policy: string;
  taskCount: number;
  openCount: number;
  reviewCount: number;
  riskCount: number;
  parentRoomId?: string;
  updatedAt: number;
}

export interface MyDashboard {
  rooms: RoomDashboardSummary[];
  myActiveTasks: RoomTask[];
  awaitingMyReview: RoomTask[];
}

export interface CloneFromRoomPayload {
  taskIds?: string[];
  riskIds?: string[];
}

export interface CloneFromRoomResult {
  sourceRoomId: string;
  newRoomId: string;
  clonedTasks: RoomTask[];
  clonedRisks: Risk[];
  skippedTasks: number;
  skippedRisks: number;
}

// 验收提交载荷（前端调 acceptTask 时使用）。
export interface AcceptTaskPayload {
  status: 'accepted' | 'rework' | 'needs_human' | 'blocked';
  summary: string;
  passedCriteria?: string[];
  failedCriteria?: string[];
  reworkInstructions?: string;
}

// v0.2 GAP G4：任务执行回执。
export type TaskExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export interface TaskExecution {
  id: string;
  taskId: string;
  roomId: string;
  executorMemberId?: string;
  mode: 'manual' | 'member_agent' | 'subagent';
  status: TaskExecutionStatus;
  summary?: string;
  artifacts?: string[];
  blockers?: string[];
  rawRunRef?: string;
  tokenUsage?: number;
  errorMsg?: string;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
}

export interface DispatchTaskPayload {
  mode: 'manual' | 'member_agent' | 'subagent';
  executorMemberId?: string;
}

export interface SubmitExecutionResultPayload {
  summary: string;
  artifacts?: string[];
  blockers?: string[];
}

// 决策转任务的请求载荷。
export interface PromoteDecisionPayload {
  messageId: string;             // 来源决策消息 id（必须 isDecision=true）
  text?: string;                 // 自定义任务描述
  assigneeId?: string;
  reviewerId?: string;
  creatorId: string;
  deliverable?: string;
  definitionOfDone?: string;
  dueAt?: number;
}

export interface RoomFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: 'image' | 'pdf' | 'text' | 'code' | 'audio' | 'other';
  uploaderId: string;        // 成员 id（含 human）
  path?: string;              // 大文件只存路径
  previewText?: string;
  createdAt: number;
}

export interface RoomProjection {
  enabled: boolean;
  targets: ProjectionTarget[];
  inboundEnabled: boolean;
  busRoutes?: InterRoomBusRoute[];
}

export type InterRoomBusTrigger = 'closeout.done' | 'retro.updated';

export type InterRoomBusDeliveryMode = 'agenda_item' | 'task';

export interface InterRoomBusRoute {
  id: string;
  enabled: boolean;
  trigger: InterRoomBusTrigger;
  deliveryMode: InterRoomBusDeliveryMode;
  targetRoomId: string;
  titleTemplate?: string;
  note?: string;
}

export type ProjectionChannel =
  | 'discord'
  | 'telegram'
  | 'matrix'
  | 'mattermost'
  | 'wecom_group'   // 企业微信群机器人
  | 'feishu_bot'    // 飞书自定义机器人
  | 'wechat_exp';   // 个人微信（实验性）

export interface ProjectionTarget {
  id: string;
  channel: ProjectionChannel;
  webhookOrEndpoint: string;  // redacted 保存
  label: string;
  bidirectional: boolean;
  lastSyncAt?: number;
}

// ── 消息类型 ──

export type MessageKind =
  | 'chat'
  | 'thinking'
  | 'tool'
  | 'tool_approval'
  | 'whisper'
  | 'system'
  | 'error'
  | 'bidding'
  | 'projection_in'      // 从外部 IM 进来的消息
  | 'projection_out'     // 即将/已投影出去
  | 'impersonating'      // 人类扮演某 Agent
  | 'intervention'       // 人类干预标记
  | 'checkpoint'
  // v0.6
  | 'decision'           // 决策锚
  | 'artifact_ref'       // 引用 artifact 的轻量消息
  | 'minutes'            // closing agent 输出的会议纪要
  | 'untrusted'          // 哨兵隔离的外部内容
  | 'critique'           // 自我批判回合
  | 'summary';           // while-you-were-away / 手动摘要

// v0.9.1 图片附件 —— 与 OpenClaw agent/chat.send RPC 的 attachments 参数同构。
// 前端 Composer 读文件 → base64 → POST 给后端；后端 JSON 序列化到 DB，之后再反序列化
// 回传；MessageBubble 据此渲染缩略图。content 是 base64 原文（不含 data URL 前缀）。
export interface MessageAttachment {
  type: 'image';
  mimeType: string;
  fileName?: string;
  content: string;
  size?: number;
}

export interface Message {
  id: string;
  roomId: string;
  attachments?: MessageAttachment[];
  authorId: string;        // 成员 id（可为 human 的 id）
  actingAsId?: string;     // L5 扮演模式下被扮演的成员 id
  kind: MessageKind;
  content: string;
  // v0.4：前端乐观插入占位消息后，用同一 key 匹配后端真实消息去重。
  idempotencyKey?: string;
  contentEdited?: boolean; // L4 编辑过
  originalContent?: string;
  whisperTargetIds?: string[]; // 私聊目标，kind=whisper 时使用
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolResult?: string;
  toolStatus?: 'pending' | 'approved' | 'rejected' | 'running' | 'success' | 'failure' | 'timeout';
  biddingScores?: { memberId: string; score: number }[];
  reactions?: { emoji: string; byMemberIds: string[] }[];
  referenceMessageId?: string;
  mentionIds?: string[];
  tokensIn?: number;
  tokensOut?: number;
  costCNY?: number;
  model?: string;
  streaming?: boolean;
  deleted?: boolean;
  timestamp: number;
  projectionChannel?: ProjectionChannel;
  externalSenderName?: string; // projection_in 时
  // v0.6 协作质量 soft-tags（由 orchestrator ParseSoftTags 解析后落盘）
  confidence?: number;        // 0-100
  stance?: 'agree' | 'disagree' | 'abstain' | 'uncertain';
  humanNeeded?: string;       // 非空 = agent 明确请求人类介入
  untrusted?: boolean;        // 命中注入哨兵
  piiRedactedCount?: number;  // 出站投影时脱敏命中数（>0 显示徽章）
  isDecision?: boolean;       // promote 为决策
  decisionSummary?: string;   // 决策一行摘要
}

// ── v0.6 ───────────────────────────────

export interface Artifact {
  id: string;
  roomId: string;
  title: string;
  kind: 'markdown' | 'code' | 'json' | 'text';
  language?: string;
  content: string;
  version: number;
  authorId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlaybookHighlightContext {
  source: 'closeout' | 'retro';
  roomId: string;
  roomTitle?: string;
  summary?: string;
  highlights?: string[];
  lowlights?: string[];
  nextAgendaItems?: string[];
  playbookId?: string;
  generatedAt?: number;
}

export interface Playbook {
  id: string;
  sourceRoomId?: string;
  title: string;
  problem: string;
  approach: string;
  conclusion: string;
  category?: string;
  tags?: string[];
  createdAt: number;
}

// ── v0.7 真实会议环节 ───────────────────

export interface PlaybookStep {
  id: string;
  text: string;
  checked?: boolean;
  note?: string;
}

// PlaybookV7 —— 完整的结构化方法论卡。新版经验库 UI 使用这个。
export interface PlaybookV7 {
  id: string;
  ownerUserId: number;
  sourceRoomId?: string;
  title: string;
  problem: string;
  approach: string;
  conclusion: string;
  category?: string;
  tags: string[];
  appliesTo: string[];
  steps: PlaybookStep[];
  usageCount: number;
  appliedRooms: string[];
  version: number;
  isFavorite?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AgendaStatus = 'pending' | 'active' | 'parked' | 'done' | 'skipped';

export interface AgendaItem {
  id: string;
  roomId: string;
  seq: number;
  title: string;
  description?: string;
  targetOutcome?: string;
  policy?: RoomPolicy | '';
  roundBudget?: number;
  roundsUsed: number;
  status: AgendaStatus;
  assigneeIds: string[];
  outcome?: string;
  startedAt?: number;
  endedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type OpenQuestionStatus = 'open' | 'answered' | 'deferred';

export interface OpenQuestion {
  id: string;
  roomId: string;
  agendaItemId?: string;
  text: string;
  raisedById?: string;
  status: OpenQuestionStatus;
  answerMessageId?: string;
  answerText?: string;
  createdAt: number;
  updatedAt: number;
}

export type ParkingResolution = 'pending' | 'discarded' | 'task' | 'next-meeting';

export interface ParkingLotItem {
  id: string;
  roomId: string;
  text: string;
  raisedById?: string;
  resolution: ParkingResolution;
  createdAt: number;
  updatedAt: number;
}

export type RiskSeverity = 'low' | 'mid' | 'high';
export type RiskStatus = 'open' | 'mitigated' | 'accepted';

export interface Risk {
  id: string;
  roomId: string;
  text: string;
  severity: RiskSeverity;
  ownerId?: string;
  status: RiskStatus;
  parentRiskId?: string;  // v0.3 主题 C：跨房间血缘
  createdAt: number;
  updatedAt: number;
}

export type VoteMode = 'majority' | 'unanimous';
export type VoteStatus = 'open' | 'closed';

export interface VoteBallot {
  voteId: string;
  voterId: string;
  choice: string;
  rationale?: string;
  createdAt: number;
}

export interface Vote {
  id: string;
  roomId: string;
  agendaItemId?: string;
  question: string;
  options: string[];
  mode: VoteMode;
  voterIds: string[];
  status: VoteStatus;
  result?: string;
  initiatorId?: string;
  ballots: VoteBallot[];
  closedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface NextMeetingDraft {
  title: string;
  goal: string;
  templateId?: string;
  agendaItems: string[];
  inviteRoles: string[];
  suggestedAt?: string;
  // v0.2 GAP G6：结构化继承字段。LLM 生成的纯文本议程之外，
  // retro 还会带回未完成任务 / 返工任务 / 风险的 ID 列表，
  // 续会向导可据此精确显示"将带入新房间的事项"。
  sourceRoomId?: string;
  unfinishedTaskIds?: string[];
  reworkTaskIds?: string[];
  riskIds?: string[];
}

export interface Retro {
  roomId: string;
  roomTitle?: string;      // 在 /retros dashboard 列表里由后端 join 附带
  roomGoal?: string;
  scoreOverall: number;
  scoreGoal: number;
  scoreQuality: number;
  scoreDecisionClarity: number;
  scoreEfficiency: number;
  offTopicRate: number;
  highlights: string[];
  lowlights: string[];
  summary?: string;
  nextMeetingDraft?: NextMeetingDraft;
  outcomeArtifactId?: string;
  minutesArtifactId?: string;
  playbookId?: string;
  generatedAt: number;
  updatedAt: number;
}

// 关闭仪式流水线：每步的状态快照
export interface CloseoutStep {
  name: 'minutes' | 'todos' | 'playbook' | 'retro' | 'bundle';
  status: 'pending' | 'running' | 'ok' | 'error' | 'skipped';
  detail?: string;
  itemId?: string;
  startMs?: number;
  endMs?: number;
}

export interface OutcomeBundle {
  roomId: string;
  title: string;
  generatedAt: number;
  minutesArtifactId?: string;
  bundleArtifactId?: string;
  playbookId?: string;
  taskIds: string[];
  decisionIds: string[];
  agendaOutcomes: string[];
  retro?: Retro;
  markdownBody?: string;
}

// v0.9.1：关闭仪式消耗的辅助 LLM 用量快照。后端 Orchestrator.Closeout 在整个流水线
// 跑完后，把所有 nonStreamComplete 调用（minutes + batch + 可能的 fallback）累计出的
// tokens / 费用 / 模型信息塞在这里，用于前端结果页展示"这次关闭会议花了多少"。
export interface CloseoutUsage {
  model?: string;
  tokensPrompt: number;
  tokensComplete: number;
  costCNY: number;
  calls: number;
}

export interface CloseoutResult {
  roomId: string;
  steps: CloseoutStep[];
  bundle?: OutcomeBundle;
  ok: boolean;
  error?: string;
  // v0.9.1：本次 Closeout 流水线累计用量；完全取消时可能缺省。
  usage?: CloseoutUsage;
}

export interface PersonaMemory {
  memoryKey: string;
  content: string;
  sizeBytes: number;
  updatedAt: number;
}

// ── 模板 ──

export interface RoomTemplate {
  id: string;
  name: string;
  tagline: string;
  category: 'ops' | 'dev' | 'research' | 'fun';
  icon: string;               // material symbols name
  gradient: string;           // tailwind from-XXX to-XXX
  stars: number;
  memberCount: number;
  defaultPolicy: RoomPolicy;
  supportsProjection: boolean;
  members: TemplateMember[];
  initialFacts?: Record<string, string>;
  initialWhiteboard?: string;
  initialPromptHint?: string; // 向导第 2 步的占位提示
  budgetCNY: number;
  // v1.0+ 工作单初值（呼应 G3 验收 / G4 派发 / D1 依赖 DAG / D4 真实 spawn）。
  initialTasks?: TemplateTask[];
  // 推荐的任务派发模式：'member_agent' | 'subagent'；空 = 不预设。
  defaultDispatchMode?: string;
}

export interface TemplateTask {
  text: string;
  deliverable?: string;
  definitionOfDone?: string;
  // 默认执行人对应的模板成员 roleId
  executorRoleId?: string;
  // 默认验收人对应的模板成员 roleId；为空时回退到 isDefaultReviewer 成员
  reviewerRoleId?: string;
  // 依赖的前置任务在 initialTasks 中的 0-based 下标
  dependsOnIndices?: number[];
}

export interface TemplateMember {
  roleId: string;
  role: string;
  emoji: string;
  model?: string;
  systemPrompt?: string;
  isModerator?: boolean;
  // v0.4：模板作者可预置 agent/thinking；向导「高级」折叠区允许用户覆盖。
  agentId?: string;
  thinking?: string;
  // v1.0+：是否为 initialTasks 默认验收人（任务未指定 reviewerRoleId 时回退到此）
  isDefaultReviewer?: boolean;
}

// v0.4：启动模板房间时可为每个 roleId 覆盖 agent/thinking/model。
export interface TemplateMemberOverride {
  roleId: string;
  agentId?: string;
  thinking?: string;
  model?: string;
}

// ── 行为指标 ──

export interface RoomMetrics {
  agreementScore: number;     // 0-1
  infoGainTrend: 'up' | 'down' | 'flat';
  dominanceGini: number;       // 0-1
  convergenceRounds: number | null;
  toolUsageRate: number;       // 0-1
  totalMessages: number;
  totalTokens: number;
  perMember: { memberId: string; messages: number; tokens: number; costCNY: number }[];
}

// ── UI 模式 ──

export type InteractionMode = 'simple' | 'standard' | 'advanced';

// ── Phase 2: Tool Calling ──

export interface ToolCall {
  id: string;
  type: string; // "function"
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

// v0.4：ToolApprovalRequest 已移除 — 工具审批由 OpenClaw 原生 exec.approval 流处理。

// ── 干预审计 ──

export type InterventionLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface InterventionEvent {
  id: string;
  roomId: string;
  at: number;
  level: InterventionLevel;
  byHumanId: string;
  label: string;
  messageId?: string;
}

// ── v1.0 定时会议 ──

export interface MeetingSchedule {
  id: string;
  ownerUserId: number;
  title: string;
  templateId: string;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  initialPrompt?: string;
  autoCloseout: boolean;
  roundBudget: number;
  budgetCNY: number;
  inheritFromLast: boolean;
  deadlineAction: string;
  lastRunAt?: string;
  lastRoomId?: string;
  lastStatus?: string;
  lastError?: string;
  nextRunAt?: string;
  runCount: number;
}
