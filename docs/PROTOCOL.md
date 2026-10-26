# 协议文档

三家站点的对局接口、鉴权方式、棋谱格式，以及实现时踩到的坑。
写给想自己实现一遍的人（或 AI）。所有结论都是实测的，标注了验证日期。

参考实现：[`src/golinktosgf.js`](../src/golinktosgf.js)（零依赖，浏览器与 Node 共用）。

---

## 共性：都是 SPA，抓 HTML 没用

三个站点的对局页都是前端渲染（弈客是 Vue 2 + webpack，新博是 uni-app）。
页面 HTML 里没有棋谱，必须走它们的数据接口。

---

## 1. 弈客围棋 · 在线对弈

链接：`home.yikeweiqi.com/mobile.html#/new-online-game/<id>`（旧版路由 `#/online-game/<id>` 同一后端）

两跳：

```
POST https://api-new.yikeweiqi.com/v1/user/tpop/authorizations/anonymous
     body {"tpop_name":"og"}  + 签名头(见下)        -> result.token (匿名 JWT)

GET  https://game-server.yikeweiqi.com/game/info
     ?id=<id>&sgf_option=true&players_option=true&setting_option=true&clock_option=true
     Authorization: Bearer <token>                 -> {"code":0,"data":{...}}
```

- **不需要登录。** 匿名 JWT 任何人都能换。
- **`sgf_option=true` 是成败关键**：不带它接口照样返回 `code:0` 和看起来完整的对局对象，
  但没有 `sgf` 字段、`move` 是 `null` —— 很容易误判成"这局没棋谱"。
- `data.sgf` 是标准 SGF，但根节点只有 `RU/KM/HA/SZ`，选手名与结果要自己从同级字段拼。
- 终局判定：`status === "ended"` 且 `result` 非空。`result` 形如 `"w+2.25"`（小写），
  认输/超时时小数部分为空，要配合 `end_mode`（`resign`/`timeout`/`counting`）补成 `W+R`/`W+T`。
- `players.blacks` / `whites` 是**数组**（双人棋可能多人），取 `[0]`。

## 2. 弈客围棋 · 直播室

链接：`home.yikeweiqi.com/mobile.html#/golive/room/<id>/<hall>/<room>`

**另一套后端**，旧式信封：

```
GET https://api.yikeweiqi.com/v2/golive/dtl?id=<id>
    + 签名头                                      -> {"Status":1200,"Result":{"live":{...},"cmt":[...]}}
```

- 成功是 `Status === 1200`（不是 `code:0`）。
- **棋谱直接在 `Result.live.Content`**，是完整 SGF，已含 `PB`/`PW`/`KM`/`RU`，无需重建。
- `Result.live` 里的数值字段**全是字符串**。棋盘大小/贴目/规则从 `Content`（SGF）里读最可靠。
- `GameResult` 是**中文串**（如 `白中盘胜`），不能直接塞进 SGF 的 `RE[]`，
  要转换 —— 见 [`zhResult`](../src/golinktosgf.js)。空串表示未终局。
- `StepsCount` 不可信（实测一局 263 手时它是 `0`），要自己数。
- `Result.cmt` 是直播间人工解说，每条带 `CurHand` 对应手数，可以叠到棋谱上。

### 签名头（上面两个弈客接口共用）

常量取自 h5 bundle 的 `creatHeader` / `creatTPHeader`：

```
AppKey    = "3396jtzhK57XhJom"
appSecret = "hfdSXRKm0DQyLmNXmNCNkZpjy2o5q1Hk"
```

每次请求（`ts` 为毫秒时间戳，`nonce` 为 `[0, 1e8)` 随机整数）：

| 头 | 值 |
| --- | --- |
| `AppKey` | 上面那个 |
| `Nonce` | `nonce` |
| `CurTime` | `ts` |
| `CheckSum` | `sha1(appSecret + nonce + ts)`，小写 hex |

**只有这四个是必需的。** 实测（2026-10-26）：

- `CheckSum` 乱填或不发 → `401 {"status":1,"message":"Error Signature"}`，**服务端确实在验**
- 前端还会发 `accesstoken`（一个 MD5）、`version`、`platform`、`uuid`、`timestamp` ——
  `accesstoken` **乱填也通过**，其余都可省。
  这一点很关键：**WebCrypto 不提供 MD5**，去掉 `accesstoken` 后浏览器端只需
  `crypto.subtle.digest("SHA-1", ...)`，不必手写哈希。

### 坑：`Accept-Language: *` 会让直播室接口 500

`api.yikeweiqi.com` 是 PHP 应用，收到 `Accept-Language: *` 直接返回
`HTTP 500` + 一个 "System Error" HTML 页（不是 JSON，解析时会以
`Unexpected token '<'` 的形式炸出来）。给任何真实语言值（`zh-cn`、`zh-CN,zh;q=0.9`）即正常。

- **Node 的 `fetch` 默认就发 `accept-language: *`** —— 必须显式覆盖。
- 浏览器里 `Accept-Language` 是[禁止修改头](https://fetch.spec.whatwg.org/#forbidden-header-name)，
  JS 设了会被忽略，由浏览器填用户真实语言，所以浏览器端天然没这问题。

## 3. 弈客围棋 · 棋谱库

链接：`home.yikeweiqi.com/mobile.html#/sgf/detail?id=<id>&type=<type>`

注意参数在 **hash 之后**（`#/sgf/detail?id=…`），标准 URL 解析器不会把它当 query，
要用正则从 fragment 里取。`type` 原样回传即可（实测 `0`）。

```
GET https://api.yikeweiqi.com/usersgf/detail?id=<id>&type=<type>
    + 签名头                                      -> {"Status":1200,"Result":{...}}
```

`Result` 字段：`Id` · `Sgf` · `SgfHandsCount` · `Remark` · `GameName` ·
`BlackName` / `WhiteName` · `BlackGrade` / `WhiteGrade` · `GameDate` · `Result` ·
`BlackHeadImgUrl` / `WhiteHeadImgUrl`。

- `Sgf` 是**完整 SGF**，根节点已有 `PB`/`PW`/`EV`/`DT`/`RE`/`SZ`/`AP`。
- **常常没有 `KM` 和 `RU`**（贴目与规则）。不要编造，缺就缺。
- `Result` 是上传者手填的自由文本，可能根本不符合 SGF 的 `RE` 规范 ——
  实测样本是 `黑191`（既不是目数也不是手数，含义不明）。归一化后只能确定胜方（`B+`）。
- `SgfHandsCount` 不可信：实测一局它报 174，实际 173 手。
- 这是**棋谱库**，讲解谱会带 `C[]` 注解、`LB`/`TR` 标记和分支变化图。
  取谱时必须**原样透传**，只往根节点补缺失属性；解析成着手列表再重建会丢掉全部注解和分支。

## 4. 新博对弈

链接：`weiqi.xinboduiyi.com/golive/index.html?gamekey=<key>&gametype=eye`

**明文 JSON over WebSocket**，无签名、无 token、无登录：

```
wss://live.xinboduiyi.com:40442/ws

-> {"cmd":"1","data":"zzz123"}        握手, 回 {"cmd":"1","data":"ok"}
-> {"cmd":"7","lang":"zh-Hans","data":{"game_key":"<key>","qipu_id":"","pinglun_id":"",
     "qipu_type":"","is_creator":"","lang":"zh-Hans","noComments":false,"keyType":"gameKey"}}
<- {"cmd":"6","data":{...},"is_pause":false}
```

- 帧按 **`\r\n` 分隔**，一帧可能含多个 JSON 对象，先 split 再 parse。
- `data.StepStr` 是棋谱，`data.ResultDetail` 为空表示未终局。
- 该站另有 `wss://hall.xbkids.cn:9116/ws?encode=proto` 跑它自己的 AI 分析，那条**是 protobuf**
  （`c2s_StartAnalysis`，字段 `qipu`/`boardSize`/`gameKey`/`anaKey`）。取棋谱不需要它。

### `StepStr` 格式

`B[QR];W[DD];…` —— 形似 SGF 但**大写**，且字母表是 `ABCDEFGHJKLMNOPQRST`
（19 个，**跳过 `I`**，GTP 式）。两个字母同表，第一个是列、第二个是行。

他们自己的转换函数给出了精确映射：

```js
TransferCToD(c) { const t = c.charCodeAt(0) - 65; return t > 8 ? t - 1 : t; }
// 转 SGF 时逐字母:
String.fromCharCode(code >= 73 ? code + 31 : code + 32)   // 'I'(73) 是分界
```

即 `A→a`、`H→h`、`J→i`、`T→s` —— **行 0 在顶部，与 SGF 完全一致，不翻转**。
`B[QR]` → `;B[pq]`。

其他要处理的情况：

- 值**长于 2 字符**是摆子/让子串，不是着手：按 3 字符一组（色+列+行）读，输出 `AB`/`AW`
- `Z<n>` 作为值 = 让子数，他们据棋盘大小算星位
- `WW`、或值里含 `W` = 弃手 → `[tt]`
- 内联 `<…V>` / `<…T>` / `<…C>` 块是注解与标记，split `;` 前先剥掉

### 解码正确性怎么验

字母表的 `I` 跳错、或行列转置，都会立刻表现为**非法棋局**。
把 263 手连提子一起重演（`Local-20261018140014-50572`）：颜色严格交替、
坐标全在 `a`..`s`、**无一手落在已有子上、无自提**、且守恒成立
（263 落子 − 38 被提 = 225 盘面）。该谱含 8 个重复落点（最多重复 5 次）来自劫争，
全部合法 —— 解码错了的话这些点会变成碰撞。

---

## CORS：浏览器可以直连，不需要代理

实测（2026-10-26，`Origin: https://leiliu1990.github.io`）：

| 接口 | 预检 | `Access-Control-Allow-Origin` | 备注 |
| --- | --- | --- | --- |
| `api-new.yikeweiqi.com/v1/user/tpop/authorizations/anonymous` | 200 | 回显请求 Origin | `Allow-Headers` 只列了 `APPKEY,CHECKSUM,NONCE,CURTIME,ACCESSTOKEN,CONTENT-TYPE` —— 发别的自定义头会被浏览器拦掉，所以只发必需的那四个 |
| `game-server.yikeweiqi.com/game/info` | 204 | `*` | `Allow-Headers` 含 `Authorization` |
| `api.yikeweiqi.com/v2/golive/dtl` | 204 | `*` | `Allow-Headers` 含 `*` |
| `api.yikeweiqi.com/usersgf/detail` | 204 | `*` | 同上, 同一网关 |
| `wss://live.xinboduiyi.com:40442/ws` | — | — | **WebSocket 不受 CORS 约束**；证书是 DigiCert 签的，`wss://` 在 HTTPS 页面下无混合内容问题 |

所以一个 GitHub Pages 上的静态页面就能完成全部取谱，无需任何后端。

---

## 未覆盖的

- **未终局的对局**：本工具明确拒绝。弈客在线对弈的实时推送走
  `wss://game-server.yikeweiqi.com/connection/websocket`（Centrifugo v2，频道 `game:<id>`，
  payload 按 `protocol` 字段分发，每条都带完整 `sgf`）；直播室只要轮询 `dtl` 比 `HandsCount` 即可。
- 弈客的 `#/fir-game/<id>`（五子棋）—— 接口同形，但记录不是围棋 SGF。
- 私密对局、`reportkey` 流程（弈客 `cmd 17`）、让子局的 `ab_aw` 格式。
