// 测试用的临时目录（#0055）：建在系统临时目录下，这个测试文件跑完就删。以前建了从来不删，/tmp 里堆了几万个。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];
// 进程退出时删（node --test 一个文件一个进程）：测试挂了也照删；不用 after 钩子，测试结束后还在后台跑的东西不会撞上删掉的目录。
// 删不掉的（权限被测试改坏了）留着，不让退出报错
process.on("exit", () => {
  for (const p of made) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* 留着 */ }
  }
});

/** 等于 mkdtempSync(join(base ?? tmpdir(), prefix))，这个测试文件跑完删掉。base 只在要短路径时给（unix socket 路径 macOS 上不能超过 103 字节，系统临时目录就占了 49）（#0091） */
export function tmpDir(prefix: string, base?: string): string {
  const dir = mkdtempSync(join(base ?? tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** 测试在临时目录旁边另外建的（<目录>-exports、<线上目录>.npm-prev 这些）：跑完一起删 */
export function removeAtExit(path: string): string {
  made.push(path);
  return path;
}

/** 系统临时目录（os.tmpdir() 每次读 TMPDIR）先换成一个新的空目录，查用完的临时目录删没删干净；restore 换回去 */
export function freshTmpdir(): { dir: string; restore: () => void } {
  const dir = tmpDir("hh-tmpcheck-");
  const old = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  return { dir, restore: () => { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; } };
}
