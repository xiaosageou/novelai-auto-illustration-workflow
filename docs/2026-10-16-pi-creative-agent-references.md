# 基于 pi 的文艺创作 Agent 参考项目检索

核查日期：2026-10-16。本文用于 `pi 导演 Agent → 独立 Prompt LLM → NAI → 视觉 QC → 复盘学习` 的架构参考。

## 本轮结论与阅读顺序

找到了真实使用 pi 的小说创作、分镜、多媒体画布及图像生成项目。最值得组合参考的是 **InkOS 的主 Agent/独立 worker 与上下文编译、pi-novel-scribe 的工具内局部创作调用、Pi-Paper 的媒体任务与画布集成、pi-self-learning 的复盘触发、Inngest 示例的策略评估与晋升**。这一阅读顺序是针对本项目需求作出的判断，不是运行效果排名。

| 优先级 | 项目 | 分类与真实接入 | 重点参考 | 主要边界 |
| --- | --- | --- | --- | --- |
| 高 | [InkOS](https://github.com/Narcooo/inkos) | pi-agent-core 创作系统 | 独立 worker、protected/compressible 上下文、审稿与局部修订、分镜 | 核查的是 2.0 开发快照；未发现完整 QC 经验晋升链 |
| 高 | [pi-novel-scribe](https://github.com/huangjien/pi-novel-scribe) | pi 扩展，工具内独立 complete | 当前任务信息包、Writer 与 Critic 分工 | Director 是规则路由，部分后续步骤仍由宿主模型遵守 |
| 高 | [Pi-Paper](https://github.com/wsjwu58-cmd/Pi-Paper) | pi-agent-core 多媒体画布 | 导演台、节点依赖、图像/视频任务、恢复与记忆候选 | 规则审校不等于视觉 QC，偏好记忆不等于复盘学习 |
| 高：学习层 | [pi-self-learning](https://github.com/mcollina/pi-self-learning) | pi 扩展，独立反思请求 | 任务结束触发、外部经验、限量注入 | 排名依据频率/新近度，缺少效果实验门槛 |
| 高：评估层 | [inngest-self-learning-agent](https://github.com/inngest/inngest-self-learning-agent) | 实际用 pi-ai，自建 Inngest loop | 异步评分、策略版本、统计、晋升与权重 | 通用助手示例；并非 pi-agent-core 主循环或图像盲评 |
| 中 | [pi-image-gen](https://github.com/abhishek944/pi-image-gen) | pi 图像/精灵图扩展 | provider 适配、能力约束、候选产物与确定性后处理 | 未见 NAI 专用适配；局部结构检查不等于剧情视觉 QC |
| 中 | [huangshihao/novel-agent](https://github.com/huangshihao/novel-agent) | pi SDK 小说应用 | 章级上下文工具、消费后裁剪、检查记录回传 | README 落后于代码；部分检查只记录、不强制阻断 |
| 专项观察 | [wanna-code12138/novel-agent](https://github.com/wanna-code12138/novel-agent) | pi SDK sidecar | 领域服务真源、版本指纹、提案确认 | 写审改 handler 尚有缺口；README 限定源码使用范围 |

补充检查了 pi-multimodal-router 与 Forge 的 learnings 包，见第 10 节。它们适合小模块参考。本轮没有找到已核实覆盖“小说切片 → 每张独立 NAI Prompt → 实际视觉 QC → 跨案例验证与策略晋升”全部环节的现成项目；这仅限本轮检索与源码范围。

需求基线见 [需求文档](2026-10-16-pi-nai-agent-requirements.md)。

## 核查方法与证据等级

- 使用 GitHub 官方 REST API 取得默认分支、当前 commit 和递归文件树，再通过固定 commit 的 raw 文件读取源码。
- **源码核对**：已经读取对应实现，可以解释调用关系；不代表运行验收通过。
- **README 自述**：保留为作者宣称，不将其等同于已实现或已验证。
- **静态推断**：根据已读取的调用路径判断，明确列出依据和边界。
- **测试源码核对**：阅读测试与替身实现；本轮未安装依赖、未执行仓库脚本、未运行测试、未调用模型或生图接口。
- 本轮的负面判断采用“核查路径未发现”口径，除非完整注册表和分发器足以确定某条调用缺失。

## 1. huangjien/pi-novel-scribe

项目：[GitHub 仓库](https://github.com/huangjien/pi-novel-scribe)。固定核查提交：[`4022ce4884d9a4f2f9ca5131af43d86f6070d9ce`](https://github.com/huangjien/pi-novel-scribe/tree/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce)。

### 1.1 定位与真实 pi 接入

**README 自述**：长篇小说创作 pi 扩展，包含 Director、Planner、Writer、Critic、Continuity；宣称 v0.1+/v0.2 阶段完成与 280 个测试通过。[README](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/README.md#L1-L25)

**源码核对**：这是实际的 pi 扩展。`package.json` 的 `pi.extensions` 指向 `extensions/index.ts`；`peerDependencies` 含 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`，以及未加 scope 的 pi 包，版本均为 `*`。入口使用 `ExtensionAPI` 注册领域工具和 `/novel` 命令。它没有在应用中自行 `createAgentSession`，运行循环依托宿主 pi。[package.json](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/package.json#L23-L48)、[扩展入口](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/index.ts#L20-L45)

### 1.2 Director 与 Writer 的分工

**源码核对**：`run_director` 读取 `config/route.yaml`，用 `matchRoute` 做确定性意图匹配；返回 primary/support agent、所需状态和下一步工具名。工具本身不执行下游工作，也没有独立的导演 LLM 会话。其返回文字要求宿主继续调用 `delegate_to_<primary>`。[Director 实现](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/orchestrator/director.ts#L18-L83)

`/novel write` 是直接打开编辑器的路径；其他 `/novel` 子命令通过 `pi.sendUserMessage` 把调度要求送进宿主工具循环。这意味着部分步骤仍依赖宿主 LLM 执行后续调用，不能将配置表中的状态要求直接视为强制执行闭环。[命令路由](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/index.ts#L148-L199)

**最贴近本项目讨论的实现**：Writer 作为一个工具，程序组装输入包，使用 `ctx.modelRegistry.complete(ctx.model, { systemPrompt, messages: [单个 user message] })` 发起独立生成请求；结果写到章节文件，宿主得到字数、路径和 Wiki 摘要。这个“宿主负责调用，专职 LLM 使用局部输入完成创作”的模式，可以映射到独立 Prompt LLM。[Writer 生成路径](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/agents/writer.ts#L64-L145)

需要注意，Writer 直接采用宿主当前模型 `ctx.model`，不等于已经实现每个角色单独选模型。其子调用也不是持久化子 Agent。[同上](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/agents/writer.ts#L105-L112)

### 1.3 上下文与连续性

**源码核对**：Writer 的 packet 包含章节编号、POV、计划、POV 人物资料、Wiki references、用户附加说明；它没有默认附入主会话全部历史。基础场景包从章节 frontmatter、`@scene` 和人物 profile 读取。[场景上下文](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/novel/context.ts#L52-L83)、[Writer packet](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/agents/writer.ts#L153-L188)

Planner 的输入更宽：人物 profiles、活跃剧情线、已有计划、已批准章节数，以及最近已批准章节正文的末尾 500 个字符。它是显式构造的连续性快照，不能将其描述为完整跨章记忆。[Planner 上下文](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/novel/plan-context.ts#L58-L82)、[末尾截取](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/novel/plan-context.ts#L140-L145)

**与 README 有差异**：README 概括称四个角色均调用 `complete()`；当前 Continuity 源码的 inspect/investigate/refresh 路径实际调用场景派生、差异检查和 `refreshCharacterBeliefs`，已读路径没有 LLM 请求。因此更准确的说法是“规划、写作、审稿使用独立 LLM 请求；Continuity 在当前路径承担程序化状态派生”。[Continuity 工具](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/agents/continuity.ts#L50-L97)、[连续性派生](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/novel/continuity.ts)

**可借鉴但需补强**：Writer 的 packet 设计适合用于生成局部 Prompt；我们还应明确补入原文引用、人物服装及物件归属、相邻画面、用户硬要求和版本指纹，避免只缩短输入却丢失必要事实。此项属于本项目架构建议。

### 1.4 审稿、人类反馈与流程门槛

**源码核对**：Critic 使用独立 `complete()` 请求，生成带 `category/severity/evidence/impact/recommendation/pattern_ref` 的结构化审稿结果，写回章节 review。它不是专门的学习 Agent。[Critic 生成与写回](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/agents/critic.ts#L31-L115)

Canon Change 支持先创建 `.yaml.draft`，再通过编辑器审批；`decideOutcome` 根据是否保存、前后内容是否一致，区分 approved、approved-as-stated、rolled-back。这提供了“模型提案、人类确认、再进入权威状态”的参考。[Canon 工具](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/index.ts#L47-L145)、[审批判定](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/editor/gate.ts#L19-L73)

**静态边界**：有状态迁移图不等于每次写入都受图约束。`transitions.ts` 定义 `canTransition`；但 Writer 在拿到结果后直接 `writeFileSync` 覆盖章节，再调用 `applyStatus(..., "human_editing")`；`applyStatus` 本身只是读写状态，并不检查迁移合法性。不能照搬其写入方式作为我们的生产门槛。[迁移图](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/workflow/transitions.ts#L29-L79)、[Writer 写入](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/agents/writer.ts#L114-L123)、[状态写入工具](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/workflow/status.ts)

### 1.5 学习优化层：有经验检索，没有查到失败复盘自优化闭环

**源码核对**：Wiki 提供按角色选表、根据场景生成 query、缓存与 rerank 预算、默认 top 5 引用；Writer/Planner/Critic 读不同类型参考。[Wiki 注入](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/wiki/context.ts#L26-L81)、[检索注入与降级](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/wiki/context.ts#L170-L214)

数据库以 `readOnly: true` 打开，默认指向作者本机的外部 snapshot 路径；未附带一个可开箱使用的完整参考数据库。检索失败降级为 `null + warning`。[数据库路径与只读访问](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/extensions/wiki/db.ts)

**结论**：该项目可参考“有限条目检索 → 按角色注入”，但已核查路径没有“QC/人类反馈 → 案例复盘 → 候选经验 → 回归验证 → 启用/退役”的实现。故事事实刷新和写作模板检索，不等同于学习优化。

### 1.6 测试与可运行性边界

**测试源码核对**：`tests/smoke.test.ts` 明确使用 FakePi 和 mocked `ModelRegistry.complete`，未调用真实模型、编辑器或网络。只能支持结构性测试意图，不能支持长篇真实创作效果。[Smoke 测试](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/tests/smoke.test.ts#L1-L23)、[mock 响应](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/tests/smoke.test.ts#L63-L87)

另一个待运行验证的问题：smoke 要求 `examples/novel-scribe-demo` 下的多个 fixture 存在，但本轮取得的固定 commit 递归文件树未列出 `examples/`。因此 README 的测试全通过数字不能视为本轮可复现结论，干净检出后的测试仍需另行验证。[测试的 fixture 假设](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/tests/smoke.test.ts#L63-L66)、[固定提交文件树](https://api.github.com/repos/huangjien/pi-novel-scribe/git/trees/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce?recursive=1)

### 1.7 许可证与适用判断

README 和 package 声明 MIT；GitHub API 的 license 字段为 null，固定文件树未发现独立 LICENSE 文件。本文记录为“作者声明 MIT，许可证正文需补核”。[README 许可证声明](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/README.md#L107-L109)、[package 声明](https://github.com/huangjien/pi-novel-scribe/blob/4022ce4884d9a4f2f9ca5131af43d86f6070d9ce/package.json#L1-L11)

**参考价值**：高，尤其是“宿主编排 + 局部生成请求 + 领域上下文 packet + 按角色检索”。**适合作为模式参考，暂不视为经过真实运行验证的成品底座。**

## 2. wanna-code12138/novel-agent

项目：[GitHub 仓库](https://github.com/wanna-code12138/novel-agent)。固定核查提交：[`ca45c7f1595ff18b3b0d04931c04b641af54864d`](https://github.com/wanna-code12138/novel-agent/tree/ca45c7f1595ff18b3b0d04931c04b641af54864d)。

### 2.1 定位与真实 pi 接入

**README 自述**：本地优先的小说创作工作台，包含 Story Bible、写审改、版本管理、Web GUI，并通过受管 pi SDK sidecar 实现一句话立项和待确认提案。[README](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/README.md#L71-L115)

**源码核对**：TypeScript sidecar 固定依赖 `@earendil-works/pi-coding-agent: 0.84.2`，实际调用 `createAgentSession`、`ModelRuntime`、`SessionManager`、`DefaultResourceLoader`。Python 提供作品存储与领域 action；双方通过子进程 stdin/stdout 协议传递请求、action 与事件。[sidecar 依赖](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/sidecar/package.json#L16-L19)、[SessionHost](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/sidecar/src/session.ts#L1-L18)、[Python sidecar 管理](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/agent/sidecar.py)

这是真实的 SDK 嵌入项目，不只是 Skill 或命令提示词包装。

### 2.2 遵守性控制：领域动作替代通用文件工具

**源码核对**：`buildToolPolicy` 禁用所有 built-in tools，仅开放领域工具；资源加载器关闭扩展、Skills、prompt templates、themes 和 context files，system prompt 由应用固定构造。[工具策略](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/sidecar/src/session.ts#L47-L59)、[资源加载策略](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/sidecar/src/session.ts#L84-L99)

工具携带结构化 schema、`executionMode: "sequential"`，向 Python action bridge 发请求；写入提案要求 input fingerprint 和 expected version。`commit_proposal` 在 Python 侧强制要求 human actor，并检查当前 fingerprint 和资产版本。这里的约束有代码执行依据。[工具桥接](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/sidecar/src/tools.ts#L167-L200)、[提案与确认实现](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/actions/project.py#L96-L179)

**对 NAI 项目的直接启发**：将“读取当前简报、生成 Prompt、生成候选、提交 QC、登记反馈、推进状态”做成领域工具，并由业务服务检查输入版本及状态，能比单靠 Skill 提醒更可靠。此项是本项目建议。

### 2.3 多角色声明与实际贯通范围

**源码核对**：system prompt 定义 planner/writer/critic/rewriter 四种角色。它自称“单 Agent 多角色运行时”，不等于已经实现持续导演调度多个独立创作 Agent。[角色提示词](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/sidecar/src/prompts.ts#L1-L19)

当前 Python 的 `create_from_idea` 创建 Planner run；`_execute_run` 固定读取 `role_name = "planner"` 的模型配置，再将 run.role 传给 sidecar。主要贯通入口是 Planner 提案链路。[创建与启动入口](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/agent/service.py#L88-L118)、[会话创建及完成判定](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/agent/service.py#L223-L287)

**确定缺口**：TypeScript 注册 10 个领域工具，但 Python `project_action_handlers()` 只注册 6 个，缺少 `write_chapter_draft`、`submit_critic_verdict`、`submit_change_set`、`scan_consistency`；dispatcher 对没有 handler 的 action 返回 `UNKNOWN_ACTION`。因此本提交的工具表不能作为“写审改已经全部基于 pi 贯通”的证据。[TS 工具表](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/sidecar/src/tools.ts#L9-L20)、[Python handler 注册表](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/actions/project.py#L55-L63)、[未知 action 分支](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/actions/dispatcher.py#L27-L57)

### 2.4 上下文、会话与恢复

**源码核对**：pi session 创建时使用 `SessionManager.create`；恢复时 `SessionManager.open`。订阅消息增量、工具调用、usage、session 节点等事件，由 Python 持久化任务状态。[Session 持久化与创建](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/sidecar/src/session.ts#L130-L170)、[事件转发](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/sidecar/src/session.ts#L196-L239)

领域 `assemble_context` 将 Python 的结构化上下文返回给 Agent。分层顺序为 author intent/current focus、resident、outline、recent、constraints、retrieval；按粗估 token 和优先级整项裁剪，并报告 dropped。最近两章优先正文，之前至多十章用摘要。[预算及裁剪](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/memory/assembler.py#L10-L101)、[历史章节选择](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/memory/assembler.py#L142-L179)

**已读实现限制**：人物常驻片段只提供姓名与 role；事实约束过滤为 `established_at == chapter_id`；retrieval 仍是空 placeholder。默认预算为 256k，而 sidecar 未显式传入模型上下文时默认 128k，已读 action 没有把模型实际预算传进 assembler。这些都需要后续补齐，不能将“分层上下文”直接理解为完整的相关性检索与预算闭环。[人物、事实与检索占位](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/memory/assembler.py#L104-L198)、[action 调用 assembler](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/actions/project.py#L74-L93)、[sidecar 模型预算](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/sidecar/src/session.ts#L112-L121)

### 2.5 审改与人类反馈：已有两条不同路径

**源码核对**：pi 提案链路支持编辑提案、人工 commit、reject，并把等待审批的 run 推进到完成；这里记录的是资产确认结果。[提案操作](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/agent/service.py#L170-L220)

另有独立 Python `run_chapter_loop`：Writer 流式生成 → 格式门 → LLM Critic → 最多 3 轮修改，下一轮注入 previous issues。它直接调用 Python LLM client，没有通过 pi 的 AgentSession。这是局部返修机制，需与 pi Planner 区分。[写审改路径](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/pipeline/loop.py#L46-L164)

**不宜照搬的行为**：超过修改轮次后仍会 `_settle_chapter` 写正式正文，返回 success=false；Critic 请求只带当前 draft，未附前面 assembled 的事实与人物上下文；下一轮主要带问题清单，没有显式带上一稿进行定向编辑。其摘要结算只是“正文已生成、评分多少”的状态句。它们不足以保证跨章叙事连续性。[Critic 输入](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/pipeline/loop.py#L116-L129)、[轮次用尽和摘要结算](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/pipeline/loop.py#L166-L211)

### 2.6 学习优化层：局部返修，未发现跨案例学习

已核查的 pipeline 会保存本次 run 的 score/issues，重复利用本次失败反馈；提案系统会保存接受/拒绝状态。[run manifest](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/src/novel_agent/pipeline/loop.py#L214-L234)

在已核查的 prompts、tools、session、agent service、action、assembler、pipeline 路径中，未发现独立复盘 Agent，也未发现将多个失败案例合并成候选经验、回归评估和启用新策略版本的链路。把当前反馈放进下一轮改稿，与我们讨论的学习优化层仍有明显距离。

### 2.7 测试与运行证据

**测试源码核对**：`tests/integration/test_pi_agent_flow.py` 使用 `FakePlannerSidecar` 驱动 HTTP → 提案 → 确认 → 重新打开，验证的是持久化应用链路；不是 Node pi runtime 加真实模型的 E2E。[集成测试的替身依赖](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/tests/integration/test_pi_agent_flow.py#L6-L16)、[Fake sidecar 注入](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/tests/integration/test_pi_agent_flow.py#L56-L69)

sidecar 的 session 测试检查工具策略与错误脱敏，没有启动真实 `SessionHost.create()` 并完成模型工具循环。本轮也未执行任何测试。[sidecar session 测试](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/sidecar/tests/session.test.ts#L1-L37)

### 2.8 许可证与适用判断

**README 明示**：公开源码仅供查看，未授予复制、修改、分发或商业使用许可。应作为架构观察与独立实现的参考，不列为可直接移植的开源代码依赖。[许可证原文](https://github.com/wanna-code12138/novel-agent/blob/ca45c7f1595ff18b3b0d04931c04b641af54864d/README.md#L165-L168)

**参考价值**：很高，尤其是“现有业务服务掌握真源 + pi SDK sidecar + 领域工具 + 指纹/版本检查 + 持久化事件和恢复”。**主要参考其边界设计；写审改尚未全部迁入 pi，学习层仍需自行设计。**

## 3. 两项已核查项目的初步对照

| 对照项 | pi-novel-scribe | wanna-code12138/novel-agent |
|---|---|---|
| pi 使用方式 | 宿主 pi 扩展 | 嵌入 SDK 的 TS sidecar |
| 创作模型调用 | 工具内独立 `complete()` | pi Planner 工具循环；Python 另有写审改 client |
| 导演含义 | 规则表路由工具 | 未见持续导演；Planner 是主要 pi 入口 |
| 局部上下文 | 按角色程序化 packet | 分层、优先级裁剪的 context assembler |
| 强制业务边界 | 有部分校验，状态迁移未统一强制 | Python action、fingerprint、expected version、人工确认 |
| 连续性 | 场景/人物派生 + 外部 Wiki | Story Bible + 近章正文/摘要，检索尚占位 |
| 人类反馈 | 编辑器保存/撤回、Canon 审批 | 编辑/确认/拒绝提案，资产版本管理 |
| 学习层 | 参考库检索；未见失败复盘晋升 | 本次返修和 manifest；未见跨案例经验晋升 |
| 本轮运行验证 | 未运行；smoke 使用 mock 且 fixture 待补核 | 未运行；集成测试使用 fake sidecar |
| 代码使用许可 | README/package 声明 MIT，正文待补核 | README 明示未授予复制修改等许可 |

本表为上文两个小说项目的专项汇总，不追加新的运行效果主张。其它项目与综合建议见下文。

## 4. Narcooo/inkos：主 Agent、独立 worker 与专业创作内核

- 固定快照：[`8fc2ae57080b9821257dee3e37cc677e2b6f389a`](https://github.com/Narcooo/inkos/tree/8fc2ae57080b9821257dee3e37cc677e2b6f389a)，默认分支 master，提交于 2026-09-26 UTC。
- 当前源码为 2.0.0 开发版本。core/package.json 固定 `@mariozechner/pi-agent-core` 与 `pi-ai` 为 0.67.1，声明 `AGPL-3.0-only`。[依赖与许可](https://github.com/Narcooo/inkos/blob/8fc2ae57080b9821257dee3e37cc677e2b6f389a/packages/core/package.json)

### 已核对的实现

| 能力 | 源码证据 | 对本项目的用途 |
| --- | --- | --- |
| 持续主 Agent | [agent-session.ts](https://github.com/Narcooo/inkos/blob/8fc2ae57080b9821257dee3e37cc677e2b6f389a/packages/core/src/agent/agent-session.ts) 实例化 Agent，恢复 transcript，订阅事件，调用 prompt/continue | 导演会话和业务存储之间的协作 |
| 独立 worker | [worker-agent.ts](https://github.com/Narcooo/inkos/blob/8fc2ae57080b9821257dee3e37cc677e2b6f389a/packages/core/src/agent/worker-agent.ts) 使用空历史的新 Agent；结构化任务由唯一结果工具提交，有限纠错 | 独立 Prompt 请求与 schema 交接 |
| 上下文编译 | [context-compiler.ts](https://github.com/Narcooo/inkos/blob/8fc2ae57080b9821257dee3e37cc677e2b6f389a/packages/core/src/harness/context-compiler.ts) 区分 protected/compressible；保护片段超预算报错，压缩结果校验来源与预算 | 原文事实和用户要求不随意被压缩丢失 |
| 会话上下文治理 | [agent-context.ts](https://github.com/Narcooo/inkos/blob/8fc2ae57080b9821257dee3e37cc677e2b6f389a/packages/core/src/harness/agent-context.ts) 保护近期用户请求和工具交换，处理闭合的旧交换 | 控制导演上下文增长 |
| 创作资料检索 | [memory-retrieval.ts](https://github.com/Narcooo/inkos/blob/8fc2ae57080b9821257dee3e37cc677e2b6f389a/packages/core/src/utils/memory-retrieval.ts) FTS5/BM25 加语义选择、来源与 trace | 按当前场景检索故事状态和参考资料 |
| 分镜与图像 Prompt | [script-storyboard.ts](https://github.com/Narcooo/inkos/blob/8fc2ae57080b9821257dee3e37cc677e2b6f389a/packages/core/src/agents/script-storyboard.ts) 通过 worker 提交分镜与有序 imagePrompts | 分镜结构与创作 worker 的接口 |

审稿 worker 需要编号原文证据；reviser 接收观察、人类指令和权威 context package。生产 runner 的 reviseDraft 会恢复持久化简报，合并人类要求，再做修订及状态校验。[continuity.ts](https://github.com/Narcooo/inkos/blob/8fc2ae57080b9821257dee3e37cc677e2b6f389a/packages/core/src/agents/continuity.ts)、[reviser.ts](https://github.com/Narcooo/inkos/blob/8fc2ae57080b9821257dee3e37cc677e2b6f389a/packages/core/src/agents/reviser.ts)、[runner.ts](https://github.com/Narcooo/inkos/blob/8fc2ae57080b9821257dee3e37cc677e2b6f389a/packages/core/src/pipeline/runner.ts)

### 边界与采用建议

- 新章默认路径是生成、审稿观察、落盘；审改能力可显式调用，不能概括为自动反复修到通过。
- 分镜和整组 imagePrompts 同一 worker 提交，仍需改造为本项目要求的每张局部 Prompt 调用。
- 章节摘要、伏笔和卷摘要检索是故事记忆。在核查的 277 个 core 非测试 TS 文件及相关路径中，未发现跨失败案例归因、经验实验和策略晋升的完整链路。
- 本轮没有运行真实创作、模型或图像请求。

**建议**：优先阅读 worker-agent 和 context-compiler，借鉴结构化交接、权威状态与上下文分级。涉及实际复用代码时按其 AGPL-3.0-only 许可另行核对；当前仅作架构研究。

## 5. wsjwu58-cmd/Pi-Paper：媒体画布与任务运行时

- 固定快照：[`6491cd8805d358bba05c8ebc443252940b8c2c2d`](https://github.com/wsjwu58-cmd/Pi-Paper/tree/6491cd8805d358bba05c8ebc443252940b8c2c2d)，默认分支 `feat/desktop-local-migration`，提交于 2026-10-15 UTC。
- 根 LICENSE 为 MIT。Agent service 依赖 `@earendil-works/pi-agent-core` 与 `pi-ai ^0.84.3`。[LICENSE](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/LICENSE)、[package.json](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/pi-main/packages/vibepaper-agent-service/package.json)

### 已核对的实现

- [drama-agent.ts](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/pi-main/packages/vibepaper-agent-service/src/pi/drama-agent.ts) 实际 new Agent，注入领域工具、会话和上下文变换；[agent-runtime.ts](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/pi-main/packages/vibepaper-agent-service/src/application/agent-runtime.ts) 订阅并调用 prompt/continue。
- [tool-manifest.ts](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/pi-main/packages/vibepaper-agent-service/src/domain/tool-manifest.ts) 定义画布摘要、节点详情、创建/连接节点、修改配置、提交生成、查询状态等领域工具。
- [runtime-tools.ts](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/pi-main/packages/vibepaper-agent-service/src/tools/runtime-tools.ts) 实际操作持久化节点；[local-tool-gateway.ts](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/pi-main/packages/vibepaper-agent-service/src/desktop/local-tool-gateway.ts) 检查能力、创建任务、读取状态。
- [generation-worker.cjs](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/pi-paper-desktop/src/generation-worker.cjs) 有图像、视频和其它 provider 的执行路径，下载并保存结果；任务完成后通过 [续跑提示](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/pi-main/packages/vibepaper-agent-service/src/application/task-continuation-prompt.ts) 恢复工作。
- [agent-worker.cjs](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/pi-paper-desktop/src/agent-worker.cjs) 有上下文规划、摘要和会话持久化逻辑。
- [scoped-memory.ts](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/pi-main/packages/vibepaper-agent-service/src/desktop/scoped-memory.ts) 对记忆候选保存 scope、来源、置信度和 pending 状态，支持接受或驳回。

### 必须区分的能力

- [memory-candidate-extractor.ts](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/pi-main/packages/vibepaper-agent-service/src/application/memory-candidate-extractor.ts) 实际按“记住、以后都要、默认使用、我偏好”等显式语句提取候选；普通生成结果不产生候选。这是偏好记忆，不是 QC 失败复盘。
- [render-audit-service.ts](https://github.com/wsjwu58-cmd/Pi-Paper/blob/6491cd8805d358bba05c8ebc443252940b8c2c2d/pi-main/packages/vibepaper-agent-service/src/application/render-audit-service.ts) 调用规则 evaluateContinuity 并可附建议，不能当成已实际读取图片的视觉 QC。
- withAuthoritativePrompt 接受 Prompt 或从节点及上游提取文字，未核实到强制的单张独立 Prompt LLM 接口。
- 尚未核实 NAI 专用人物段和标签编写机制；本轮未运行桌面端或真实模型。

**建议**：优先借鉴领域网关、显式节点依赖、任务终态续跑和有作用域的候选记忆。画布形式可选，值得借用的是依赖与产物身份，不必为采用 pi 重做现有预览台。

## 6. mcollina/pi-self-learning：事件触发的独立反思

- 固定快照：[`e0d76a93195b11b688ca71da8a8b5700c6541542`](https://github.com/mcollina/pi-self-learning/tree/e0d76a93195b11b688ca71da8a8b5700c6541542)，main，2026-06-15 UTC，版本 0.5.0。
- [package.json](https://github.com/mcollina/pi-self-learning/blob/e0d76a93195b11b688ca71da8a8b5700c6541542/package.json) 通过 pi.extensions 加载扩展，peer dependency 为旧 scope 的 pi-coding-agent >=0.50.0；声明 MIT，GitHub 元数据未识别到独立 LICENSE。

[self-learning.ts](https://github.com/mcollina/pi-self-learning/blob/e0d76a93195b11b688ca71da8a8b5700c6541542/extensions/self-learning.ts) 已实现：

1. agent_end 时检查完成/中止状态，满足条件则自动反思；也有手动 learning-now。
2. reflectNow 使用独立 complete 请求，可配置反思模型。
3. 保存 daily、long-term-memory、core/CORE.md、core/index.json，支持月总结及重新提炼。
4. before_agent_start 注入受长度控制的经验。
5. 依据频率、新近度和衰减排序核心经验。

**参考价值**：它直接回答“学习层如何独立调用、何时触发、怎样外部存储并回注”。但它不是一个带工具循环的常驻复盘 Agent，而是扩展事件触发的独立 LLM 反思。

**需要补上的部分**：出现频率不等于策略有效性。已读路径没有固定图像评估集、多 seed 实验、经验通过质量门槛后再晋升的实现。默认会为独立记忆 Git 仓库自动 commit；本项目若采用类似逻辑，需保持当前用户关于 Git 操作的约定。本轮未安装该扩展，也未创建任何记忆仓库或提交。

**触发器建议**：本项目应使用“返修链完成、批次完成、人类反馈已落实”等业务事件作为主要触发。pi 的 agent_end 只能提供运行层边界，不应直接替代付费任务完成和交付验收。

## 7. inngest/inngest-self-learning-agent：策略版本与晋升

- 固定快照：[`28f4c9776548a7576d9cc554ad4d687d735d2805`](https://github.com/inngest/inngest-self-learning-agent/tree/28f4c9776548a7576d9cc554ad4d687d735d2805)，main，2026-04-15 UTC，Apache-2.0。
- 分类：使用 pi-ai 的通用学习助手示例。package 虽有 pi-agent-core/coding-agent 依赖，但 [agent-loop.ts](https://github.com/inngest/inngest-self-learning-agent/blob/28f4c9776548a7576d9cc554ad4d687d735d2805/src/agent-loop.ts) 的主流程是自建 while + Inngest step；[llm.ts](https://github.com/inngest/inngest-self-learning-agent/blob/28f4c9776548a7576d9cc554ad4d687d735d2805/src/lib/llm.ts) 调 pi-ai complete。不能归类为直接复用 pi Agent loop 的文艺产品。

### 已核对的优化链

- [score.ts](https://github.com/inngest/inngest-self-learning-agent/blob/28f4c9776548a7576d9cc554ad4d687d735d2805/src/functions/score.ts)：回复后异步评分，并关联当时的 Prompt 版本。
- [evaluate-prompts.ts](https://github.com/inngest/inngest-self-learning-agent/blob/28f4c9776548a7576d9cc554ad4d687d735d2805/src/functions/evaluate-prompts.ts)：定时读取成绩、按版本统计、晋升优胜策略、淘汰版本、重写低表现策略、保存注册表。
- [evaluation.ts](https://github.com/inngest/inngest-self-learning-agent/blob/28f4c9776548a7576d9cc554ad4d687d735d2805/src/lib/evaluation.ts)：按样本量和平均复合分差决定晋升；[prompt-version.ts](https://github.com/inngest/inngest-self-learning-agent/blob/28f4c9776548a7576d9cc554ad4d687d735d2805/src/lib/prompt-version.ts) 按权重选择策略版本。
- [config.ts](https://github.com/inngest/inngest-self-learning-agent/blob/28f4c9776548a7576d9cc554ad4d687d735d2805/src/config.ts) 默认每 6 小时评估、最低 10 条数据。这是参考项目配置，不代表本项目已配置或应照搬这一频率。

**借鉴方式**：采用事件、版本、样本量、成绩和晋升结构；不把其模型自评分直接用作 NAI 质量依据。此例的在线任务分布并非严格配对固定评估集，尚需加入本项目要求的同场景、多 seed、人类评价、反例与回滚验证。本轮未部署或创建定时任务。

## 8. abhishek944/pi-image-gen：图像与精灵图生成扩展

- 固定快照：[`aabb574a3e9fa0b3bd53f2530919064b4764abee`](https://github.com/abhishek944/pi-image-gen/tree/aabb574a3e9fa0b3bd53f2530919064b4764abee)，main，2026-10-04 UTC，版本 0.4.2，Apache-2.0。
- [package.json](https://github.com/abhishek944/pi-image-gen/blob/aabb574a3e9fa0b3bd53f2530919064b4764abee/package.json) 声明 pi 扩展与 Skills；pi-ai/coding-agent 的开发依赖为 0.80.10。

[extension.ts](https://github.com/abhishek944/pi-image-gen/blob/aabb574a3e9fa0b3bd53f2530919064b4764abee/src/extension.ts) 实际注册 image_generate 与可选 sprite_generate。工具 schema 根据当前 provider 能力生成，模型和 provider 由项目设置固定，不由每次工具调用随意切换；生成结果落盘，返回路径与结构化 details。

[sprite/pipeline.ts](https://github.com/abhishek944/pi-image-gen/blob/aabb574a3e9fa0b3bd53f2530919064b4764abee/src/sprite/pipeline.ts) 保存实际使用 Prompt，调用一次图片生成，保留 raw sheet，再做切帧、归一化、检查和 APNG 编码；保存 pipeline-meta。处理失败时尽量保留已经付费取得的结果，未设置自动重新生成循环。

[sprite/raster.ts](https://github.com/abhishek944/pi-image-gen/blob/aabb574a3e9fa0b3bd53f2530919064b4764abee/src/sprite/raster.ts) 的 QC 是程序化图像检查：透明度、空帧、裁切、轮廓重复、运动突变和循环衔接等。它不是人体、角色身份或剧情相容性的视觉语义 QC。

**建议**：参考生成适配器、能力契约、阶段进度、原始产物保留和后处理记录。已读 provider 列表没有 NAI 专用适配；NAI 仍需独立实现。本轮未运行图像生成或精灵图流水线。

## 9. huangshihao/novel-agent：章级信息包与消费后裁剪

- 固定快照：[`616af9a4eb68893bffadc32f97b32d8afb41264d`](https://github.com/huangshihao/novel-agent/tree/616af9a4eb68893bffadc32f97b32d8afb41264d)，main，2026-07-07 UTC。GitHub 元数据未识别许可证，本轮不据此假定代码可移植。
- [README](https://github.com/huangshihao/novel-agent/blob/616af9a4eb68893bffadc32f97b32d8afb41264d/README.md) 仍写 pi、大纲及正文接入未完成；但 [agent-server/package.json](https://github.com/huangshihao/novel-agent/blob/616af9a4eb68893bffadc32f97b32d8afb41264d/packages/agent-server/package.json) 已依赖 pi core/ai/coding-agent ^0.64.0，源码也有真实调用。因此不按旧 README 排除它。

### 已核对的实现

- [chat-session.ts](https://github.com/huangshihao/novel-agent/blob/616af9a4eb68893bffadc32f97b32d8afb41264d/packages/agent-server/src/agents/chat-session.ts) 调用 createAgentSession、SessionManager.create/open；关闭 Skills、扩展和模板发现，使用空内建工具与自定义小说工具。
- 同文件安装 transformContext，裁剪已经消费的 outline context 工具结果，并清理部分无产出的消息。这是“完整产物保存在外部，主上下文只保留当前所需内容”的具体参考。
- [get-chapter-context.ts](https://github.com/huangshihao/novel-agent/blob/616af9a4eb68893bffadc32f97b32d8afb41264d/packages/agent-server/src/agents/tools/get-chapter-context.ts) 组装大纲、人物映射、最近三章、角色和伏笔状态、节奏指引、文风与上章检查结论。
- [self-check.ts](https://github.com/huangshihao/novel-agent/blob/616af9a4eb68893bffadc32f97b32d8afb41264d/packages/agent-server/src/agents/tools/self-check.ts) 保存检查记录，再由后续章节上下文回显。

### 边界与用途

selfCheck 描述明确是非阻断工具，执行返回 ok:true，即使没有 commit 记录也通过 warning 提示；“先查证、再自检、事实矛盾必须修”等部分依靠 promptGuidelines。它适合说明如何传递反馈，也提醒我们：写在工具说明里的要求，仍需决定是否由服务强制执行。

本轮仅核查上述会话和工具路径，不宣称整个分析、改编、正文与审核产品已完整验收；未运行其测试或真实创作。

## 10. 补充模块：多模态路由与经验档案

### 10.1 liuzhihaotina/pi-multimodal-router

- 快照：[`681c12a044c4616166dc2da062254df90736b745`](https://github.com/liuzhihaotina/pi-multimodal-router/tree/681c12a044c4616166dc2da062254df90736b745)，main，2026-08-09 UTC，版本 0.2.0，MIT。
- [index.ts](https://github.com/liuzhihaotina/pi-multimodal-router/blob/681c12a044c4616166dc2da062254df90736b745/index.ts) 给无视觉模型的输入先调用视觉分析，再将结果注入为文本，并注册图像生成工具。
- [router.ts](https://github.com/liuzhihaotina/pi-multimodal-router/blob/681c12a044c4616166dc2da062254df90736b745/src/providers/router.ts) 有 provider 图像能力映射与失败后切换 SiliconFlow 的实现。
- 视频、语音、PDF 入口在 index.ts 仍是 TODO；package 的 test 是 No tests yet。适合了解文本主 Agent 加视觉工具的简单接法，不作为视频创作系统成熟度证据。
- 对本项目的启发：导演和视觉模型可以独立配置，但 QC 应保留原图、分析来源与版本，不能只把一段图片摘要当完整证据；自动 provider fallback 也需改为受控预算和明确模型记录。

### 10.2 Firstp1ck/pi-coding-agent-forge 的 pi-package-learnings

- 整库快照：[`c1ea0b122fad64c3250a2dff0478d1f47f32bfe5`](https://github.com/Firstp1ck/pi-coding-agent-forge/tree/c1ea0b122fad64c3250a2dff0478d1f47f32bfe5)，main，2026-10-15 UTC；learnings 子包有 MIT LICENSE。
- [index.ts](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/c1ea0b122fad64c3250a2dff0478d1f47f32bfe5/pi-package-learnings/index.ts) 注册 learnings_search、learnings_read、learnings_add、learnings_sync；新增记录包含 issue、tried、solution、verification。
- [README](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/c1ea0b122fad64c3250a2dff0478d1f47f32bfe5/pi-package-learnings/README.md) 与 [Skill](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/c1ea0b122fad64c3250a2dff0478d1f47f32bfe5/pi-package-learnings/skills/learnings/SKILL.md) 描述在解决问题后保存案例，并先读摘要再查原始记录。
- 属于可检索的排障经验档案，不是独立自动复盘或实验晋升系统。默认 setup 使用 Bash、Python、符号链接和 systemd user timer，面向 Linux；Windows 只能参考信息结构，调度和路径需重写。本轮未执行其安装或定时配置。

## 11. 对 NAI 需求的综合映射

以下为基于本轮源码的设计推论，并非这些项目已替本项目验证效果。

| 本项目需求 | 首选参考 | 仍需独立实现 |
| --- | --- | --- |
| 有状态导演与局部创作请求 | InkOS、pi-novel-scribe | 单张画面简报、NAI 专用 Prompt 写作与语义校验 |
| 减少主会话上下文堆积 | InkOS、huangshihao/novel-agent | 当前场景的相关性、事实保护和工具结果摘要策略 |
| 将 Skill 要求变成可执行约束 | Pi-Paper、wanna-code12138/novel-agent | QC、反馈、次数和完成状态的服务端条件 |
| 图像产物、任务与续跑 | Pi-Paper、pi-image-gen | NAI 请求幂等、在途追踪、收费超时核对与项目数据绑定 |
| 实际看图及逐图返修 | 参考各项目的版本与审稿组织方式 | 图像内容进入视觉模型、场景相容性、人物/人体检查及证据 |
| 人类意见与记忆作用域 | Pi-Paper | 反馈落实链、作品偏好与技术经验的分离 |
| 独立复盘触发与外部经验 | pi-self-learning、Forge learnings | 基于返修链的归因、失败与成功配对、冲突经验管理 |
| 策略版本与验证晋升 | Inngest 示例 | 配对生图、多 seed、固定与留出场景、人类评价及回滚 |

建议不直接 fork 一个小说项目当总工程。先保持既有原文、场景、候选、QC 和预览数据边界，参考上述实现建立少量领域接口。第一版可从 pi SDK 会话或 pi-agent-core 中选一种主运行时；不要同时维护两套自然语言调度循环。

学习层建议拆成两个逻辑能力：**案例复盘与经验候选**、**评估与策略生效**。前者可通过独立 LLM 请求完成，后者主要由确定性程序与独立质量评价完成；是否需要持续工具循环，按任务复杂度决定。

## 12. 本轮验证范围与后续阅读入口

- 已检索小说、创意写作、分镜、图像、视频与学习扩展，排除仅为 pi 镜像、同名数学符号、树莓派或只在介绍中提及 pi 的结果。
- 已使用一手仓库、固定提交源码、依赖、注册表和调用路径核查上文项目；源码审阅不等同运行或业务验收。
- 没有安装参考项目、执行其脚本、创建服务/定时器、发起付费模型请求、变更生产记录或进行 Git commit/push。
- 本轮参考选择不依赖星数或 README 中测试通过数；未运行的 mock/fake 测试不作为真实创作质量证明。
- 旧 @mariozechner scope、新 @earendil-works scope，以及各项目固定的 pi 版本不同；移植时需按选定版本核对 API，不能直接混用事件和会话示例。
- 项目存在、源码能力和实际效果是三个不同结论。后续如进入实施，应对选中的最小模块做版本固定与业务小样验收。

推荐首先阅读：InkOS 的 worker-agent.ts/context-compiler.ts → pi-novel-scribe 的 writer.ts → Pi-Paper 的 drama-agent.ts/local-tool-gateway.ts → pi-self-learning 的 reflectNow/事件注册 → Inngest 的 evaluate-prompts.ts/evaluation.ts。所有永久链接已列在对应章节。
