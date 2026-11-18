// 原子写文件：先写同目录的临时文件再改名。她的规则、名单写到一半断电 / 出错，原文件也不会坏成半截。
import { chmodSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function writeFileAtomic(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // 保留原文件的权限（名单是 600，换成新文件不能变成别人可读）
  let mode = 0o644;
  try { mode = statSync(path).mode & 0o7777; } catch { /* 新文件 */ }
  const tmp = join(dir, `.${basename(path)}.${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);   // 不受 umask 影响
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 没写出来 */ }
    throw e;
  }
}
