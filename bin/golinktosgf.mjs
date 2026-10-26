#!/usr/bin/env node
/**
 * golinktosgf CLI — 链接 -> SGF 文件
 *
 *   golinktosgf <链接或id> [-o 输出.sgf] [--stdout] [--json]
 *
 * 需要 Node 18+ (用到内置 fetch / WebSocket / crypto.subtle)。
 */
import { writeFileSync } from "node:fs";
import { fetchGame, suggestFilename, detect } from "../src/golinktosgf.js";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const target = argv.find((a) => !a.startsWith("-") && argv[argv.indexOf(a) - 1] !== "-o");

if (!target || flag("-h") || flag("--help")) {
  console.log(`golinktosgf — 把围棋直播/对局链接转成 SGF

用法:
  golinktosgf <链接或id> [选项]

选项:
  -o <文件>    写入指定文件 (默认按对局信息自动命名)
  --stdout     SGF 打到标准输出, 不写文件
  --json       输出对局元信息 JSON, 不写 SGF
  --json-full  一次输出 {meta, sgf, moves} JSON (供其他程序调用, 只抓一次网络)
  -h, --help   显示本帮助

支持:
  弈客围棋   .../mobile.html#/new-online-game/<id>
             .../mobile.html#/online-game/<id>
             .../mobile.html#/golive/room/<id>/0/0
  新博对弈   .../golive/index.html?gamekey=<key>

示例:
  golinktosgf "https://home.yikeweiqi.com/mobile.html#/new-online-game/80246918"
  golinktosgf 80246918 -o game.sgf
  golinktosgf "https://weiqi.xinboduiyi.com/golive/index.html?gamekey=Local-...-50572" --stdout`);
  process.exit(target ? 0 : 1);
}

try {
  if (flag("--json") && flag("--dry")) {
    console.log(JSON.stringify(detect(target), null, 2));
    process.exit(0);
  }
  const { sgf, meta, moves } = await fetchGame(target);

  if (flag("--json-full")) {
    // 给其他语言当取谱后端用: meta 与 sgf 一起给出, 避免为两样东西抓两次
    console.log(JSON.stringify({ meta, sgf, moves }));
    process.exit(0);
  }
  if (flag("--json")) {
    console.log(JSON.stringify(meta, null, 2));
    process.exit(0);
  }

  const summary = `${meta.black}${meta.blackRank ? " " + meta.blackRank : ""} vs `
    + `${meta.white}${meta.whiteRank ? " " + meta.whiteRank : ""} — `
    + `${moves.length}手, ${meta.resultText || meta.result || "棋谱未记录结果"}`
    + `${meta.date ? ", " + meta.date.slice(0, 10) : ""}`;
  console.error(summary);
  if (meta.handsMismatch) {
    console.error(`  ! 接口报 ${meta.handsMismatch} 手, 解析出 ${moves.length} 手`);
  }

  if (flag("--stdout")) {
    process.stdout.write(sgf);
  } else {
    const out = opt("-o") || suggestFilename(meta);
    writeFileSync(out, sgf, "utf8");
    console.error(`已写入 ${out}`);
  }
} catch (e) {
  console.error("错误: " + e.message);
  process.exit(1);
}
