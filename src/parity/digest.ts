// 对照工具的状态摘要：场景最后记的 db、files 两条怎么算。
// db：user_version、整个 schema（表、索引、触发器、视图，SQL 规范化过）、每张表的行数和按 rowid 排的 sha256——迁移改了也看得出来。
// files：建世界之前记一份工作目录的样子，最后比出这一跑新建、改过、删掉的文件和目录（带权限位）。
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import type { Db } from "../store/db.ts";

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const octal = (mode: number | bigint): string => (Number(mode) & 0o7777).toString(8).padStart(4, "0");

export interface DbDigest {
  userVersion: number;
  schema: Array<{ type: string; name: string; table: string; sql: string | null }>;
  tables: Record<string, { rows: number; sha256: string }>;
}

/** normalize：每行先换路径记号、规范化（Recorder.normalize），换了工作目录也一样 */
export function dbDigest(db: Db, normalize: (v: unknown) => unknown): DbDigest {
  const userVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const schema = master.map((m) => ({ type: m.type, name: m.name, table: m.tbl_name, sql: m.sql === null ? null : m.sql.replace(/\s+/g, " ").trim() }));
  const tables: DbDigest["tables"] = {};
  for (const t of master.filter((m) => m.type === "table")) {
    // 没有 rowid 的表按主键的顺序读（SELECT * 本来就是）
    const order = /WITHOUT\s+ROWID/i.test(t.sql ?? "") ? "" : " ORDER BY rowid";
    const h = createHash("sha256");
    let rows = 0;
    for (const row of db.prepare(`SELECT * FROM "${t.name.replaceAll('"', '""')}"${order}`).iterate()) {
      h.update(`${JSON.stringify(normalize(row))}\n`);
      rows += 1;
    }
    tables[t.name] = { rows, sha256: h.digest("hex") };
  }
  return { userVersion, schema, tables };
}

/** 工作目录的样子：相对路径 → 签名（文件：大小、修改时间、inode、权限；链接：指向；目录：权限）。ignore 掉的目录整个不看 */
export function scanFiles(root: string, ignore: (rel: string) => boolean = () => false): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = relative(root, p);
      if (ignore(rel)) continue;
      const st = lstatSync(p, { bigint: true });
      if (st.isSymbolicLink()) out.set(rel, `link:${readlinkSync(p)}`);
      else if (st.isDirectory()) { out.set(rel, `dir:${octal(st.mode)}`); walk(p); }
      else out.set(rel, `file:${st.size}:${st.mtimeNs}:${st.ino}:${octal(st.mode)}`);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/**
 * 这一跑新建、改过（内容、权限）、删掉的（相对 root，按路径排）：文件 {path, sha256, mode}、链接 {path, link}、目录 {path, dir, mode}、
 * 删掉的 {path, deleted}。ignore 的不算（数据库和它的 -wal、-shm：内容 db 那条按行记了，文件字节里有随机的盐）
 */
export function changedFiles(root: string, before: Map<string, string>, ignore: (rel: string) => boolean = () => false): Array<Record<string, unknown>> {
  const after = scanFiles(root, ignore);
  const out: Array<Record<string, unknown>> = [];
  for (const [rel, sig] of after) {
    if (before.get(rel) === sig) continue;
    const p = join(root, rel);
    if (sig.startsWith("link:")) out.push({ path: rel, link: readlinkSync(p) });
    else if (sig.startsWith("dir:")) out.push({ path: rel, dir: true, mode: sig.slice(4) });
    else out.push({ path: rel, sha256: sha256(readFileSync(p)), mode: sig.slice(sig.lastIndexOf(":") + 1) });
  }
  for (const rel of before.keys()) if (!after.has(rel)) out.push({ path: rel, deleted: true });
  return out.sort((a, b) => (String(a.path) < String(b.path) ? -1 : 1));
}
