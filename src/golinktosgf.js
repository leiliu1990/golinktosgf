/**
 * golinktosgf — 把围棋直播/对局链接转成 SGF
 *
 * 零依赖, 同一份代码在浏览器与 Node 18+ 下都能跑
 * (两边都原生提供 fetch / WebSocket / crypto.subtle)。
 *
 *   import { detect, fetchGame, toSgf } from "./golinktosgf.js";
 *   const game = await fetchGame(url);
 *   console.log(game.sgf, game.meta);
 *
 * 支持的来源见 docs/PROTOCOL.md。
 */

/* ────────────────────────── 签名 (弈客两个 HTTP 接口共用) ───────────────────────── */

const YIKE_APPKEY = "3396jtzhK57XhJom";
const YIKE_SECRET = "hfdSXRKm0DQyLmNXmNCNkZpjy2o5q1Hk";

async function sha1Hex(s) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 弈客的签名头。只发服务端真正校验的四个 ——
 * 实测 accesstoken(MD5) 不参与校验, 去掉后免了在浏览器里手写 MD5
 * (WebCrypto 不提供 MD5); 同时这四个都在两个接口的 CORS 白名单里。
 */
async function yikeHeaders(extra) {
  const ts = Date.now();
  const nonce = Math.floor(Math.random() * 1e8);
  return {
    AppKey: YIKE_APPKEY,
    Nonce: String(nonce),
    CurTime: String(ts),
    CheckSum: await sha1Hex(YIKE_SECRET + nonce + ts),
    // 必须给一个真实语言值: Node 的 fetch 默认发 "accept-language: *",
    // 直播室那个 PHP 接口收到 * 会直接 500。浏览器里这是禁止修改头,
    // 本行被忽略, 由浏览器自己填真实值, 同样没问题。
    "Accept-Language": "zh-cn",
    ...extra,
  };
}

/* ────────────────────────────────── 链接识别 ─────────────────────────────────── */

const SOURCES = [
  { source: "yikeweiqi", kind: "sgf", re: /yikeweiqi\.com\/.*#\/sgf\/detail\?[^#]*\bid=(\d+)/i },
  { source: "yikeweiqi", kind: "golive", re: /yikeweiqi\.com\/.*#\/golive\/room\/(\d+)/i },
  { source: "yikeweiqi", kind: "game", re: /yikeweiqi\.com\/.*#\/(?:new-online-game|online-game)\/(\d+)/i },
  { source: "xinbo", kind: "live", re: /xinboduiyi\.com\/.*[?&]gamekey=([^&#\s]+)/i },
];

/** 识别链接 -> {source, kind, id}; 认不出抛错 */
export function detect(url) {
  const u = String(url || "").trim();
  for (const s of SOURCES) {
    const m = u.match(s.re);
    if (!m) continue;
    const hit = { source: s.source, kind: s.kind, id: decodeURIComponent(m[1]) };
    if (s.kind === "sgf") {                       // 棋谱库还要带上 type
      const t = u.match(/[?&]type=(\d+)/i);
      hit.type = t ? t[1] : "0";
    }
    return hit;
  }
  // 裸 id: 纯数字当弈客对局, 其余当新博 gamekey
  if (/^\d{4,}$/.test(u)) return { source: "yikeweiqi", kind: "game", id: u };
  if (/^[A-Za-z][A-Za-z0-9_-]{7,}$/.test(u)) return { source: "xinbo", kind: "live", id: u };
  throw new Error("无法识别的链接。支持弈客围棋 (在线对弈 / 直播室) 与新博对弈。");
}

/* ───────────────────────────────── SGF 组装 ──────────────────────────────────── */

const esc = (v) => String(v).replace(/([\]\\])/g, "\\$1");

function sgfRoot(props, extraNodes = "") {
  const head = props
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => `${k}[${esc(v)}]`)
    .join("");
  return { head: head + extraNodes };
}

const RULE_SGF = { cn: "Chinese", jp: "Japanese", kr: "Korean" };

/** 着手数组 -> SGF 正文 (每手一行, 便于 diff) */
const sgfMoves = (moves) => moves.map(([c, p]) => `;${c}[${p}]`).join("\n");

/** 统一出口: meta + moves -> 完整 SGF 文本 */
export function toSgf(meta, moves, setup = []) {
  const props = [
    ["GM", 1], ["FF", 4], ["CA", "UTF-8"], ["AP", "golinktosgf"],
    ["SZ", meta.boardSize || 19],
    ["KM", meta.komi],
    ["RU", RULE_SGF[meta.rule] || meta.rule || ""],
    ["PB", meta.black], ["BR", meta.blackRank],
    ["PW", meta.white], ["WR", meta.whiteRank],
    ["DT", (meta.date || "").slice(0, 10)],
    ["EV", meta.event],
    ["RE", meta.result],
    ["GN", meta.gameName],
  ];
  if (meta.handicap) props.push(["HA", meta.handicap]);
  if (meta.timeLimit) props.push(["TM", meta.timeLimit]);
  let extra = "";
  for (const col of ["B", "W"]) {
    const pts = setup.filter(([c]) => c === col).map(([, p]) => `[${p}]`).join("");
    if (pts) extra += (col === "B" ? "AB" : "AW") + pts;
  }
  const { head } = sgfRoot(props, extra);
  return `(;${head}\n${sgfMoves(moves)})\n`;
}

/**
 * 往现成 SGF 的根节点补属性, 正文一字不改 ——
 * 棋谱库/直播室给的是完整 SGF, 可能带 C[] 注解或分支,
 * 解析成着手再重建会把这些丢掉, 所以这里走打补丁的路子。
 * 已存在的属性默认保留 (override 里的键才覆盖)。
 */
export function patchSgfRoot(sgf, add = {}, override = {}) {
  const text = String(sgf).trim();
  const open = text.indexOf("(;");
  if (open < 0) throw new Error("不是合法的 SGF (找不到 \"(;\")");
  // 根节点到下一个 ";" 或 "(" 为止
  let end = open + 2, depth = 0;
  while (end < text.length) {
    const c = text[end];
    if (c === "[") { while (end < text.length && text[end] !== "]") { if (text[end] === "\\") end++; end++; } }
    else if (c === ";" || c === "(" || c === ")") break;
    end++;
  }
  let root = text.slice(open + 2, end);
  const has = (k) => new RegExp(`\\b${k}\\[`).test(root);
  for (const [k, v] of Object.entries(override)) {
    if (v === "" || v == null) continue;
    const re = new RegExp(`\\b${k}\\[[^\\]]*\\]`);
    root = has(k) ? root.replace(re, `${k}[${esc(v)}]`) : root + `${k}[${esc(v)}]`;
  }
  for (const [k, v] of Object.entries(add)) {
    if (v === "" || v == null || has(k)) continue;
    root += `${k}[${esc(v)}]`;
  }
  return text.slice(0, open + 2) + root + text.slice(end);
}

/** SGF 文本 -> 着手数组 (用于已经拿到成品 SGF 的来源) */
function parseSgfMoves(sgf) {
  return [...String(sgf).matchAll(/;([BW])\[([a-z]{0,2})\]/g)].map((m) => [m[1], m[2]]);
}

/* ──────────────────────────── 来源 1: 弈客在线对弈 ──────────────────────────── */

const RESULT_END = { resign: "R", timeout: "T", counting: "" };

/** 本工具只导出已终局的对局 */
export class NotFinishedError extends Error {
  constructor(what) {
    super(`对局尚未结束${what ? " (" + what + ")" : ""}。golinktosgf 只导出已终局的对局。`);
    this.name = "NotFinishedError";
  }
}

/**
 * 中文结果串 -> SGF RE。
 * 实测样本有 "白中盘胜"; 其余式样按常见写法覆盖, 认不出时至少保住胜方。
 */
export function zhResult(text) {
  const t = String(text || "").replace(/\s+/g, "");
  if (!t) return "";
  if (/^(和棋|和局|平局)$/.test(t)) return "0";
  const side = t.startsWith("黑") ? "B" : t.startsWith("白") ? "W" : "";
  if (!side) return t;                                  // 非"黑/白"开头, 原样留着
  if (/中盘胜|认输|投了/.test(t)) return side + "+R";
  if (/超时|时间/.test(t)) return side + "+T";
  if (/不战而胜|弃权|默认/.test(t)) return side + "+F";
  // "黑胜3目半" / "白胜2.25目" / "黑2目半胜"
  const num = t.match(/(\d+(?:\.\d+)?)\s*(?:又\s*(\d)\/(\d))?\s*目(半)?/);
  if (num) {
    let v = parseFloat(num[1]);
    if (num[2] && num[3]) v += Number(num[2]) / Number(num[3]);
    if (num[4]) v += 0.5;
    return side + "+" + v;
  }
  if (/子/.test(t)) {                                    // 数子制: "黑胜2子"
    const z = t.match(/(\d+(?:\.\d+)?)\s*(?:又\s*(\d)\/(\d))?\s*子(半)?/);
    if (z) {
      let v = parseFloat(z[1]);
      if (z[2] && z[3]) v += Number(z[2]) / Number(z[3]);
      if (z[4]) v += 0.5;
      return side + "+" + v * 2;                         // 1 子 = 2 目
    }
  }
  return side + "+";                                     // 只知道胜方
}

function yikeResult(res, endMode) {
  const r = String(res || "").trim();
  if (!r) return "";
  const m = r.match(/^([bw])\+(.*)$/i);
  if (!m) return r.toUpperCase();
  let margin = m[2].trim();
  if (!margin || margin === "0") margin = RESULT_END[endMode] ?? margin;
  return `${m[1].toUpperCase()}+${margin}`;
}

async function fetchYikeGame(id) {
  // 1) 换一个匿名 JWT
  const authRes = await fetch("https://api-new.yikeweiqi.com/v1/user/tpop/authorizations/anonymous", {
    method: "POST",
    headers: await yikeHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ tpop_name: "og" }),
  }).then((r) => r.json());
  if (authRes.status !== 0 || !authRes.result?.token) {
    throw new Error("弈客匿名授权失败: " + (authRes.message || authRes.status));
  }

  // 2) 取对局; sgf_option 不带的话返回里没有棋谱
  const q = new URLSearchParams({
    id, sgf_option: "true", players_option: "true", setting_option: "true", clock_option: "true",
  });
  const res = await fetch(`https://game-server.yikeweiqi.com/game/info?${q}`, {
    headers: { Authorization: "Bearer " + authRes.result.token, "Content-Type": "application/json" },
  }).then((r) => r.json());
  if (res.code !== 0 || !res.data) throw new Error("取对局失败: " + (res.msg || res.code));

  const d = res.data;
  if (d.status !== "ended" || !String(d.result || "").trim()) {
    throw new NotFinishedError(`状态 ${d.status || "?"}, 已走 ${d.hands_count ?? "?"} 手`);
  }
  const b = d.players?.blacks?.[0] || {};
  const w = d.players?.whites?.[0] || {};
  const meta = {
    source: "yikeweiqi", kind: "game", id: String(d.id),
    black: b.name || "Black", white: w.name || "White",
    blackRank: b.grade || "", whiteRank: w.grade || "",
    boardSize: d.board_size || 19, komi: d.komi, rule: d.rule, handicap: d.handicap || 0,
    date: d.began_at || d.created_at || "", event: d.game_name || "",
    result: yikeResult(d.result, d.end_mode),
    resultText: d.result_desc || "", endMode: d.end_mode || "",
    handsCount: d.hands_count, status: "ended",
    timeLimit: d.setting?.main_time || 0,
    gameName: `弈客围棋 #${d.id}`,
    url: `https://home.yikeweiqi.com/mobile.html#/new-online-game/${d.id}`,
  };
  return { meta, moves: parseSgfMoves(d.sgf || "") };
}

/* ──────────────────────────── 来源 2: 弈客直播室 ───────────────────────────── */

const sgfProp = (sgf, name, dflt = "") =>
  (String(sgf).slice(0, 600).match(new RegExp(`\\b${name}\\[([^\\]]*)\\]`)) || [, dflt])[1];

async function fetchYikeGolive(id) {
  const res = await fetch(`https://api.yikeweiqi.com/v2/golive/dtl?id=${encodeURIComponent(id)}`, {
    headers: await yikeHeaders(),
  }).then((r) => r.json());
  const live = res?.Result?.live;
  if (res?.Status !== 1200 || !live) throw new Error("取直播室失败: " + (res?.Status ?? "?"));
  const sgf = live.Content || "";
  if (!sgf) throw new Error(`直播室 ${id} 还没有棋谱内容`);
  const rawResult = String(live.GameResult || "").trim();
  if (!rawResult) throw new NotFinishedError(`已走 ${live.HandsCount ?? "?"} 手`);
  const meta = {
    source: "yikeweiqi", kind: "golive", id: String(live.Id || id),
    black: live.BlackPlayer || "Black", white: live.WhitePlayer || "White",
    blackRank: "", whiteRank: "",
    boardSize: Number(sgfProp(sgf, "SZ", "19")) || 19,
    komi: Number(sgfProp(sgf, "KM", "6.5")) || 6.5,
    rule: sgfProp(sgf, "RU", "jp"),
    handicap: Number(live.Handicap || 0),
    date: live.GameDate || "", event: live.GameName || "",
    result: zhResult(rawResult),                  // "白中盘胜" -> "W+R"
    resultText: rawResult, endMode: "",
    handsCount: Number(live.HandsCount || 0), status: "ended",
    timeLimit: 0, gameName: `弈客直播 #${live.Id || id}`,
    url: `https://home.yikeweiqi.com/mobile.html#/golive/room/${live.Id || id}/0/0`,
  };
  // 原样透传 + 补根节点, 保住 Content 里可能带的注解
  const patched = patchSgfRoot(sgf,
    { GM: 1, FF: 4, CA: "UTF-8", AP: "golinktosgf", PB: meta.black, PW: meta.white,
      DT: meta.date, EV: meta.event, GN: meta.gameName },
    meta.result ? { RE: meta.result } : {});
  return { meta, sgf: patched, moves: parseSgfMoves(sgf) };
}

/* ─────────────────────────── 来源 3: 弈客棋谱库 ────────────────────────────── */

async function fetchYikeSgfDetail(id, type = "0") {
  const q = new URLSearchParams({ id, type });
  const res = await fetch(`https://api.yikeweiqi.com/usersgf/detail?${q}`, {
    headers: await yikeHeaders(),
  }).then((r) => r.json());
  const r = res?.Result;
  if (res?.Status !== 1200 || !r) throw new Error("取棋谱失败: " + (res?.Status ?? "?"));
  const raw = r.Sgf || "";
  if (!raw) throw new Error(`棋谱 ${id} 没有内容`);

  const rawResult = String(r.Result || "").trim();
  const norm = zhResult(rawResult);
  const meta = {
    source: "yikeweiqi", kind: "sgf", id: String(r.Id || id),
    black: r.BlackName || sgfProp(raw, "PB", "Black"),
    white: r.WhiteName || sgfProp(raw, "PW", "White"),
    blackRank: r.BlackGrade || "", whiteRank: r.WhiteGrade || "",
    boardSize: Number(sgfProp(raw, "SZ", "19")) || 19,
    komi: sgfProp(raw, "KM", ""),              // 棋谱库常常没有贴目, 不编造
    rule: sgfProp(raw, "RU", ""),
    handicap: Number(sgfProp(raw, "HA", "0")) || 0,
    date: (r.GameDate || sgfProp(raw, "DT", "")).slice(0, 10),
    event: (r.GameName || sgfProp(raw, "EV", "")).trim(),
    result: norm, resultText: rawResult, endMode: "",
    handsCount: Number(r.SgfHandsCount || 0), status: "ended",
    timeLimit: 0, remark: r.Remark || "",
    gameName: `弈客棋谱 #${r.Id || id}`,
    url: `https://home.yikeweiqi.com/mobile.html#/sgf/detail?id=${r.Id || id}&type=${type}`,
  };
  // 原样透传, 只补缺失的根属性; RE 仅在原值非标准且能可靠归一时才覆盖
  const standard = /^([BW]\+|0$)/.test(norm);
  const origRE = sgfProp(raw, "RE", "");
  const sgf = patchSgfRoot(raw,
    { GM: 1, FF: 4, CA: "UTF-8", SZ: meta.boardSize, PB: meta.black, PW: meta.white,
      BR: meta.blackRank, WR: meta.whiteRank, DT: meta.date, EV: meta.event,
      GN: meta.gameName },
    standard && origRE && !/^([BW]\+|0$)/.test(origRE) ? { RE: norm } : {});
  return { meta, sgf, moves: parseSgfMoves(raw) };
}

/* ──────────────────────────── 来源 4: 新博对弈 ─────────────────────────────── */

const XINBO_WS = "wss://live.xinboduiyi.com:40442/ws";

/** 新博的大写坐标 -> SGF 小写。他们自己的换算: >= 'I' 加 31, 否则加 32 */
const xbLetter = (ch) => {
  const o = ch.charCodeAt(0);
  return String.fromCharCode(o >= 73 ? o + 31 : o + 32);
};

/** StepStr "B[QR];W[DD];..." -> {moves, setup} */
export function parseStepStr(step) {
  const s = String(step || "").replace(/<[^<>]*>/g, ""); // 剥掉内联注解
  const moves = [], setup = [];
  for (const m of s.matchAll(/\b([BW])\[([^\]]*)\]/g)) {
    const col = m[1], val = m[2].trim();
    if (!val) continue;
    if (val.length > 2) {                       // 摆子串: 每 3 字符一组 (色+列+行)
      for (const g of (col + val).match(/.{1,3}/g) || []) {
        if (g.length === 3 && !/W/.test(g.slice(1))) setup.push([g[0], xbLetter(g[1]) + xbLetter(g[2])]);
      }
      continue;
    }
    if (val.toUpperCase() === "WW") { moves.push([col, ""]); continue; }   // 弃手
    if (val.length === 2) moves.push([col, xbLetter(val[0]) + xbLetter(val[1])]);
  }
  return { moves, setup };
}

function xinboSocket(gameKey, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(XINBO_WS);
    let buf = "";
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("新博服务器无响应")); }, timeout);
    const done = (err, data) => { clearTimeout(timer); try { ws.close(); } catch {} err ? reject(err) : resolve(data); };
    ws.onopen = () => {
      ws.send(JSON.stringify({ cmd: "1", data: "zzz123" }));       // 握手
      ws.send(JSON.stringify({                                     // 取谱
        cmd: "7", lang: "zh-Hans",
        data: { game_key: gameKey, qipu_id: "", pinglun_id: "", qipu_type: "",
                is_creator: "", lang: "zh-Hans", noComments: false, keyType: "gameKey" },
      }));
    };
    ws.onmessage = (ev) => {
      buf += ev.data;                                              // 帧按 \r\n 分隔
      const parts = buf.split("\r\n"); buf = parts.pop();
      for (const line of parts) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (String(m.cmd) === "6" && m.data && typeof m.data === "object") return done(null, m.data);
      }
    };
    ws.onerror = () => done(new Error("连接新博服务器失败"));
    ws.onclose = () => done(new Error("连接已关闭且未收到对局数据 (gamekey 可能无效)"));
  });
}

async function fetchXinbo(gameKey) {
  const g = await xinboSocket(gameKey);
  const { moves, setup } = parseStepStr(g.StepStr);
  if (!moves.length) throw new Error("该对局还没有着手");
  const detail = String(g.ResultDetail || "").trim();
  const end = String(g.EndStr || "").trim();
  if (!detail) throw new NotFinishedError(`已走 ${moves.length} 手`);
  const side = { "黑胜": "B", "白胜": "W" }[detail];
  const margin = end.includes("认输") ? "R" : end.includes("超时") ? "T" : "";
  const meta = {
    source: "xinbo", kind: "live", id: g.GameKey || gameKey,
    black: g.BlackAliasName || "Black", white: g.WhiteAliasName || "White",
    blackRank: "", whiteRank: "",
    boardSize: Number(g.BoardSize || 19) || 19,
    komi: g.komi_value == null || g.komi_value === "" ? 7.5 : Number(g.komi_value),
    rule: Number(g.resultType || 2) === 2 ? "cn" : "jp",
    handicap: Number(g.Handi || 0),
    date: g.GameTime || "", event: g.match_name || "",
    result: side ? `${side}+${margin}` : "",
    resultText: [detail, end].filter(Boolean).join(" · "),
    endMode: end, handsCount: moves.length, status: "ended",
    timeLimit: 0, gameName: `新博对弈 ${g.GameKey || gameKey}`,
    url: `https://weiqi.xinboduiyi.com/golive/index.html?gamekey=${encodeURIComponent(g.GameKey || gameKey)}&gametype=eye&lang=zh-Hans`,
  };
  return { meta, moves, setup };
}

/* ──────────────────────────────── 统一入口 ──────────────────────────────────── */

/** 链接 -> {sgf, meta, moves}; 任何一步失败都抛带中文说明的 Error */
export async function fetchGame(url) {
  const t = detect(url);
  const got = t.source === "xinbo" ? await fetchXinbo(t.id)
            : t.kind === "sgf" ? await fetchYikeSgfDetail(t.id, t.type)
            : t.kind === "golive" ? await fetchYikeGolive(t.id)
            : await fetchYikeGame(t.id);
  const { meta, moves, setup = [] } = got;
  if (!moves.length) throw new Error("棋谱里没有着手");
  if (meta.handsCount && meta.handsCount !== moves.length) meta.handsMismatch = meta.handsCount;
  // 来源已给出完整 SGF 的直接用, 其余按 meta+moves 组装
  return { sgf: got.sgf || toSgf(meta, moves, setup), meta, moves };
}

/** 建议的文件名, 如 "弈客围棋-80246918-黑方名-白方名.sgf" */
export function suggestFilename(meta) {
  const label = { yikeweiqi: { golive: "弈客直播", sgf: "弈客棋谱", game: "弈客围棋" }[meta.kind] || "弈客围棋",
                  xinbo: "新博对弈" }[meta.source] || meta.source;
  const safe = (s) => String(s || "").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 24);
  return `${label}-${safe(meta.id)}-${safe(meta.black)}-${safe(meta.white)}.sgf`;
}

export const SUPPORTED = SOURCES.map(({ source, kind }) => ({ source, kind }));
