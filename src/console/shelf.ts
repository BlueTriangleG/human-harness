// 书架扫一遍要把每一页都读出来（她现在一百多页）。右栏的学习和笔记页都要它，页面每分钟各问一次；
// 机器忙的时候扫一遍要一两秒到好几秒（11-14 线上：别人跑全套测试时 /api/notebook 2 秒上下、/api/learn 5–7 秒），
// 控制台是单线程的，这几秒别的请求都排在后面。
// 所以记着上一次扫出来的：书架目录下的文件一个都没变（哪些文件、各多大、各是什么时候改的）就不重读。只读，不写任何东西。
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanShelf } from "../learning/notebook.ts";
import type { Shelf } from "../learning/notebook.ts";

/** 往下看几层：大类 / 本 / 页，归档的可以再深几层（比 scanShelf 走得到的只多不少，多看到的文件变了无非是多扫一遍） */
const MAX_DEPTH = 8;

/**
 * 书架目录现在的样子：每个文件的相对路径、大小、修改时间拼成的一串。不读文件内容。
 * 目录读不了也记进去（记成「读不了」）：它什么时候读得了了，这一串就变了。
 */
export function shelfStamp(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { parts.push(`${rel}/ 读不了`); return; }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name), r = rel ? `${rel}/${name}` : name;
      let st: ReturnType<typeof statSync>;
      try { st = statSync(path); } catch { parts.push(`${r} 读不了`); continue; }
      if (st.isDirectory()) { if (depth < MAX_DEPTH) walk(path, r, depth + 1); else parts.push(`${r}/ 太深`); }
      else parts.push(`${r} ${st.size} ${st.mtimeMs}`);
    }
  };
  walk(root, "", 0);
  return parts.join("\n");
}

const kept = new Map<string, { stamp: string; shelf: Shelf }>();

/**
 * 扫书架。目录下的文件和上一次一模一样，就给上一次扫出来的那一份（同一个对象：拿到的人只读，不要改它）。
 * 按书架目录、「通用」那个大类的名字和归档目录的名字各记各的。
 */
export function shelfOf(root: string, generalCategory: string, archiveDir: string): Shelf {
  const key = `${root}\n${generalCategory}\n${archiveDir}`;
  const stamp = shelfStamp(root);
  const had = kept.get(key);
  if (had && had.stamp === stamp) return had.shelf;
  const shelf = scanShelf(root, generalCategory, archiveDir);
  kept.set(key, { stamp, shelf });
  return shelf;
}
