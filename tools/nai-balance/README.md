# NAI 生图电量（V5 电量 + Anlas）

一个**单文件、零依赖**的小工具：双击 `index.html` 用浏览器打开，填上 NovelAI 令牌就能看到还剩多少 V5 免费额度、Anlas 余额、订阅档位和到期时间。不用起后端，不用装 node；页面直接从浏览器请求 `image.novelai.net`（该接口允许跨域），令牌不会发给任何第三方。

## 用法

1. 双击 `index.html`（或 `open.bat`）。
2. 填令牌：登录 novelai.net → 头像 → **Account** → `Get Persistent Token`，拿到 `pst-…`。
3. 点「查询」。

令牌存在本机 `localStorage`，下次打开自动查一次；「清空」可删除。

## 两个额度，别搞混

| 额度 | 字段 | 用途 |
| --- | --- | --- |
| **V5 免费电量**（Opus 电池） | `subscription.usage.percent` | V5 在标准参数下的免费出图额度。这是**剩余百分比本身**（100 = 满，0 = 空），随时间自动回充，1% ≈ 2.19 小时（`timeUntilNextPercent` ≈ 7888 秒） |
| **Anlas** | `trainingStepsLeft` | 通用点数，只在超出免费参数时才扣（例如 1024×1536 约 45 点/张） |

满槽约 1,730 张 V5（默认 23 步 / Normal 尺寸），按每天回 11%~14% 算，约合 7,000 张/月。

> 早先这工具把 `usage.percent` 当成「已用」、算成 `100 - percent`，方向是反的。反推依据：7888 秒 ≈ 2.19 小时回 1%，正好等于官方说的「每天约回 11%」——百分比是往上走的，所以它就是剩余量。

## 其余字段

| 字段 | 含义 |
| --- | --- |
| 本期订阅 / 已购买 | `trainingStepsLeft.fixedTrainingStepsLeft` / `.purchasedTrainingSteps`，加起来是网页上显示的总 Anlas |
| 订阅 / 到期 | `tier`（0 免费 / 1 Tablet / 2 Scroll / 3 Opus）、`active`、`expiresAt`（**秒**级时间戳） |
| 优先队列上限 | `priority.maxPriorityActions`，接口只给上限，不给已用次数 |
| 队列刷新 | `priority.nextRefillAt`，早于当前时间会标注「已过」 |

## 接口

- `GET https://image.novelai.net/user/data`（主，一次拿到 subscription + priority）
- `GET https://image.novelai.net/user/subscription`（兜底）

老的 `https://api.novelai.net/*` 现在返回 `400 Please refresh NovelAI.net...`，必须换成 `image.novelai.net`。请求头 `Authorization: Bearer <token>`。

## 常见问题

- **Anlas 显示 0，还能生图吗？** 能。Opus 在 V5 标准参数（≤832×1216 / 28 步 / 单图）下扣的是 V5 电量，不扣 Anlas；只有 Large 尺寸、更高步数、多图才需要 Anlas。
- **V5 电量掉到 0 会怎样？** 免费额度用完，继续生成就按 Anlas 计费（Anlas 也为 0 时生成会失败），等回充即可恢复。
- **V5 电量很低会不会被限制？** 电量见底时免费档基本等于没了；工具在 ≤25% 会转琥珀色、0% 转红色并提示。
- **报「请求没发出去」**：浏览器到 `image.novelai.net` 不通（代理/防火墙）。这个请求由浏览器直发，不走 nai 主程序的代理。
- **报「令牌无效或已过期」**：`pst-` 被重置过，去账号页重新取。
