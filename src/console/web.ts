// 控制台的网页文件：骨架 index.html 加下面这张固定名单里的样式和脚本。
// 启动时一次读进内存；服务端只按名单里的地址给，不拿请求里的路径去拼文件名。
// 加文件：放进 web/，在名单里登记，再在 index.html 里引用（test/console.test.ts 看着这三处对得上）。
// 页面脚本是 ES 模块，入口是 js/start.js：各文件用到别人的东西自己 import，给别人用的列在文件末尾的 export 名单里
// （test/console-modules.test.ts 查有没有漏 import、加载时有没有用到还没准备好的东西）。
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 名单：相对 web/ 的路径，按 index.html 里引用的顺序 */
export const WEB_FILES: readonly string[] = [
  "css/base.css", "css/brain.css", "css/timeline.css", "css/side.css", "css/memory.css", "css/prompt.css", "css/events.css", "css/gate.css", "css/health.css", "css/notebook.css", "css/en.css", "css/now.css", "css/settings.css", "css/machine.css", "app/chat.css",
  "js/owner.js", "js/i18n.js", "js/core.js", "js/sent.js", "js/timeline.js", "js/sides.js", "js/brain.js", "js/toolbar.js", "js/topbar.js", "js/side.js", "js/gate.js", "js/drawer.js",
  "js/memory.js", "js/prompt.js", "js/events.js", "js/health.js", "js/shelfmap.js", "js/notebook.js", "js/now.js", "js/settings.js", "js/openai.js", "js/machine.js", "js/notify.js", "js/nav.js", "js/start.js", "app/chat.js",
];

const TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
};

export interface WebAsset { type: string; body: string }
export interface Web {
  /** 骨架 */
  pageHtml: string;
  /** 地址（/web/…）→ 内容 */
  assets: ReadonlyMap<string, WebAsset>;
}

/** 名单里一个文件的地址 */
export const webUrl = (file: string): string => `/web/${file}`;

/** 读骨架和名单里的每个文件；缺一个就报错（启动就看得见，不等到页面上少一块） */
export function loadWeb(dir: string): Web {
  const assets = new Map<string, WebAsset>();
  for (const file of WEB_FILES) {
    const type = TYPES[file.slice(file.lastIndexOf(".") + 1)];
    if (!type) throw new Error(`console web files: unknown file type on the list: ${file}`);
    assets.set(webUrl(file), { type, body: readFileSync(join(dir, file), "utf8") });
  }
  return { pageHtml: readFileSync(join(dir, "index.html"), "utf8"), assets };
}
