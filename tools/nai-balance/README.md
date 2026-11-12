# NAI 生图电量（Anlas 查询）

一个**单文件、零依赖**的小工具：双击 `index.html` 用浏览器打开，填上 NovelAI 的令牌就能看到当前 Anlas 余额、订阅档位和到期时间。不需要起后端，不需要装 node，也不会把令牌发给任何第三方（页面直接从浏览器请求 `image.novelai.net`，该接口允许跨域）。

## 用法

1. 双击 `index.html`（或拖进浏览器）。
2. 填入 NovelAI 令牌：登录 novelai.net → 右侧头像 → **Account** → `Get Persistent Token`，得到 `pst-…` 开头的字符串。
3. 点「查询」。

令牌存在本机 `localStorage`，下次打开自动查一次；点「清空」可删除。

## 显示什么

| 字段 | 含义 |
| --- | --- |
| Anlas 余额 | `本期订阅额度 + 已购买`，这是生图真正扣的点数 |
| 本期订阅额度 | `trainingStepsLeft.fixedTrainingStepsLeft`，每月发放、按比例恢复 |
| 已购买 | `trainingStepsLeft.purchasedTrainingSteps` |
| 本期剩余 | `100 - usage.percent`，用完后只能靠已购买的点数或等下期 |
| 订阅 / 到期 | `tier`（0 免费 / 1 Tablet / 2 Scroll / 3 Opus）、`active`、`expiresAt` |
| 优先队列上限 | `priority.maxPriorityActions`，接口只给上限，不给剩余次数 |
| 下次恢复 | `priority.nextRefillAt` |

## 接口

- `GET https://image.novelai.net/user/data`（主，能一次拿到 subscription + priority）
- `GET https://image.novelai.net/user/subscription`（兜底）

注意：老的 `https://api.novelai.net/*` 现在会返回 `400 Please refresh NovelAI.net...`，必须走 `image.novelai.net`。请求头是 `Authorization: Bearer <token>`。

## 常见问题

- **报「请求没发出去」**：浏览器到 `image.novelai.net` 的网络不通（代理/防火墙）。这个请求不经过 nai 项目的主程序代理，是浏览器自己发的。
- **报「令牌无效或已过期」**：`pst-` 令牌被重置过，去账号页重新取一个。
- **Anlas 显示 0 但还能生图**：Opus 标准参数下不扣点，只有超出免费参数（步数、尺寸等）才计费；0 表示本期额度已用完，不是不能画。
