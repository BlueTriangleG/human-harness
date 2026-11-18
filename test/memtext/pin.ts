// 生成 test/memory-text.pins.json 用的：把清单里每条调用今天的指纹按 id 排好打出来（先是 env：node / icu / zod 的版本；每条是 { reply, rest? }）。
//   hh-fw node test/memtext/pin.ts > <一个草稿文件>   然后把草稿挪到 test/memory-text.pins.json
// 不直接重定向到 pins 文件：跑到一半挂了会留下半个文件。
//   hh-fw node test/memtext/pin.ts --texts   不打指纹，打 { id: { reply, rest } } 的全文，给人读、放在仓库外保存，不提交
//   （里面有记忆层自己的措辞）
import { pinsOf, textsOf } from "../textpins/lib.ts";
import { renderAll } from "./calls.ts";

const rendered = await renderAll();
const out = process.argv.includes("--texts") ? textsOf(rendered) : pinsOf(rendered);
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
