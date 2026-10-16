# 漫画生产协议

操作入口、写回执与 C1–C12 定义见 [Agent 协议](agent-api.md)。本项目直接复用现有 NovelAI 后端；不需要 UI 点击来创作分镜或生图。

## EP 与画格

1. `projects.get`、`chapters.get` 读取原文和当前角色 DNA。
2. `comics.episodes.create` 创建 episodeId、title、language（zh-CN/zh-TW/en）和 initialState。状态使用扁平字符串键值，如 `{"door":"closed","hero.coat":"on"}`。
3. `comics.panels.add` 逐格创建稳定 ID。之后每次写操作先 `comics.episodes.get`，取最新 episodeHash 作为 expectedEpisodeHash；并行写同一 EP 会冲突。

最小新增参数示例，chapterKey 和 hash 必须替换为实际返回值：

```json
{
  "projectName": "小说项目",
  "episodeId": "EP001",
  "panelId": "P001",
  "expectedEpisodeHash": "当前 episodeHash",
  "plan": {
    "chapterKey": "实际 chapterKey",
    "sourceExcerpt": "她推开门。",
    "sourceLocator": "第一章 · 第三段",
    "sceneId": "SC001",
    "shotId": "SHOT001",
    "storyBeat": "进屋",
    "storyboardDescription": "女主伸手推门，门扇正在打开。",
    "shotSize": "中景",
    "cameraAngle": "侧面平视",
    "canvasReason": "竖幅容纳手、门把与人物",
    "width": 832,
    "height": 1216,
    "characterNames": ["女主"],
    "mustShow": ["手接触门把", "门正在打开"],
    "mustNotShow": ["门已经完全打开", "室内后续剧情"],
    "stateDelta": {"door": "open"},
    "styleMode": "main",
    "dialogue": [{"dialogueId":"D001","speakerId":"女主","type":"speech","text":"有人吗？"}],
    "sfx": ["吱呀"]
  }
}
```

sourceExcerpt 必须完整出现在所选章节中；sourceLocator 供人定位，不替代原文匹配。episodeId/panelId/sceneId/shotId/dialogueId 以英文字母开头，仅用英文、数字、下划线、连字符。画幅 64 对齐、面积 ≤1048576，每格最多四名角色。

sceneId 表示同一连续场景，shotId 表示镜头，panelId 表示阅读格。连续画格的 stateDelta 按 panelOrder 应用，得到下一格的 plannedEntryState。图像不得替代计划推进剧情状态；仅全格有效审批后的交付物包含 approvedExitState。对白准确文字不让 NAI 生成。

`comics.panels.update` 替换完整 plan。视觉字段改变会清除旧可执行 Prompt，旧图标记 PLAN_CHANGED；对白/拟声/间距变化保留画面预检，但人工审批和组装失效。`comics.episodes.update` 可改标题、initialState、完整 panelOrder 和布局；不能删格或迁移已有格的原文章节。layout 支持 width/fontSize/sliceHeight；按 360px 手机宽度计算字号至少 12px。

## Prompt、生成与恢复

### 页面创作与项目 LLM

用户可在漫画工作台新建 EP、选择章节和 1–80 格，生成可编辑的分镜草稿，检查后采用，再生成提示词和候选。支持单格编辑、手动加格和明确重抽。页面使用独立浏览器入口，Agent 继续使用 `/api/agent`，不得模拟页面人工审批。

Agent 也可使用以下项目 LLM 操作（均需稳定 actionId 与最新 expectedEpisodeHash）：

- `comics.sources.get`：读取章节目录，指定 chapterKey 时同时返回原文。
- `comics.storyboard.generate`：空 EP 上提交 chapterKey、panelCount、可选 sourceSelection/instructions 和 confirmCosts=true。分批生成并校验草稿，保存在 EP.storyboardDraft；不创建正式画格。最多两轮格式修复，无法通过即停止。
- `comics.storyboard.apply`：提交检查/编辑后的完整 plans，仅允许空 EP。先校验全部原文和画幅，再创建 P001 起的正式画格。这个操作不调用模型。
- `comics.prompts.generate`：使用项目 NAI 标签 LLM，为 panelIds 或全话生成缺失提示词；rewrite=true 可明确重写。confirmCosts=true。
- `comics.images.generate`：按 panelIds 或全话顺序补齐缺失提示词并生图；mode=missing（默认）跳过已有当前视觉计划候选，mode=reroll 明确重抽，rebuildPrompts=true 明确重写。confirmCosts=true。每张 NAI 子任务独立持久化，带 parentActionId，四次提交上限仍适用。
- `comics.production.stop`：停止后续派发，当前调用可能完成。可带 expectedProductionActionId 绑定当前任务，避免进度刷新造成 hash 冲突；未带时严格匹配 EP hash。重启后先核查任务，用此操作记录已处理，不自动重投；未核查的生图还需 comics.renders.resolve。

分镜使用 scene 任务 LLM，提示词使用 naiTags 任务 LLM，沿用项目连接、模型、stream 和限流配置。上述生成操作返回 jobId/status，查询原 actionId 的 job 或 EP.production 获得结果；生成期间本项目分镜/提示词修改会返回 BUSY。原文、DNA、画风变化会中止续发，已返回内容仍需核查。草稿生成成功只代表结构与原文匹配通过，图片生成成功也不会提交视觉 QC 或人工审批。

`comics.prompts.write` 接受 projectName/episodeId/panelId/expectedEpisodeHash/basePrompt/negativePrompt/characterPrompts，人物负向段可选；画幅来自 plan。人物段按 characterNames 顺序一一对应。完整写入目标画风、关键动作、道具和负向约束。styleMode=chibi 时必填 styleReason 并由 Agent 写对应 Prompt，服务不会自动注入 Q 版风格。

正向 token 是本地估算，超过 460 返回 PROMPT_BUDGET，目标 ≤400；不自动裁剪。这不等于 NovelAI 官方 tokenizer 的精确计数。

`comics.panels.render` 需 confirmCosts=true 和稳定 actionId。每格生命周期内含首图最多四次提交，失败也计次数；未成功派发的不计。不得新建同义 panelId 绕过次数或在 HTTP 超时后换 ID 重投。服务器分配并保存 seed，队列结束后自动复制当前图到独立候选资产。

候选不可覆盖，最多四张。`comics.candidates.capture` 可收录关联场景当前 SUCCESS PNG，无模型调用；它不是通用任意图片导入。旧候选的 Prompt 快照不因新 Prompt 被覆盖。

FAILED/STOPPED/INTERRUPTED_REVIEW_REQUIRED 先查 job、进度、文件和远程结果。`comics.renders.resolve` 以最新 EP hash 和具体 note 记录 `capture-current` 或 `no-image`，不自动生图；未核查任务会阻止新生成和组装。`no-image` 仅记录核查结论，不证明未扣费。现有 NAI 客户端内部网络重试仍有效，次数上限是接口提交次数，不保证底层网络请求或收费次数。

## 视觉预检与人工确认

`comics.qc.tasks` 返回每个候选的当前分镜、输入、DNA、剧情进入状态、实际原图和同场景前格参考（优先选中审批图，否则最新候选）。实际查看全部 images，按 Agent 协议十二轴提交 `comics.qc.submit`，必须带 candidateId/imageSha256/contextHash/examinedImages/summary/完整 criteria。FAIL 或 UNKNOWN 不可人工批准。报告历史保留，服务不能证明 Agent 实际看过图，责任仍在操作 Agent。

QC 绑定候选图、视觉计划、原文、DNA、进入状态和前格计划/图。新 Prompt 本身不会改变旧候选实际输入；当前候选仍按自身快照检查。切换前格选中候选、改计划/原文/DNA/顺序等会使受影响报告或批准失效。

用户打开网页「漫画工作台」，逐张查看原图、预检证据和原文。对白有说话人时需在图上定位角色；可逐格批准、退修、留下坐标批注。没有审阅人姓名或“我已查看”勾选项。批准通过独立本机浏览器会话保存，不属于 Agent action。浏览器限制用于分离正常入口，并非对能伪造 HTTP 头的本机程序提供身份认证。

## 原生组装与交付

全格通过当前有效人工批准后，`comics.assemble` 生成：

- master.svg：可编辑的完整长条。
- slice-*.png：切片；保护对白和拟声块不跨切片，超长图像可能分片。
- preview.html：手机自适应阅读预览。
- layout.json：阅读顺序、画格与对白边界、说话人锚点、切片坐标。

当前排字采用画格之间的气泡/旁白框和说话人标签，避免遮挡画面；不提供图内智能避障气泡尾巴、交互拖拽排版或自动断词校对。字号、顺序、翻译、字形和切片阅读效果仍由用户终审。文字框超过切片高度时缩短文字或调整 sliceHeight。

用户在工作台执行排版终审后，`comics.export` 导出 ZIP：原图、原文分镜、生成输入、候选 QC、人工决定、状态、排版文件和校验清单。审核后源图/布局变化会拒绝导出；再次组装产生新的布局和终审任务。签字状态保存在 episode 中，静态预览/layout.json 保留其创建时的“待终审”标签。

项目数据位于 `projects/<name>/comic/`；交付 schema 为 `nai-comic-handoff/1.0`。该 ZIP 可直接用于本项目原生条漫交付。外部 `D:/codex/comic` 的 nai-webtoon-human-qc 使用另一套合同及生产后端；本版尚未提供其导入适配器，manifest 明确 externalSkillImportRequired=true。不能将本项目 QC 或浏览器回执改名冒充外部 Skill 的证据。
