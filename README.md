# NovelAI Illustrator

一个用于小说批量配图的本地工作台。项目使用 React + Vite 前端和 Node.js 后端，围绕章节拆分、场景提炼、自然语言 Prompt 合成、NovelAI 出图、断点续跑和后续 EPUB 导出组织整条流水线。

## 当前能力

- 导入 `.txt`、`.docx`、`.epub`、`.pdf` 小说文件并创建项目
- 自动解析卷章结构：中文按 `ceil(有效字符数 / 600)`，英文按 `ceil(总词数 / 350)` 生成分镜场景
- 使用 LLM 生成结构化场景描述和 V4.5 自然语言生图 Prompt
- 调用 NovelAI V4.5 / V4 系列模型生成插图
- 支持 Vibe Transfer、多角色场景、单场景重绘、仅 NAI 重绘
- 支持章节级断点续跑、失败记录、SSE 实时日志和冷却状态同步
- 预留 EPUB 构建路径，便于把章节与插图整理成电子书产物
- 独立「有声书」标签页：同一本书的章节经 MiMo TTS 合成并压缩为单个 `.m4b`，与生图管线互不干扰

## 目录结构

- `client/`: React 前端
- `server/`: Express 后端与核心流水线
- `projects/`: 每个小说项目的原文、进度文件与插图输出
- `logs/`: 后端运行日志
- `illustrator_config.example.json`: 全局配置模板
- `start.bat`: Windows 一键启动脚本

## 环境要求

- Node.js 20+
- npm 10+
- Windows PowerShell 或 CMD
- 可访问 LLM 接口
- 可用的 NovelAI Token

## 快速开始

1. 安装依赖

```powershell
cd server
npm install
cd ..\client
npm install
cd ..
```

2. 启动前后端

```powershell
.\start.bat
```

3. 打开界面

- 前端: `http://localhost:5173`
- 后端: `http://localhost:5001`

## 配置说明

首次启动后，在前端配置面板填写以下内容：

- `llm_url`: 兼容 OpenAI 风格的聊天接口地址
- `llm_key`: 用于章节场景提炼和高级 Prompt 合成
- `llm_model`: 场景提炼与提示词生成使用的模型
- `nai_token`: NovelAI Bearer Token
- `nai_model`: 默认 `nai-diffusion-4-5-full`
- `vibeBundlePath`: 启用 Vibe Transfer 时使用的 bundle 文件

仓库提供 `illustrator_config.example.json` 模板。

配置拆成两个文件：

- `illustrator_config.json`：普通配置（模型名、采样参数、画风词、system prompt 等）。**不含密钥，可以正常提交与版本管理。**
- `illustrator_config.secrets.json`：只放密钥（`llm_key`、`llm_scene_key`、`nai_token` 等，以及 `llm_api_presets` 里每个预设的 `key`）。已被 `.gitignore` 忽略。

首次使用把 `illustrator_config.example.json` 复制为 `illustrator_config.json`，密钥在面板里填写即可——后端会自动把密钥写进 `illustrator_config.secrets.json`，主文件保持无密钥状态。旧版单文件配置在首次读取时会自动拆分，并在主配置旁留下 `.bak-split` 备份。

## 运行流程

1. 新建项目并导入小说文本
2. 后端解析卷章并写入 `projects/<项目名>/book.txt`
3. 流水线生成章节场景卡片并落盘到 `pipeline_progress.json`
4. 每个场景调用 LLM 生成 V4.5 自然语言 Prompt
5. 调用 NovelAI 生图并保存到 `projects/<项目名>/illustrations/`
6. 前端通过 SSE 实时接收冷却、进度、日志和失败信息

## 断点与恢复

- 已成功的场景会跳过，不重复生成
- 失败章节会保留已提炼场景，便于从断点续跑
- `pipeline_progress.json` 是项目运行状态的主记录文件
- 后端默认对 NovelAI 频控按 35 秒节奏排队

## Agent 操作

项目提供本机 Agent 接口 `/api/agent/capabilities`、`/api/agent/call` 和 `/api/agent/jobs/:actionId`，与网页共享现有流水线和重绘队列。

项目级 Skill 位于 `.agents/skills/nai-project-agent/SKILL.md`，包含操作流程、参数协议和调用脚本：

```powershell
node .agents/skills/nai-project-agent/scripts/nai-agent.mjs capabilities
node .agents/skills/nai-project-agent/scripts/nai-agent.mjs call projects.list --args projects-list.json
```

`projects-list.json` 内容为 `{}`。脚本默认端口 5001；直接运行后端的默认端口 5000 时加 `--base-url http://127.0.0.1:5000`。

支持读取小说/角色/场景、Agent 编写场景与最终 Prompt、生图/重绘/续跑/停止，以及提交绑定图片和上下文的视觉 QC 报告。写操作使用稳定 actionId 防止重复提交；异步回执不代表图片已生成。服务重启后的未完成任务需核查，不自动重投。

QC 由外部 Agent 实际看图后提交；项目不内置自动视觉模型 worker。

## 漫画生产

Agent 使用 `comics.*` 创建 EP、逐格分镜与对白，记录原文出处、镜头、人物和剧情状态，再保存 Prompt 并调用现有 NovelAI 队列。每格最多四次生成提交，候选 PNG 和预检历史独立保留。漫画场景的修改、重绘与章节重跑由漫画接口管理。

在网页选择「漫画工作台」，可查看候选原图、原文与十二轴预检，定位说话角色，逐格批准、退修或写坐标批注。预检 PASS 之后才可人工批准，不要求审阅人姓名或额外确认勾选。

漫画工作台也可直接创作：新建漫画话 → 选择小说章节、原文范围和格数（1–80）→ 生成分镜草稿 → 编辑并采用 → 补齐提示词 / 生成缺失画格。可手动加格、编辑单格分镜与对白、编辑生图输入、让 LLM 重写本格提示词或生成另一张候选。分镜使用现有「场景」LLM 配置，提示词使用「NAI 标签」LLM 配置；生图沿用现有 NovelAI 队列、限流和冷却。生成按钮会消耗已配置模型的额度。

分镜草稿不会自动采用或生图；批量任务按顺序运行，进度自动刷新，停止后等待当前远程调用结束，并保留返回的候选。服务重启不自动重投任务。生成图片后仍须由外部 Agent 实际看图提交预检，再由用户批准；页面生成不等于视觉 QC 通过。

全格批准后组装条漫：对白/旁白放在画格间，带说话人标识，输出可编辑 SVG、PNG 切片及手机阅读预览。排版终审通过后才可导出 ZIP，其中包含图像、分镜、生成输入、QC、人工记录和校验清单。修改分镜、原文、参考、DNA 或布局后，受影响审核需要重做。

完整操作见 `.agents/skills/nai-project-agent/references/comic-workflow.md`。数据在 `projects/<项目名>/comic/`，交付格式为 `nai-comic-handoff/1.0`。本版提供原生条漫组装；外部 `D:/codex/comic` Skill 的原生导入适配器尚未实现。当前排版也不提供图内智能气泡尾巴或拖拽编辑。

## 插画压缩

NAI 出图为 32bit PNG，单张 1.5–2.5MB。开启自动压缩后，插图落盘即转 WebP（默认 q85）并替换原 PNG；实测 1024×1024 由 1.5MB 降到约 110KB，832×1216 由 1.7MB 降到约 140KB，PSNR 37–40dB，肉眼不可分辨。

压缩会丢掉 PNG 的 tEXt 元数据（完整 prompt / seed / steps），因此默认同时导出同名 `.txt` sidecar，并把摘要写回 WebP 的 EXIF `ImageDescription`。重绘或复现参数时优先读 `.txt`。

配置项：`image_compress_enabled`（默认 `true`）、`image_compress_quality`（默认 `85`）、`image_compress_sidecar`（默认 `true`），可在网页配置面板调整。

历史旧图在「书籍项目库」右上角点「一键压缩旧图」批量处理（逐个项目卡片也有单项目按钮），接口为 `POST /api/compress-images/start`、`GET /api/compress-images/status`、`POST /api/compress-images/cancel`，默认按 CPU 核数开多路并行。命令行等价用法：

```powershell
node scripts/compress-images.mjs --dry-run          # 只统计体积
node scripts/compress-images.mjs -j 8 -q 85         # 8 路并行，替换原图
node scripts/compress-images.mjs --only 项目名       # 只处理单个项目
node scripts/compress-images.mjs --keep-original    # 保留原 PNG 只出 WebP
```

## 有声书管线（TTS → M4B）

顶部导航第三个标签「有声书」是与生图完全独立的一套生产管线，只复用书籍与章节数据（`projects/<书名>/book.txt` → 章节），不触碰插图、场景和 NAI 队列。

- **前端可配置**：MiMo API Key（保存到根目录 `.env` 的 `MIMO_API_KEY`，页面只显示掩码）、并发数（1–16）、音色、AAC 码率、每块字数、块间/章间停顿、风格指令。
- **压缩**：TTS 返回的 24kHz/16bit 单声道 WAV 是 384 kbps，逐章转成 AAC 后体积约为原来 **1/8**（默认 48 kbps ≈ 22 MB/小时），中间 WAV 编码完立即删除，磁盘只留分章 AAC。
- **只产出 m4b**：分章 AAC 单遍流式封装为 `.m4b`，写入章节标记、书名/作者/演播者元数据和 `faststart`；章节时间轴按 AAC 帧数计算，避免累加漂移。
- **并发与续跑**：块级任务池并发吃满配置的并发数；已完成的章节落地为 `parts/<hash>.aac`，重启后自动跳过，中断在半章也能复用已合成的块。
- **产物路径**：`projects/<书名>/audiobook/out/<书名>.m4b`，状态在 `audiobook/state.json`。

接口（均为 `/api/audiobook` 前缀）：`GET /status`、`POST /config`、`POST /test`、`GET /chapters`、`POST /start`、`POST /stop`、`GET /task`、`GET /events`（SSE）、`GET /download`、`POST /reset`。

依赖：需要 `ffmpeg` 与 `ffprobe` 在 PATH 中（`AUDIOBOOK_FFMPEG` 可覆盖）。TTS 请求默认直连，不受主程序全局代理影响；如确需走代理，设置 `MIMO_PROXY=http://host:port`。

## Docker / NAS 部署

镜像已经内置 ffmpeg 与 ffprobe，**NAS 宿主机不需要另装**：Dockerfile 运行阶段执行 `apk add --no-cache ffmpeg`（Alpine 官方包同时提供两个二进制，原生 `aac` 编码 + `adts → mp4` 封装足够生成 m4b）。打开「有声书」标签页时右上角会显示 `ffmpeg 就绪`，`GET /api/audiobook/status` 也能直接查到版本。

```powershell
docker compose up -d --build
# 或使用预编译镜像
docker compose -f docker-compose.release.yml up -d
```

部署要点：

- **两个必须的挂载**：`./projects:/app/projects`（书籍、插图、`audiobook/out/*.m4b` 都在这里）与 `./data:/app/data`（配合 `AUDIOBOOK_ENV_FILE=/app/data/audiobook.env`，前端填写的 MiMo Key 才不会随容器重建丢失）。
- **Key 也可用环境变量注入**：`MIMO_API_KEY=sk-xxx`，优先级高于文件，适合不想在网页里填的场景。
- **内网走代理**：容器默认直连 MiMo（不受主程序给 NovelAI 设的全局代理影响）；确需代理时设 `MIMO_PROXY=http://host:port`。
- **磁盘**：TTS 返回的 WAV 只是块级临时文件，分章编码成 AAC 后立即删除，常驻体积约 `22 MB/小时`（48 kbps）；峰值约为「在途块 + 单章 WAV」，一般几十到一百多 MB。请确保 `projects` 所在卷有足够空间。
- **自检 ffmpeg**：`docker exec -it novelai-illustrator ffmpeg -version`。若用的是自己改过的基础镜像且未装 ffmpeg，可用 `AUDIOBOOK_FFMPEG=/path/to/ffmpeg` 指向挂载进来的静态二进制。
- **架构**：Alpine 仓库在 x86_64 / aarch64 都有 ffmpeg 包，本地 `--build` 可用；但 GitHub Actions 目前只构建 amd64 镜像，ARM 群晖/威联通请本地构建，或给 workflow 的 build-push-action 加 `platforms: linux/amd64,linux/arm64`。
- **构建上下文**：仓库里已加 `.dockerignore`，`projects/`、`data/`、`logs/`、`docs/` 不会被打进构建上下文，NAS 上 `--build` 不会因为几百 GB 小说和插图而卡住。

## 常用命令

```powershell
cd client
npm run dev
npm run build

cd ..\server
node index.js
```

## 测试与检查

后端测试目录 `server/test/` 已接入 `npm test`，Agent 接口可单独运行 `npm run test:agent`，漫画流程可运行 `npm run test:comic`。集成测试使用带 SIMULATED 标记的图片和报告，不调用收费模型。提交前可执行：

```powershell
node --check server\index.js
node --check server\services\pipeline-manager.js
node --check server\services\nai-client.js
cd server
npm test
```

## 注意事项

- 默认会尝试使用 `http://127.0.0.1:7890` 作为全局代理
- `projects/` 下会包含原文、进度和生成图片，体积会持续增长
- NovelAI 与 LLM 的可用性会直接影响流水线稳定性
- 如果已有旧进度文件，续跑前应先确认当前配置与模型版本是否一致
