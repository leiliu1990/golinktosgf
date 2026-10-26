# golinktosgf

把围棋直播/对局链接转成 SGF 棋谱。

**网页版（无需安装）：<https://leiliu1990.github.io/golinktosgf/>**
粘贴链接 → 导出 `.sgf`。纯前端运行，链接和棋谱都不经过第三方服务器。

```bash
# 命令行版 (Node 18+, 零依赖)
node bin/golinktosgf.mjs "https://home.yikeweiqi.com/mobile.html#/new-online-game/80246918"
# -> 弈客围棋-80246918-<黑方>-<白方>.sgf
```

## 支持的链接

| 来源 | 链接式样 | 传输 |
| --- | --- | --- |
| 弈客围棋 · 在线对弈 | `home.yikeweiqi.com/mobile.html#/new-online-game/<id>`<br>`…#/online-game/<id>`（旧版路由） | HTTP + 匿名 JWT |
| 弈客围棋 · 直播室 | `home.yikeweiqi.com/mobile.html#/golive/room/<id>/0/0` | HTTP + 签名头 |
| 弈客围棋 · 棋谱库 | `home.yikeweiqi.com/mobile.html#/sgf/detail?id=<id>&type=<type>` | HTTP + 签名头 |
| 星阵围棋 | `m.19x19.com/app/dark/zh/sgf/<id>` | HTTP POST |
| 新博对弈 | `weiqi.xinboduiyi.com/golive/index.html?gamekey=<key>` | WebSocket (JSON) |

**请给完整链接。** 各平台的编号都是纯数字（弈客对局号 / 弈客棋谱号 / 星阵棋谱号），
只给编号无法判断来源，所以这种输入会直接报错而不是去猜。
例外是新博的 `gamekey`（形如 `Local-…`，非纯数字），可以单独填。

**只导出已终局的对局。** 未终局会明确报错，不会给出半盘棋谱。

## 命令行用法

```
golinktosgf <链接或id> [选项]

  -o <文件>    写入指定文件 (默认按对局信息自动命名)
  --stdout     SGF 打到标准输出, 不写文件
  --json       输出对局元信息 JSON, 不写 SGF
  -h, --help   显示帮助
```

## 作为库使用

同一份 ES module 在浏览器和 Node 下都能跑（两边都原生提供 `fetch` / `WebSocket` / `crypto.subtle`）：

```js
import { fetchGame, suggestFilename } from "./src/golinktosgf.js";

const { sgf, meta, moves } = await fetchGame(url);
console.log(meta.black, "vs", meta.white, moves.length + "手", meta.result);
// 浏览器里下载
const a = Object.assign(document.createElement("a"), {
  href: URL.createObjectURL(new Blob([sgf], { type: "application/x-go-sgf" })),
  download: suggestFilename(meta),
});
a.click();
```

导出的接口：`fetchGame` · `detect` · `toSgf` · `patchSgfRoot` · `parseStepStr` ·
`zhResult` · `suggestFilename` · `NotFinishedError` · `SUPPORTED`。

棋谱库与直播室给的是**完整 SGF**，这两种来源走**原样透传 + 只补根节点**
（`patchSgfRoot`），因为讲解谱里可能有 `C[]` 注解、`LB`/`TR` 标记和分支变化图——
解析成着手再重建会把这些全丢掉。正文保证一字不改。

## 为什么网页版不需要后端

三个 HTTP 接口都带 CORS 允许头（实测，见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §CORS），
新博那条走 WebSocket——**WebSocket 不受 CORS 约束**。所以浏览器可以直连，
不需要代理服务器。

## 改动 src 后记得同步版本号

GitHub Pages 对静态文件发 `Cache-Control: max-age=600`，浏览器会在 10 分钟内
复用旧的 JS。`index.html` 里的模块导入带了版本 query：

```js
import { … } from "./src/golinktosgf.js?v=1.2.1";
```

**改了 `src/golinktosgf.js` 就要同时改这里的 `?v=` 和 `src` 里的 `VERSION`**，
否则用户拿到的还是缓存里的旧版。页面右下角会显示当前加载的版本号，便于核对。

## 测试

```bash
npm test     # 桩测试: 未终局必须被拒绝 + 中文结果串转换
```

## 协议文档

[docs/PROTOCOL.md](docs/PROTOCOL.md) 记录了三套后端的接口、鉴权、棋谱格式和踩过的坑，
写给想自己实现一遍的人（或 AI）。

## 许可

MIT
