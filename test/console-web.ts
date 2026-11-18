// 控制台网页的源码：骨架（按中文出好的）加名单里的样式和脚本，拼成一个字符串。给「页面里有这个写法」的断言用。
import { join } from "node:path";
import { loadWeb } from "../src/console/web.ts";
import { renderPage } from "../src/console/lang/index.ts";

export const WEB_DIR = join(import.meta.dirname, "../src/console/web");

/**
 * 页面脚本是 ES 模块。测试里把其中一个放进 vm 当普通脚本跑时，去掉开头的 import 行和末尾那张 export 名单，剩下的就是它自己的代码。
 * 只给不碰页面的那几个文件用（i18n、sent、sides）。
 */
export function asPlainScript(src: string): string {
  return src.replace(/^import [^\n]*\n/gm, "").replace(/^export \{[^}]*\};\n/gm, "");
}

export function consoleSource(): string {
  const w = loadWeb(WEB_DIR);
  return [renderPage(w.pageHtml, "zh", { me: "小满", owner: "阿树", ta: "她" }), ...[...w.assets.values()].map((a) => a.body)].join("\n");
}
