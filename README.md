# NovelAI Illustrator

一个用于小说批量配图的本地工作台。项目使用 React + Vite 前端和 Node.js 后端，围绕章节拆分、场景提炼、Danbooru MCP 标签检索、NovelAI 出图、断点续跑和后续 EPUB 导出组织整条流水线。

## 当前能力

- 导入 `.txt`、`.docx`、`.epub`、`.pdf` 小说文件并创建项目
- 自动解析卷章结构，按章节生成 5 到 10 个分镜场景
- 使用 LLM 生成结构化场景描述和最终生图 Prompt
- 通过 Danbooru MCP 服务补全标签和场景语义
- 调用 NovelAI V4.5 / V4 系列模型生成插图
- 支持 Vibe Transfer、多角色场景、单场景重绘、仅 NAI 重绘
- 支持章节级断点续跑、失败记录、SSE 实时日志和冷却状态同步
- 预留 EPUB 构建路径，便于把章节与插图整理成电子书产物

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
- 可访问的 Danbooru MCP 服务

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
- `danbooru_mcp_url`: 一个或多个 MCP 地址，逗号分隔
- `vibeBundlePath`: 启用 Vibe Transfer 时使用的 bundle 文件

仓库提供 `illustrator_config.example.json` 模板。
本地使用时复制为根目录 `illustrator_config.json` 后再填写自己的 key 和 token。

`illustrator_config.json` 与 `server/illustrator_config.json` 不应提交到仓库。

## 运行流程

1. 新建项目并导入小说文本
2. 后端解析卷章并写入 `projects/<项目名>/book.txt`
3. 流水线生成章节场景卡片并落盘到 `pipeline_progress.json`
4. 每个场景调用 LLM + Danbooru MCP 生成 Prompt
5. 调用 NovelAI 生图并保存到 `projects/<项目名>/illustrations/`
6. 前端通过 SSE 实时接收冷却、进度、日志和失败信息

## 断点与恢复

- 已成功的场景会跳过，不重复生成
- 失败章节会保留已提炼场景，便于从断点续跑
- `pipeline_progress.json` 是项目运行状态的主记录文件
- 后端默认对 NovelAI 频控按 35 秒节奏排队

## 常用命令

```powershell
cd client
npm run dev
npm run build

cd ..\server
node index.js
```

## 测试与检查

当前仓库内已有后端测试目录 `server/test/`，但未统一接入 `npm test`。提交前至少建议执行：

```powershell
node --check server\index.js
node --check server\services\pipeline-manager.js
node --check server\services\nai-client.js
```

## 注意事项

- 默认会尝试使用 `http://127.0.0.1:7890` 作为全局代理
- `projects/` 下会包含原文、进度和生成图片，体积会持续增长
- NovelAI、LLM、MCP 的可用性会直接影响流水线稳定性
- 如果已有旧进度文件，续跑前应先确认当前配置与模型版本是否一致
