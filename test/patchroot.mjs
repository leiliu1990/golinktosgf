// 透传式补根节点: 正文(含注解与分支)必须一字不改
import { patchSgfRoot } from "../src/golinktosgf.js";

let pass = 0, fail = 0;
const check = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${n}${x ? "  " + x : ""}`); };

// 带注解、标记、分支的棋谱 —— 棋谱库里讲解谱就是这样
const rich = "(;GM[1]FF[4]PB[甲]PW[乙]RE[黑191]SZ[19]"
  + ";B[pd]C[这手是小目\\]带转义]"
  + ";W[dp]LB[dd:A][pp:B]TR[qq]"
  + ";B[cc](;W[dd]C[本手];B[ee])(;W[ee]C[变化图])"
  + ")";
const body = (s) => s.slice(s.indexOf(";B["));

const out = patchSgfRoot(rich, { CA: "UTF-8", GN: "测试", SZ: 13, PB: "丙" }, { RE: "B+" });
check("正文一字不改", body(out) === body(rich));
check("补了缺失的 CA/GN", /CA\[UTF-8\]/.test(out) && /GN\[测试\]/.test(out));
check("已有的 SZ 不被 add 覆盖", /SZ\[19\]/.test(out) && !/SZ\[13\]/.test(out));
check("已有的 PB 不被 add 覆盖", /PB\[甲\]/.test(out) && !/PB\[丙\]/.test(out));
check("override 覆盖 RE", /RE\[B\+\]/.test(out) && !/RE\[黑191\]/.test(out));
check("分支结构保留", (out.match(/\(/g) || []).length === 3);
check("注解里的转义保留", out.includes("C[这手是小目\\]带转义]"));
check("标记保留", /LB\[dd:A\]\[pp:B\]/.test(out) && /TR\[qq\]/.test(out));

// 根节点里带 ] 的值不能把解析带偏
const tricky = "(;PB[甲\\]乙]SZ[19];B[aa])";
const t2 = patchSgfRoot(tricky, { GN: "x" });
check("根节点属性值含转义 ] 时仍正确", /PB\[甲\\\]乙\]/.test(t2) && /GN\[x\]/.test(t2) && t2.includes(";B[aa]"));

// 非法输入
try { patchSgfRoot("not sgf"); check("非 SGF 抛错", false, "没抛"); }
catch { check("非 SGF 抛错", true); }

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
