# Agent HTTP 接口与审核协议

接口前缀 `/api/agent`，默认客户端连接端口 5001，实际以服务端口为准。

| 请求 | 用途 |
|---|---|
| GET /capabilities | 操作目录、参数 JSON Schema、收费标记和当前能力边界 |
| POST /call | 执行一个命名操作 |
| GET /jobs/{actionId} | 查询写操作回执或异步任务 |

POST 请求：

```json
{
  "action": "scenes.render",
  "actionId": "render-ep001-p001-v1",
  "arguments": {
    "projectName": "示例项目",
    "chapterKey": "从 projects.get 获取",
    "sceneIdx": 1,
    "expectedSceneHash": "从 scenes.get 获取",
    "confirmCosts": true
  }
}
```

返回 `{ok, apiVersion, data, replayed?}` 或 `{ok:false, apiVersion, error:{code,message}}`。必须检查 HTTP 状态与 ok；写操作还需检查 data.status。业务失败的原 actionId 重放可能返回 ok=true 和 FAILED_REVIEW_REQUIRED，这表示成功读取原回执，不表示任务成功。

## 操作选择

| 操作 | 效果 |
|---|---|
| projects.list / projects.get | 读取目录、章节、DNA 和进度 |
| projects.create | 写入 bookText 并解析；已有目录返回冲突 |
| chapters.get / scenes.get | 单章内容或场景完整上下文，场景返回 sceneHash |
| scenes.create / scenes.update | Agent 自写场景，新增自动分配 sceneIdx；更新需当前 hash |
| prompts.write | Agent 保存完整最终 Prompt；不调用 LLM/NAI |
| scenes.render | 复用保存的 Prompt，一次 NAI 请求 |
| scenes.redraw | 项目 LLM 重新制作 Prompt 后 NAI 生图 |
| pipeline.start | 项目原有自动流水线续跑，可选 chapterKey；不会主动清空整章分镜 |
| pipeline.status / pipeline.stop | 共享队列、冷却与进度／停止请求 |
| qc.tasks / qc.submit | 获取待看图任务／保存外部 Agent 视觉证据 |
| comics.sources.get / comics.storyboard.generate / comics.storyboard.apply | 小说原文／项目 LLM 生成分镜草稿／采用已检查的完整草稿 |
| comics.prompts.generate / comics.images.generate / comics.production.stop | 项目 LLM 制作提示词／逐格串行生图／停止续发；需查询 job 或 EP.production |

`scenes.create.card` 必填 trigger_sentence 与 visual_description，另可填 characters、character_names、core_action、environment、cinematography、interactions、interaction_actions、plot_traces、must_show、must_not_show、visual_entities 等。正式字段以 capabilities 为准。trigger_sentence 应忠实定位原文。

`prompts.write` 必填 projectName/chapterKey/sceneIdx/expectedSceneHash/basePrompt/negativePrompt/characterPrompts/width/height。无人画面用 characterPrompts=[]。人物负向段可选，但填写时数量与人物正向段一致，空段保留位置。画幅 64 对齐，像素面积不超过 1048576；这是当前接口的生产策略。

## QC 报告

qc.tasks 默认 limit=4，最大 20。只返回当前 SUCCESS 图片中尚无有效报告或报告过期的任务。FAIL/UNKNOWN 已保存报告可从 scenes.get 读取，不会不断作为新任务返回。

每个任务含原图/前格的实际本地路径、sha256、尺寸、scene、source、characterDna、previousScene、contextHash。用图像工具实际打开所有 images，不能依赖文件存在、缩略图或 Prompt 推测。

qc.submit 参数包含 projectName/chapterKey/sceneIdx/imageSha256/contextHash/summary/examinedImages/criteria。

examinedImages 记录任务中全部图的实际查看路径与 sha256。criteria 必须有完整 C1–C12，每项 `{result,evidence}`；result 为 PASS/FAIL/UNKNOWN/N_A，evidence 为具体中文可见证据。整体 verdict 由服务推导：有 FAIL 则 FAIL，有 UNKNOWN 则 UNKNOWN，其余 PASS。

| 轴 | 检查 |
|---|---|
| C1 | 人数、身份、人物特征与 DNA 对应 |
| C2 | 当前服装、颜色、穿脱状态 |
| C3 | 指定道具的数量、归属、位置和状态 |
| C4 | 空间关系、方向、环境锚点、前格连续性 |
| C5 | 动作主体/对象、接触点、视线和动作阶段 |
| C6 | 景别、机位、画幅、焦点及遮挡 |
| C7 | 原文时点、因果、must_show/must_not_show |
| C8 | 可见脸、手指、关节与肢体结构 |
| C9 | 多余人物、克隆、重复道具 |
| C10 | 线条、色彩和目标画风连续性 |
| C11 | 当前文件解码、尺寸和 hash；参考任务技术证据 |
| C12 | 伪文字、签名、水印、UI、额外气泡 |

N_A 仅限无人画面的 C1/C2/C8，或没有指定道具的 C3。程序不理解所有道具语义，C3 的适用性仍由 Agent 忠实判断。遮挡导致关键内容不能判断时用 UNKNOWN。报告只是 Agent 预检，普通插图 QC 不代表漫画批准。漫画使用独立的 `comics.qc.*` 和人工工作台，详见 [漫画生产协议](comic-workflow.md)。

## 持久化与恢复

任务回执与普通插图 QC 索引保存于 projects/.agent/ledger.json；历史插图报告保存在各项目 .agent/qc/。漫画的候选、生成记录、QC 历史和人工回执保存于各项目 comic/；两条路线都不可直接冒充外部 comic Skill 的批准包。

同一写请求被接收后即保存 actionId，再执行操作。服务重启对 ACCEPTED/QUEUED/RUNNING 标为 INTERRUPTED_REVIEW_REQUIRED。接收与落盘之间的未知结果必须查 job、项目进度及远程结果；接口不声称跨进程远程生成 exactly-once。

现有 NAI 客户端仍沿用其网络重试策略。本接口没有修改底层付费请求的未知结果处理、费用账本或预算控制；Agent 遇到读取失败/超时后不得在接口层再无条件重试。
