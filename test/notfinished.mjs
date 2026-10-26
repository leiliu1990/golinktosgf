// 未终局必须被拒绝 —— 用桩 fetch/WebSocket 构造"进行中"的返回
import { fetchGame, NotFinishedError, zhResult } from "../src/golinktosgf.js";

const realFetch = globalThis.fetch, realWS = globalThis.WebSocket;
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
};

async function expectNotFinished(name, url) {
  try {
    await fetchGame(url);
    check(name, false, "没有抛错, 本应拒绝");
  } catch (e) {
    check(name, e instanceof NotFinishedError, e instanceof NotFinishedError ? e.message : "抛的是: " + e.message);
  }
}

// 1) 弈客在线对弈: status=processing
globalThis.fetch = async (u) => ({
  json: async () =>
    String(u).includes("authorizations/anonymous")
      ? { status: 0, result: { token: "stub" } }
      : { code: 0, data: { id: 1, status: "processing", result: "", hands_count: 42,
            board_size: 19, komi: 7.5, rule: "cn", sgf: "(;SZ[19];B[pd];W[dp])",
            players: { blacks: [{ name: "甲" }], whites: [{ name: "乙" }] } } },
});
await expectNotFinished("弈客在线对弈 status=processing", "https://home.yikeweiqi.com/mobile.html#/new-online-game/1");

// 2) 弈客直播室: GameResult 空
globalThis.fetch = async () => ({
  json: async () => ({ Status: 1200, Result: { live: { Id: "9", HandsCount: "88", GameResult: "",
    Content: "(;SZ[19]KM[6.5]RU[jp];B[pd];W[dp])", BlackPlayer: "甲", WhitePlayer: "乙" } } }),
});
await expectNotFinished("弈客直播室 GameResult 为空", "https://home.yikeweiqi.com/mobile.html#/golive/room/9/0/0");

// 3) 新博: ResultDetail 空
globalThis.WebSocket = class {
  constructor() { setTimeout(() => this.onopen?.(), 0); setTimeout(() => this.onmessage?.({ data:
    JSON.stringify({ cmd: "6", data: { GameKey: "Local-x", StepStr: "B[QR];W[DD];", BoardSize: 19,
      komi_value: 7.5, resultType: 2, ResultDetail: "", EndStr: "", BlackAliasName: "甲",
      WhiteAliasName: "乙" } }) + "\r\n" }), 1); }
  send() {} close() {}
};
await expectNotFinished("新博 ResultDetail 为空", "https://weiqi.xinboduiyi.com/golive/index.html?gamekey=Local-x");

// 4) 已终局的必须放行 (同样用桩, 确认拒绝逻辑没有误伤)
globalThis.WebSocket = realWS;
globalThis.fetch = async (u) => ({
  json: async () =>
    String(u).includes("authorizations/anonymous")
      ? { status: 0, result: { token: "stub" } }
      : { code: 0, data: { id: 2, status: "ended", result: "w+2.25", end_mode: "counting",
            hands_count: 2, board_size: 19, komi: 7.5, rule: "cn", began_at: "2026-01-01 00:00:00",
            sgf: "(;SZ[19];B[pd];W[dp])", players: { blacks: [{ name: "甲", grade: "5D" }], whites: [{ name: "乙", grade: "6D" }] } } },
});
try {
  const { sgf, meta } = await fetchGame("https://home.yikeweiqi.com/mobile.html#/new-online-game/2");
  check("已终局放行", /RE\[W\+2\.25\]/.test(sgf) && meta.handsCount === 2, "RE=" + (sgf.match(/RE\[[^\]]*\]/) || [])[0]);
} catch (e) { check("已终局放行", false, e.message); }

// 5) zhResult 的几个式样
const cases = [["白中盘胜","W+R"],["黑胜3目半","B+3.5"],["黑胜2子","B+4"],["和棋","0"],["白超时胜","W+T"]];
for (const [inp, want] of cases) check(`zhResult("${inp}") = ${want}`, zhResult(inp) === want, "得到 " + zhResult(inp));

globalThis.fetch = realFetch;
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
