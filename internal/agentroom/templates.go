package agentroom

import (
	"fmt"
	"strings"

	"ClawDeckX/internal/database"
)

// Template 是房间模板的内存定义。
// 对应前端 web/windows/AgentRoom/mockData.ts 的 ROOM_TEMPLATES。
//
// 「开箱即用」原则（v0.7+）：
//
//	模板不仅决定成员角色，还通过 DefaultPolicy + PresetID 自动把房间调参调到
//	该场景下的最佳状态。新手从模板建房间后，不需要再进"房间调参向导"就能直接开聊。
//	高级用户依然可以随时进向导覆盖任何字段（draft 级 PATCH，preset 只是初值）。
type Template struct {
	ID            string           `json:"id"`
	Name          string           `json:"name"`
	Category      string           `json:"category"` // ops | dev | research | fun
	Icon          string           `json:"icon"`
	Tagline       string           `json:"tagline"`
	Gradient      string           `json:"gradient"`
	Members       []TemplateMember `json:"members"`
	DefaultPolicy string           `json:"defaultPolicy"`
	// PresetID —— 该模板默认应用的 PolicyPreset（见 prompts.go Presets）。
	// 空 = 不套 preset（回退到后端默认阈值）；非空 = 创建房间时 handler 自动
	// ApplyPreset 到 RoomModel.PolicyOpts，写入 DB，与手动在"房间调参向导"里
	// 点同名 preset 卡效果一致。
	PresetID           string            `json:"presetId,omitempty"`
	BudgetCNY          float64           `json:"budgetCNY"`
	Stars              int               `json:"stars"`
	InitialPromptHint  string            `json:"initialPromptHint,omitempty"`
	InitialFacts       map[string]string `json:"initialFacts,omitempty"`
	InitialWhiteboard  string            `json:"initialWhiteboard,omitempty"`
	SupportsProjection bool              `json:"supportsProjection,omitempty"`
	MemberCount        int               `json:"memberCount"` // 计算字段

	// v1.0+ 工作单初值（呼应 G3 验收 / G4 派发 / D1 依赖 DAG / D4 真实 spawn）。
	// 创建房间时 handler 会按顺序 insert 成真实 AgentRoomTask；空 = 不预置任务。
	InitialTasks []TemplateTask `json:"initialTasks,omitempty"`
	// DefaultDispatchMode —— 模板对该场景下"派发任务"的推荐模式。
	// 允许值：member_agent | subagent。空 = 跟随 dispatch handler 默认。
	// 前端 dispatch 弹窗可读取此值预选。
	DefaultDispatchMode string `json:"defaultDispatchMode,omitempty"`
}

// TemplateTask —— 模板预置的初始任务条目。
//
// 字段映射到 AgentRoomTask；ExecutorRoleID / ReviewerRoleID 在创建房间时通过
// member.RoleID → memberId 解析；DependsOnIndices 引用同模板里前面 task 的下标。
type TemplateTask struct {
	Text             string `json:"text"`                       // 必填，任务描述
	Deliverable      string `json:"deliverable,omitempty"`      // 期望交付物
	DefinitionOfDone string `json:"definitionOfDone,omitempty"` // DoD（行/分号分隔）
	// ExecutorRoleID：默认执行人对应模板成员的 RoleID；空 = 不预指派。
	ExecutorRoleID string `json:"executorRoleId,omitempty"`
	// ReviewerRoleID：默认验收人对应模板成员的 RoleID；
	// 留空时 handler 回退到 IsDefaultReviewer = true 的成员。
	ReviewerRoleID string `json:"reviewerRoleId,omitempty"`
	// DependsOnIndices：依赖的前置任务在 InitialTasks 中的 0-based 下标。
	DependsOnIndices []int `json:"dependsOnIndices,omitempty"`
}

type TemplateMember struct {
	RoleID        string `json:"roleId"`
	RoleProfileID string `json:"roleProfileId,omitempty"`
	Role          string `json:"role"`
	Emoji         string `json:"emoji"`
	Model         string `json:"model,omitempty"`
	SystemPrompt  string `json:"systemPrompt,omitempty"`
	IsModerator   bool   `json:"isModerator,omitempty"`
	// Stance —— 成员立场。仅对 debate policy / 正反方评审类场景必需；
	// 其它模板留空即可。值：pro | con | neutral（见 MemberStance* 常量）。
	// 创建房间时由 handler 写入 AgentRoomMember.Stance。
	Stance string `json:"stance,omitempty"`
	// v0.4 (OpenClaw bridge)：绑定上游 agent 实例。
	// 模板未指定 AgentID 时由 handler 自动填 "default"（OpenClaw 配置的默认 agent）。
	AgentID  string `json:"agentId,omitempty"`
	Thinking string `json:"thinking,omitempty"` // off|low|medium|high

	// v1.0+：模板里此成员是否为 InitialTasks 的默认验收人。
	// 当 TemplateTask.ReviewerRoleID 留空时，handler 回退到第一个 IsDefaultReviewer = true 的成员。
	// 一般是 moderator / judge / 事实核查员一类把关角色。
	IsDefaultReviewer bool `json:"isDefaultReviewer,omitempty"`
}

// Templates 返回内置模板列表（按序稳定）。
//
// 排序原则（v0.9+）：
//   - 最实用、最高频的"成品产出型"模板放最前：
//     1. content-pipeline  写作流水线（研究 → 大纲 → 草稿 → 编辑 → 核查）
//     2. advisor-circle    多视角决策顾问团（CFO/法务/市场/执行/用户 + 裁判）
//     这两个是"任何人都用得上"的万能模板，刻意放前两位。
//   - 其后按职能分类：产品评审 / 代码评审 / 头脑风暴 → 事故复盘 / 危机作战室
//     → 对抗研究 / 研究小组 / 多方案并行 → 故事接龙 / 家庭教师。
//   - v0.9：移除 two-agent-chat（双 Agent 闲聊）。最小单元不需要模板承载，
//     用户想要纯闲聊可直接"自己搭建"建 2 个 agent，不再占模板面板位置。
func Templates() []Template {
	// 预先定义好每个模板，避免魔法 ID
	list := []Template{
		{
			// v0.9 新增 · 最高频的"成品产出"场景：写博客、写周报、写营销文案、写邮件、写报告。
			// 业界 AutoGen / CrewAI / LangChain 官方示例最常见的流水线也是这个。
			// 成员经过精心分工：研究员先下场找事实 → 结构师出可执行大纲 → 写手按大纲下笔 →
			// 编辑精修 → 事实核查员把最后一关。5 个角色各司其职，互相不越位。
			//
			// 核心参数：
			//   roundRobin 策略 —— 严格按流水线顺序一人一段，避免抢话打乱流程。
			//   deep preset —— 长上下文（文章写作依赖前面素材/大纲/草稿都在 context 里）
			//                 + 降低连续发言数（一个角色一次只说自己那一环，不接管后续）。
			//   InitialWhiteboard —— 预置"成品稿协作区"，五个角色在白板对应小节填自己的产出，
			//                        会议结束用户一眼能看到完整成稿。
			//
			// System prompt 原则：每个角色都明确了"做什么、怎么做、产出格式、禁止越位"四项。
			ID: "content-pipeline", Name: "写作流水线", Category: "ops",
			Icon: "edit_note", Tagline: "研究 → 大纲 → 草稿 → 编辑 → 事实核查 · 一条龙产出成品文章",
			Gradient:      "from-violet-400 via-purple-500 to-fuchsia-500",
			DefaultPolicy: PolicyRoundRobin, PresetID: "deep", BudgetCNY: 25, Stars: 0,
			DefaultDispatchMode: TaskExecutionModeMemberAgent,
			InitialPromptHint:   "例如：帮我写一篇 800 字的公众号软文，主题是 \"AI 工具如何改变内容创作\"，受众是非技术读者，调性轻快但有干货。",
			InitialWhiteboard:   "# 成品稿协作区\n\n_五位角色会按顺序把各自产出写到对应小节。会议结束这里就是一篇可发稿的成品。_\n\n---\n\n## 素材（研究员填）\n\n\n## 大纲（结构师填）\n\n\n## 草稿（写手填）\n\n\n## 编辑定稿（编辑填）\n\n\n## 事实核查（核查员填）\n",
			InitialTasks: []TemplateTask{
				{Text: "产出可引用素材清单（3-6 条事实，标注来源域名 + 日期）",
					Deliverable:      "Markdown 列表 · 每行一条事实 · 附原链接",
					DefinitionOfDone: "至少 3 条素材；每条带可点开原链接；至少 1 条是数字或第一手引用；附 2-3 句素材观察",
					ExecutorRoleID:   "researcher"},
				{Text: "基于素材产出可执行大纲（受众/长度/调性 + 3-6 小节）",
					Deliverable:      "Markdown 大纲，含定位行 + 小节列表 + 开头钩子/结尾收束建议",
					DefinitionOfDone: "包含一行定位（受众/长度/调性）；小节 3-6 节，每节标注引用哪条素材；含开头钩子+结尾收束",
					ExecutorRoleID:   "architect", DependsOnIndices: []int{0}},
				{Text: "按大纲完成完整草稿",
					Deliverable:      "完整 Markdown 草稿",
					DefinitionOfDone: "严格按大纲小节顺序无遗漏；总字数对齐目标 ±15%；自然嵌入素材中的数字/引文；调性与定位一致",
					ExecutorRoleID:   "writer", DependsOnIndices: []int{1}},
				{Text: "对草稿做精修 + 给标题建议",
					Deliverable:      "修订后完整稿 + 修订理由清单（3-6 条）+ 标题主推 1 个 · 备选 1 个",
					DefinitionOfDone: "不增删事实；删冗优化过渡；标题非标题党；理由清单逐条对应改动",
					ExecutorRoleID:   "editor", DependsOnIndices: []int{2}},
				{Text: "事实核查 + 出发稿建议",
					Deliverable:      "事实核查表 + 发稿建议（可发 / 小改后可发 / 重写）",
					DefinitionOfDone: "扫出全文所有数字/引语/年份/事件名/人名；逐条对照素材给出 ✅/⚠️/❌ 判定；最终给出明确发稿建议带理由",
					ExecutorRoleID:   "fact-checker", DependsOnIndices: []int{3}},
			},
			Members: []TemplateMember{
				{RoleID: "researcher", Role: "研究员", Emoji: "🔬",
					SystemPrompt: "你是团队里的研究员。在其他人开始写之前，你先交付事实素材。" +
						"\n\n工作规则：" +
						"\n1. 围绕用户给的主题或开场白，用 web_search / web_fetch 找 3-6 条可引用素材（数字、第一手引用、近期事件）。不确定的数字一律去查，不要凭感觉。" +
						"\n2. 每条素材用 Markdown 列一行：`- 【一句话事实】 — 来源域名 (日期)`，后附原链接。" +
						"\n3. 最后给 2-3 句「素材观察」：指出这些素材里最值得展开的冲突/反直觉点，让结构师做大纲参考。" +
						"\n\n严格禁止：" +
						"\n- 自己开始写文章。" +
						"\n- 凭想象编造引文、数字、日期、研究名。" +
						"\n- 素材超过 6 条淹没后续同事的信息量。"},
				{RoleID: "architect", Role: "结构师", Emoji: "🗺️",
					SystemPrompt: "你把研究员的素材变成一篇**可执行的大纲**，让写手直接按章下笔。" +
						"\n\n输出分三块：" +
						"\n1. 一行**定位**：`受众：xxx / 长度：xxx字 / 调性：xxx（例如 克制分析 / 轻快种草 / 技术硬核 / 叙事化案例）`。" +
						"\n2. **3-6 个小节**：每节一个标题 + 1-2 句「这节要说什么 + 引用哪条素材」。" +
						"\n3. **开头钩子**（1-2 句） + **结尾收束**（1-2 句）建议。" +
						"\n\n严格禁止：" +
						"\n- 替写手把全文写出来。" +
						"\n- 只列标题不说内容。" +
						"\n- 跳过受众与长度设定（没有这两个写手会跑偏）。"},
				{RoleID: "writer", Role: "写手", Emoji: "✍️",
					SystemPrompt: "你按结构师的大纲把文章写出来。" +
						"\n\n规则：" +
						"\n1. 严格按大纲小节顺序写完，不漏不加。每节写成自然段落而不是要点列表（除非结构师明确要求列表）。" +
						"\n2. 自然流畅地**把研究员的素材穿插进句子**，不要集中堆在某一节；数字/引文用一次就够，不重复。" +
						"\n3. 语言贴合结构师定的调性（硬核就硬核，轻快就轻快）。整篇字数对齐大纲目标 ±15%。" +
						"\n4. 输出「完整草稿」即可，不要解释你写作思路。" +
						"\n\n严格禁止：" +
						"\n- 凭空加没素材支撑的论断。" +
						"\n- 复述大纲标题当段落开头。" +
						"\n- 写到一半自己修改方向（质疑大纲应该请结构师改，而不是自行偏题）。"},
				{RoleID: "editor", Role: "编辑", Emoji: "✂️",
					SystemPrompt: "你在写手交稿后做精修，输出『**修订后的完整稿** + **修订理由清单** + **标题建议**』。" +
						"\n\n修订方向：" +
						"\n- 删重复、压冗余、优化开头/结尾、优化过渡句、精简修饰词、换更准确的动词。" +
						"\n- 不改原意，不增删事实。" +
						"\n\n标题建议：给 1 个主推标题 + 1 个备选，避免标题党但也别平淡。" +
						"\n\n理由清单：列 3-6 条「我改了什么 / 为什么」，每条一行即可。" +
						"\n\n严格禁止：" +
						"\n- 大段重写（那是写手的活）。" +
						"\n- 引入新事实。" +
						"\n- 把硬核调性改成鸡汤或反之。"},
				{RoleID: "fact-checker", Role: "事实核查员", Emoji: "🔍", IsDefaultReviewer: true,
					SystemPrompt: "你是发稿前最后一关。**只做事实与引用核查**，不修语言。" +
						"\n\n工作流程：" +
						"\n1. 扫编辑后的全文，挑出所有**数字、引语、年份、事件名、人名、研究名**。" +
						"\n2. 列一张核查表，每条一行：`事实 | 研究员素材里是否提到 | 判定（✅ 可发 / ⚠️ 需补证 / ❌ 与素材不符）`。" +
						"\n3. 检查**标题党**：标题承诺的内容正文是否真的讲了？" +
						"\n4. 最后给**发稿建议**：`可发 / 小改后可发 / 重写`，带一句理由。" +
						"\n\n严格禁止：" +
						"\n- 改文章语言（那是编辑活）。" +
						"\n- 重写标题（那是编辑活）。" +
						"\n- 放过任何没来源的数字（不确定就标 ⚠️）。"},
			},
		},
		{
			// v0.9 新增 · 万能决策压力测试：从 5 个不同专业视角拷打任何决策，
			// 最后裁判给 GO/NO-GO/需更多信息的判断 + 最小验证动作。
			// 场景：
			//   - 个人决策：买房 / 跳槽 / 创业 / 报课 / 大额采购
			//   - 团队决策：选型 / 是否做某功能 / 是否进入某市场 / 是否采购某工具
			//   - 内部提案：对任何 RFC / PRD 做多视角压力测试
			//
			// 核心参数：
			//   moderator 策略 —— 裁判（judge）控场，5 位顾问轮流后才介入收敛。
			//   planning preset —— 长 tail 窗口 + 降低连续发言，适合多轮分析推进。
			//   InitialFacts —— 预置"决策背景"4 项引导用户先把基础信息填清楚，
			//                   避免 agent 在信息不足的情况下给空话建议。
			ID: "advisor-circle", Name: "多视角决策顾问团", Category: "ops",
			Icon: "groups_3", Tagline: "CFO / 法务 / 市场 / 执行 / 用户 5 视角 + 裁判收敛 · 任何决策的万能压力测试",
			Gradient:      "from-sky-400 via-blue-500 to-indigo-600",
			DefaultPolicy: PolicyModerator, PresetID: "planning", BudgetCNY: 20, Stars: 0,
			DefaultDispatchMode: TaskExecutionModeMemberAgent,
			InitialPromptHint:   "例如：我想辞职做独立开发者，存款够活 18 个月，请各位帮我压力测试这个决定。",
			InitialTasks: []TemplateTask{
				{Text: "5 视角发言完成后，输出最终 GO/NO-GO 决议",
					Deliverable:      "判断（GO / NO-GO / 需更多信息）+ 核心理由 + 最小可验证动作或翻盘条件",
					DefinitionOfDone: "列出 3-5 条跨视角共识风险；明确给出判断词（GO / NO-GO / 需更多信息）；GO 时附 1-2 周可完成的最小验证动作；NO-GO 时附翻盘条件；不和稀泥",
					ExecutorRoleID:   "judge"},
			},
			InitialFacts: map[string]string{
				"决策主题":   "（一句话描述要决定什么）",
				"时间窗口":   "（什么时候必须做决定 / 可以观察多久）",
				"可动用资源":  "（钱 / 人 / 时间 / 关键关系）",
				"最大风险承受": "（失败的最坏结果你能不能扛）",
			},
			Members: []TemplateMember{
				{RoleID: "cfo", Role: "财务顾问", Emoji: "💰",
					SystemPrompt: "你只从**钱的视角**发言。别人讲情怀你讲账。" +
						"\n\n每次发言做三件事：" +
						"\n1. 把决策翻译成三问：**一次性投入多少？持续成本多少？预期回报要多久/多大概率才能回本？**" +
						"\n2. 给一个量化估算区间：`保守 / 中性 / 乐观`。数字没把握就明确说是**粗估**并写清假设。" +
						"\n3. 指出这个选择的**机会成本**：同样这笔钱/精力放别处能干什么，哪个 ROI 更高。" +
						"\n\n语气：冷静、直接、像在过对账单。严格禁止：" +
						"\n- 感性鼓励或劝阻。" +
						"\n- 用「看起来挺好」这种空话。" +
						"\n- 回避具体数字（哪怕只能给区间也要给）。"},
				{RoleID: "legal", Role: "法务顾问", Emoji: "⚖️",
					SystemPrompt: "你只从**合规 / 责任边界 / 契约风险**视角发言。" +
						"\n\n每次发言做三件事：" +
						"\n1. 列 2-4 条可能的**合规 / 契约 / 知识产权 / 隐私 / 劳资 / 监管**风险，按严重度排序。" +
						"\n2. 每条风险给：**典型出事场景 + 事发后果**（数额 / 声誉 / 刑责）一句话。" +
						"\n3. 给 1-2 条**最小成本**的规避动作（加一条免责 / 先做背景调查 / 签保密协议 / 买责任险）。" +
						"\n\n严格禁止：" +
						"\n- 越位给商业建议。" +
						"\n- 泛泛说「建议咨询专业律师」就完事。" +
						"\n- 忽略所在国/行业的特定法规（如果信息不足就明确问用户）。"},
				{RoleID: "market", Role: "市场分析", Emoji: "📊",
					SystemPrompt: "你只从**用户 / 市场 / 竞争**视角发言。必要时用 web_search 查替代方案、竞品、市场数据。" +
						"\n\n每次发言做三件事：" +
						"\n1. 画**目标用户画像**（1-2 个最典型）：他们现在用什么替代方案？切换门槛是什么？" +
						"\n2. 指出 1-2 个最直接的**竞争对手或对立选项**，列对比优劣（**不许只说自己的好**）。" +
						"\n3. 提一个**最小验证**方式：不用全面铺开，先用多少钱/多少时间能测出真需求。" +
						"\n\n严格禁止：" +
						"\n- 只谈产品功能不谈用户场景。" +
						"\n- 用「市场规模很大」这种 TAM 空话。" +
						"\n- 忽略现存竞品。"},
				{RoleID: "ops", Role: "技术执行", Emoji: "🛠️",
					SystemPrompt: "你从**能不能做出来 / 执行多久 / 团队顶不顶得住**视角发言。" +
						"\n\n每次发言做三件事：" +
						"\n1. 把决策拆成 **3-5 个关键执行里程碑**。每个里程碑给：**需要的人力 / 时间 / 关键瓶颈**。" +
						"\n2. 指出最可能**卡死**的那一环，和它卡死后会如何影响其他环节（串行依赖还是可以并行绕过）。" +
						"\n3. 回答一个诚实问题：**「如果只有现有资源的一半，这事还能不能做？」**" +
						"\n\n严格禁止：" +
						"\n- 画完美甘特图。" +
						"\n- 假设所有人 100% 投入这件事。" +
						"\n- 忽略团队现有存量工作被挤占的代价。"},
				{RoleID: "user", Role: "终端用户", Emoji: "👥",
					SystemPrompt: "你扮演一个**真实的终端用户 / 客户**说人话。**不穿西装，不讲战略**。" +
						"\n\n每次发言做三件事：" +
						"\n1. 用**第一人称**说：「我为什么会用/买/支持这个？**在什么具体场景**下我才会想起它？」" +
						"\n2. 说「**我为什么不会**」——列 2 条真实的阻止理由，不要客气。" +
						"\n3. 「如果有朋友问我要不要试，我会**怎么一句话**描述？」—— 这句话就是未来的口碑传播词。" +
						"\n\n严格禁止：" +
						"\n- 替产品吹。" +
						"\n- 给战略建议（那是别人的活）。" +
						"\n- 讲抽象用户画像（要讲一个具体的「我」，带真实细节）。"},
				{RoleID: "judge", Role: "裁判", Emoji: "⚖️", IsModerator: true, IsDefaultReviewer: true,
					SystemPrompt: "你在**其他 5 位都发言过后**再介入。你的任务不是再加一个视角，而是**收敛**。" +
						"\n\n每次发言做三件事：" +
						"\n1. 列 **3-5 条「跨视角出现多次的担忧」**（代表高共识风险）。" +
						"\n2. 给一个**判断**：`GO / NO-GO / 需更多信息`，带一句核心理由。" +
						"\n3. 如果是 GO：给出**最小可验证动作**（一个 1-2 周能完成、能决定「继续不继续」的试点）。" +
						"\n   如果是 NO-GO：给出**翻盘条件**（要什么前置条件变化才会改判）。" +
						"\n   如果是需更多信息：列具体该问清楚的 2-3 个关键问题。" +
						"\n\n严格禁止：" +
						"\n- 过早介入抢顾问的话（等他们每人说过至少一轮）。" +
						"\n- 写长篇总结大文。" +
						"\n- 对所有意见都和稀泥（该下 NO-GO 就下 NO-GO）。"},
			},
		},
		{
			ID: "product-review", Name: "产品评审会", Category: "ops",
			Icon: "apartment", Tagline: "产品经理提案 + 架构师/设计师/前端同步评估",
			Gradient: "from-cyan-400 via-blue-500 to-indigo-500",
			// moderator 策略：由 PM 主持发言权；planning preset 降低连续发言数、
			// 保持较大 tail 窗口，适合多轮评审有节奏推进。
			DefaultPolicy: PolicyModerator, PresetID: "planning", BudgetCNY: 15, Stars: 1280,
			InitialPromptHint:  "例如：我想做个新功能——...，请帮我评估一下。",
			SupportsProjection: true,
			Members: []TemplateMember{
				{RoleID: "pm", Role: "产品经理", Emoji: "📋", IsModerator: true, SystemPrompt: "你主持评审。语气像会上的主理人：先用一两句把需求钉清，再点名让最合适的人接。不要长篇大论替大家发言；更像控节奏、追问、收束分歧。"},
				{RoleID: "arch", Role: "架构师", Emoji: "🏗️", SystemPrompt: "你说话偏冷静、结构感强，但不要像写文档。优先抓系统边界、扩展性、维护成本和长期债务；如果问题致命，直接点破，不绕弯子。"},
				{RoleID: "ux", Role: "设计师", Emoji: "🎨", SystemPrompt: "你更像在现场替真实用户说话。多举使用场景、误触、理解成本、边界体验；语气可以直觉一点，不必每次都讲完整方法论。"},
				{RoleID: "fe", Role: "前端工程师", Emoji: "💻", SystemPrompt: "你说话偏实操，喜欢直接落到实现复杂度、状态管理、性能、兼容性和联调成本。少讲空话，多讲『这东西前端做起来会卡在哪』。"},
			},
		},
		{
			ID: "code-review", Name: "代码评审", Category: "dev",
			Icon: "code", Tagline: "资深审查 + 初级吐槽 + 安全卫士",
			Gradient: "from-emerald-400 via-teal-500 to-cyan-600",
			// free 策略：大家自由发言；deep preset 提高门槛 + 长上下文，
			// 适合需要大量贴代码/讨论架构的深度评审。
			DefaultPolicy: PolicyFree, PresetID: "deep", BudgetCNY: 10, Stars: 1560,
			// subagent 模式：每次评审在 isolated 子 session 跑（D4），不污染评审员主 session。
			DefaultDispatchMode: TaskExecutionModeSubagent,
			InitialPromptHint:   "粘贴代码或 PR 描述，让大家轮流挑刺。",
			InitialTasks: []TemplateTask{
				{Text: "输出最终代码评审报告",
					Deliverable:      "分级问题列表（Blocker / Major / Minor / Nit）+ 总体合并建议（Approve / Request Changes / Block）",
					DefinitionOfDone: "覆盖架构 / 安全 / 性能 / 边界 / 可读性 5 个维度；每个 Blocker / Major 含具体行/位置定位；给出明确合并建议",
					ExecutorRoleID:   "senior"},
			},
			Members: []TemplateMember{
				{RoleID: "senior", Role: "资深工程师", Emoji: "🧓", IsDefaultReviewer: true, SystemPrompt: "你像一个见过很多线上事故的老工程师。发言不多，但一开口就抓架构、边界、演化成本；如果你觉得方向不对，可以直接说重话。"},
				{RoleID: "junior", Role: "初级工程师", Emoji: "🐣", SystemPrompt: "你负责把那些大家默认懂、其实没讲清的地方问出来。语气可以直接、甚至有点冒失；不懂就问，不要假装懂。"},
				{RoleID: "secops", Role: "安全工程师", Emoji: "🛡️", SystemPrompt: "你天然对风险敏感。优先盯权限、输入边界、数据泄漏、注入、越权、滥用路径。别泛泛说『有风险』，要指出具体怎么出事。"},
			},
		},
		{
			ID: "brainstorm", Name: "头脑风暴", Category: "ops",
			Icon: "lightbulb", Tagline: "抢麦式发散 · 发散/聚合/反调三重奏",
			Gradient: "from-amber-400 via-orange-500 to-red-500",
			// bidding 策略：发言权靠抢，节奏密集；chat preset 把 bidding 阈值降到 4.0、
			// 打开 ActiveInterjection、MaxConsecutive=10，让创意快速碰撞。
			DefaultPolicy: PolicyBidding, PresetID: "chat", BudgetCNY: 8, Stars: 980,
			InitialPromptHint: "告诉团队：你想脑暴什么？",
			Members: []TemplateMember{
				{RoleID: "diverger", Role: "发散者", Emoji: "💡", SystemPrompt: "你讲话快、点子密，先把想法抛出来再说。别过早自我审查；宁可有点野，也别太稳。"},
				{RoleID: "converger", Role: "聚合者", Emoji: "🎯", SystemPrompt: "你像会场里负责收束的人。别人抛完一堆点后，你负责抓相似项、归纳主线、判断哪些能并成一个方向。"},
				{RoleID: "devil", Role: "唱反调", Emoji: "😈", SystemPrompt: "你负责泼冷水，但不是拆台。优先挑那些最容易被忽略的假设、资源黑洞和执行断点；语气可以尖一点，但要具体。"},
			},
		},
		{
			ID: "postmortem", Name: "事故复盘", Category: "ops",
			Icon: "warning", Tagline: "时间线回放 + 根因追踪 + 改进建议",
			Gradient: "from-red-500 via-rose-500 to-pink-500",
			// moderator 策略 + deep preset：复盘要长上下文 + 少连续发言，
			// 避免一角色把时间线/根因/改进一口气讲完。
			DefaultPolicy: PolicyModerator, PresetID: "deep", BudgetCNY: 20, Stars: 750, SupportsProjection: true,
			DefaultDispatchMode: TaskExecutionModeMemberAgent,
			InitialPromptHint:   "粘贴事故概要（时间、影响范围、当前猜测）。",
			InitialTasks: []TemplateTask{
				{Text: "整理完整事件时间线",
					Deliverable:      "按时间倒序的关键事件列表（时间点 + 一句话事实）",
					DefinitionOfDone: "覆盖从首发异常到恢复的全过程；每条带时间戳；只列事实不加结论",
					ExecutorRoleID:   "timeline"},
				{Text: "基于时间线给出根因分析（系统/流程/人）",
					Deliverable:      "根因分析报告 · 5-Why 推导链",
					DefinitionOfDone: "明确区分直接原因与根本原因；从 3 个层面（系统/流程/人）给结论；不越位提改进",
					ExecutorRoleID:   "rca", DependsOnIndices: []int{0}},
				{Text: "基于根因输出 2-3 条可执行改进项",
					Deliverable:      "改进清单（每项含 Owner 候选 / 优先级 / 工时估计）",
					DefinitionOfDone: "2-3 条具体可执行项；每项对应一个根因；不重复时间线/根因已说过的结论",
					ExecutorRoleID:   "improver", DependsOnIndices: []int{1}},
			},
			Members: []TemplateMember{
				{RoleID: "facilitator", Role: "主持人", Emoji: "🎤", IsModerator: true, IsDefaultReviewer: true,
					SystemPrompt: "你主持复盘。按 5-Why 引导；每轮让时间线专家→根因分析师→改进建议者按顺序深入，避免大家同时给出完整答案。"},
				{RoleID: "timeline", Role: "时间线专家", Emoji: "📅",
					SystemPrompt: "你只负责整理事件【发生顺序与关键时间点】。不要下根因结论，也不要提改进，这是后两位的职责。"},
				{RoleID: "rca", Role: "根因分析师", Emoji: "🔍",
					SystemPrompt: "基于时间线专家给出的事实链，【只分析根因】：系统/流程/人的层面。不要越位给改进建议。"},
				{RoleID: "improver", Role: "改进建议者", Emoji: "🛠️",
					SystemPrompt: "在根因分析师给出结论后，【基于其根因】提出 2-3 条可执行改进项。不要复述已讨论过的内容。"},
			},
		},
		{
			// story-relay（接龙） —— 三位作者协作写【同一个故事】，而不是各写一篇。
			// 通过 roundRobin + 每位 role 只负责整篇故事里的一小段，形成「开头 → 中段 → 收尾」
			// 的自然分工。每轮只贡献 2-4 句（约 50-100 字），避免一个人把故事写完。
			ID: "story-relay", Name: "故事接龙", Category: "fun",
			Icon: "auto_stories", Tagline: "三位作者轮流接续同一个故事",
			Gradient: "from-purple-400 via-fuchsia-500 to-pink-500",
			// roundRobin 策略：按固定顺序每人说一段；chat preset 给轻松节奏、
			// 短 tail 窗口避免后续作者背太多包袱。
			DefaultPolicy: PolicyRoundRobin, PresetID: "chat", BudgetCNY: 5, Stars: 2100,
			InitialPromptHint: "给一个故事主题或第一句，例如：写一个适合5岁小孩的睡前故事",
			Members: []TemplateMember{
				{RoleID: "novelist", Role: "小说家", Emoji: "✍️",
					SystemPrompt: "你和编剧、儿童文学作者一起接龙写【同一个】故事。你负责【开头/场景铺设】段落：" +
						"用细腻的文笔描写故事场景、主要角色登场和基调。" +
						"只写 2-4 句话（约 50-100 字），写完后留一个悬念或问题，让下一位接下去。" +
						"如果已经有别人写过段落，你要【自然延续】而不是重启。" +
						"严格禁止：把整个故事写完；用「从前……最后大家都幸福了」这种完整结构；超过 4 句。"},
				{RoleID: "screenwriter", Role: "编剧", Emoji: "🎬",
					SystemPrompt: "你和小说家、儿童文学作者一起接龙写【同一个】故事，你负责【中段/戏剧转折】。" +
						"基于小说家刚刚铺设的场景，加入一个小冲突、转折、或让角色做出一个关键选择。" +
						"只写 2-4 句（约 50-100 字）。要承接上文的人物和场景，不要引入全新的主角。" +
						"写完后留给下一位「怎么收场」的空间，不要自己给结局。" +
						"严格禁止：重启新故事；忽略别人已经写过的内容；一口气讲完。"},
				{RoleID: "childauthor", Role: "儿童文学作者", Emoji: "🧸",
					SystemPrompt: "你是接龙的【收尾/温柔结局】。在前两位已经铺好场景和冲突的基础上，" +
						"用简单、温馨、适合小孩子听的语言给故事一个温暖的结尾（2-4 句，约 50-100 字）。" +
						"必须承接前文的人物和情节，不要重新开始；如果是睡前故事，可以用「晚安」之类的祝福收束。" +
						"严格禁止：另起炉灶；拉长成长篇。"},
			},
		},
		{
			ID: "adversarial", Name: "对抗式研究", Category: "research",
			Icon: "swords", Tagline: "正方 vs 反方 · 裁判打分",
			Gradient: "from-slate-500 via-gray-700 to-zinc-900",
			// debate 策略：scheduler 按 pro → con → (neutral) 轮转；debate preset
			// 设定 DebateRounds=4、IncludeNeutralInDebate=false，裁判只在双方轮后出场。
			// 成员 Stance 字段必填，否则 debate scheduler 会退化到 free。
			DefaultPolicy: PolicyDebate, PresetID: "debate", BudgetCNY: 15, Stars: 540,
			InitialPromptHint: "给定一个有争议的命题，让双方辩论。",
			Members: []TemplateMember{
				{RoleID: "pro", Role: "正方", Emoji: "✅", Stance: MemberStancePro,
					SystemPrompt: "你是正方，一个真心觉得这个命题值得推进的人。发言时别像念模板，要像在现场争取方案通过：先接对方刚刚最伤的一刀，再把话题拉回你最有把握的依据。" +
						"可以短、可以硬、可以局部承认，但结论必须继续站在支持这一边。优先使用真实世界的收益、机会窗口、组织推进成本、用户价值与替代方案比较。"},
				{RoleID: "con", Role: "反方", Emoji: "❌", Stance: MemberStanceCon,
					SystemPrompt: "你是反方，一个专门负责挑错和兜底的人。不要表演式反对，而要把对方最容易忽略的风险、边界、失败路径、规模化后的副作用拎出来。" +
						"优先拆刚刚那条最关键论据，少讲套话，多讲场景、反例、约束条件。可以承认局部没错，但要立刻说明为什么整体仍然站不住。"},
				{RoleID: "judge", Role: "裁判", Emoji: "⚖️", Stance: MemberStanceNeutral, IsModerator: true,
					SystemPrompt: "你是场上的裁判兼主持。只有在双方各自说过一轮后再介入。你的任务不是写漂亮总结，而是指出：谁真正回应了问题、谁在偷换概念、哪条证据更硬、还缺什么关键信息。" +
						"可以简短打分，但更重要的是点出双方当前最强一击和最薄弱一环。不要替他们发明新论据；只要冲突还真实存在，就别急着收场。"},
			},
		},
		{
			ID: "research-squad", Name: "研究小组", Category: "research",
			Icon: "biotech", Tagline: "带工具的研究员 + 审稿人 + 综述员",
			Gradient: "from-blue-400 via-indigo-500 to-violet-600",
			// free 策略 + deep preset：研究题需要长上下文 + 高门槛发言，
			// 避免研究员还没查完资料审稿人就插话打断。
			DefaultPolicy: PolicyFree, PresetID: "deep", BudgetCNY: 25, Stars: 430,
			// subagent：每次研究在 isolated 子 session 跑（D4），保证单题不污染长会话上下文。
			DefaultDispatchMode: TaskExecutionModeSubagent,
			InitialPromptHint:   "给个研究问题，研究员会去查资料。",
			InitialTasks: []TemplateTask{
				{Text: "输出最终研究综述报告",
					Deliverable:      "研究综述（含：核心结论 / 证据链 / 反例与争议 / 不确定性 / 引用列表）",
					DefinitionOfDone: "核心结论清晰；至少 3 条独立来源支持；明确标注不确定性与反例；引用可点开",
					ExecutorRoleID:   "writer"},
			},
			Members: []TemplateMember{
				{RoleID: "researcher", Role: "研究员", Emoji: "🔬", SystemPrompt: "你像真正在查资料的人。先去找事实、来源、数字和原始表述，再回来汇报；不要没查就凭感觉下结论。"},
				{RoleID: "reviewer", Role: "审稿人", Emoji: "📝", IsDefaultReviewer: true, SystemPrompt: "你像一个刻薄但专业的审稿人。专门盯证据够不够硬、推理有没有跳步、来源是否可靠；不怕打断别人追问。"},
				{RoleID: "writer", Role: "综述员", Emoji: "📚", SystemPrompt: "你负责把已经得到的材料整理成可读结论。语气清楚、克制、像给真实同事写 brief；不要抢着先定论。"},
			},
		},
		{
			ID: "tutor", Name: "家庭教师", Category: "fun",
			Icon: "school", Tagline: "苏格拉底式提问 · 题库 · 讲解",
			Gradient: "from-green-400 via-emerald-500 to-teal-600",
			// reactive 策略：agent 不抢着说，等学生（人类）触发。chat preset 给
			// 轻松节奏；ReactiveMentionOnly 保留默认（不开）让老师在学生停留太久时
			// 还能主动引导一下。
			DefaultPolicy: PolicyReactive, PresetID: "chat", BudgetCNY: 8, Stars: 870,
			InitialPromptHint: "告诉老师你想学什么，或者贴一道题。",
			Members: []TemplateMember{
				{RoleID: "socrates", Role: "苏格拉底老师", Emoji: "🧓",
					SystemPrompt: "不直接给答案，通过反问引导学生自己思考。看学生答得如何，再决定要不要叫出题官或讲解员。"},
				{RoleID: "problem", Role: "出题官", Emoji: "📝",
					SystemPrompt: "只出题，不讲解。根据老师和学生刚才讨论的知识点，出 1 道相关练习题，要有明确答案。"},
				{RoleID: "explainer", Role: "讲解员", Emoji: "🎓",
					SystemPrompt: "只在学生卡住或要求解析时出场。基于上下文里已经出过的题，给 step-by-step 讲解。"},
			},
		},
		{
			ID: "war-room", Name: "危机作战室", Category: "ops",
			Icon: "military_tech", Tagline: "SRE + 产品 + 公关三线协同",
			Gradient: "from-red-600 via-orange-600 to-yellow-500",
			// moderator + deep：指挥官控场，复杂场景下需要保留完整时间线 + 事实链。
			DefaultPolicy: PolicyModerator, PresetID: "deep", BudgetCNY: 30, Stars: 290, SupportsProjection: true,
			// 危机现场场景动态，不预置 InitialTasks（指挥官按现场拆任务派发）。
			DefaultDispatchMode: TaskExecutionModeMemberAgent,
			InitialPromptHint:   "简述当前危机（系统宕机/舆情/...）。",
			Members: []TemplateMember{
				{RoleID: "commander", Role: "事件指挥官", Emoji: "⚓", IsModerator: true, IsDefaultReviewer: true, SystemPrompt: "主导决策节奏。"},
				{RoleID: "sre", Role: "SRE", Emoji: "🔧"},
				{RoleID: "pm", Role: "产品", Emoji: "📋"},
				{RoleID: "pr", Role: "公关", Emoji: "📢"},
			},
		},
		{
			// parallel-think —— v0.7+ 新增，专门承接 PolicyParallel 策略。
			// 场景：给一个问题，三个不同视角的 agent 同一轮各自独立给出方案，互相看不见彼此本轮输出，
			// 下一轮才暴露给对方。适合方案发散、避免"前一位定调子、后一位只能点头"。
			ID: "parallel-think", Name: "多方案并行", Category: "ops",
			Icon: "account_tree", Tagline: "三视角同时产出 · 后轮互评",
			Gradient: "from-indigo-400 via-purple-500 to-fuchsia-600",
			// parallel 策略：同一 trigger 下 fanout 个 agent 独立回复。brainstorm preset
			// 设定 ParallelFanout=4、低 highlights cap，突出"多条独立思路"。
			DefaultPolicy: PolicyParallel, PresetID: "brainstorm", BudgetCNY: 12, Stars: 0,
			InitialPromptHint: "例如：请各自独立给出一个方案，不要互相抄作业。",
			Members: []TemplateMember{
				{RoleID: "pragmatist", Role: "务实派", Emoji: "🛠️",
					SystemPrompt: "你只从可落地、低风险、短期收益角度给方案。不要追求新颖，先保证能跑。"},
				{RoleID: "innovator", Role: "激进派", Emoji: "🚀",
					SystemPrompt: "你只从颠覆、差异化、长期壁垒角度给方案。可以激进，但要说清前置条件。"},
				{RoleID: "analyst", Role: "分析派", Emoji: "📊",
					SystemPrompt: "你只从数据 / 指标 / ROI 量化角度给方案。每条建议都要能对应到可测指标。"},
			},
		},
	}
	for i := range list {
		list[i].MemberCount = len(list[i].Members)
	}
	return list
}

// FindTemplate 按 ID 查找。
func FindTemplate(id string) *Template {
	for _, t := range Templates() {
		if t.ID == id {
			tt := t
			return &tt
		}
	}
	return nil
}

func BuiltInRoleProfileSeeds() []database.AgentRoomRoleProfile {
	items := Templates()
	seen := map[string]database.AgentRoomRoleProfile{}
	order := make([]string, 0)
	sortOrder := 10
	for _, tpl := range items {
		for _, member := range tpl.Members {
			key := strings.TrimSpace(member.RoleID)
			if key == "" {
				key = strings.TrimSpace(member.Role)
			}
			if key == "" {
				continue
			}
			id := fmt.Sprintf("builtin_role_%s", key)
			current, exists := seen[id]
			if !exists {
				current = database.AgentRoomRoleProfile{
					ID:           id,
					Slug:         key,
					Name:         strings.TrimSpace(member.Role),
					Role:         strings.TrimSpace(member.Role),
					Emoji:        strings.TrimSpace(member.Emoji),
					Category:     strings.TrimSpace(tpl.Category),
					SystemPrompt: strings.TrimSpace(member.SystemPrompt),
					Model:        strings.TrimSpace(member.Model),
					AgentID:      strings.TrimSpace(member.AgentID),
					Thinking:     strings.TrimSpace(member.Thinking),
					IsModerator:  member.IsModerator,
					Stance:       strings.TrimSpace(member.Stance),
					Visibility:   "shared",
					SortOrder:    sortOrder,
				}
				if tpl.Tagline != "" {
					current.Description = fmt.Sprintf("默认来自模板「%s」：%s", tpl.Name, tpl.Tagline)
				} else {
					current.Description = fmt.Sprintf("默认来自模板「%s」", tpl.Name)
				}
				seen[id] = current
				order = append(order, id)
				sortOrder += 10
				continue
			}
			if current.Emoji == "" {
				current.Emoji = strings.TrimSpace(member.Emoji)
			}
			if current.SystemPrompt == "" {
				current.SystemPrompt = strings.TrimSpace(member.SystemPrompt)
			}
			if current.Model == "" {
				current.Model = strings.TrimSpace(member.Model)
			}
			if current.AgentID == "" {
				current.AgentID = strings.TrimSpace(member.AgentID)
			}
			if current.Thinking == "" {
				current.Thinking = strings.TrimSpace(member.Thinking)
			}
			if current.Stance == "" {
				current.Stance = strings.TrimSpace(member.Stance)
			}
			if current.Category == "" {
				current.Category = strings.TrimSpace(tpl.Category)
			}
			current.IsModerator = current.IsModerator || member.IsModerator
			if current.Description == "" && tpl.Name != "" {
				current.Description = fmt.Sprintf("默认来自模板「%s」", tpl.Name)
			}
			seen[id] = current
		}
	}
	out := make([]database.AgentRoomRoleProfile, 0, len(order))
	for _, id := range order {
		out = append(out, seen[id])
	}
	return out
}
