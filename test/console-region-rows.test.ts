// 时间线只看一个脑区：/api/central?src= 只给这一个来源的记录；页面选了脑区，就拿它往前要这个脑区自己的。
// 起因（11-14 线上）：页面手里只有最近 600 条，夜里整理半小时海马就记了 599 条，这时点「主线」是空的，看着像她没干活。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { events, openReadOnly } from "../src/console/data.ts";
import { createConsole } from "../src/console/server.ts";
import { CentralMemory } from "../src/memory/central.ts";
import { openDb } from "../src/store/db.ts";
import { consoleSource } from "./console-web.ts";
import { tmpDir } from "./tmp.ts";
import { OPEN_READS } from "./console-reads.ts";

const T0 = Date.UTC(2026, 10, 12, 3, 0);

/** 主线早上说了三句（1–3），然后海马忙了三十条（4–33），主线插了一句（34），海马又是十条（35–44） */
function fixture(): { dir: string; dbPath: string } {
  const dir = tmpDir("hh-region-rows-");
  const dbPath = join(dir, "hh.db");
  const db = openDb(dbPath);
  let t = T0;
  const central = new CentralMemory(db, () => (t += 1000));
  for (let i = 1; i <= 3; i++) central.append(1, "main", "say", `主线第 ${i} 句`);
  for (let i = 1; i <= 30; i++) central.append(1, "hippocampus", "act", `整理 ${i}`);
  central.append(1, "main", "say", "主线第 4 句");
  for (let i = 31; i <= 40; i++) central.append(1, "hippocampus", "act", `整理 ${i}`);
  db.close();
  return { dir, dbPath };
}
const seqs = (rows: Array<{ seq: number }>): number[] => rows.map((r) => r.seq);

test("region rows: the latest rows can hold nothing of a region that was busy earlier; asked by source, its own rows come back, oldest first", () => {
  const f = fixture();
  const db = openReadOnly(f.dbPath);
  try {
    assert.deepEqual([...new Set(events(db, { limit: 8 }).map((r) => r.src))], ["hippocampus"], "最近 8 条全是海马：光在这里面筛，主线是空的");
    assert.deepEqual(seqs(events(db, { src: "main" })), [1, 2, 3, 34]);
    assert.deepEqual(seqs(events(db, { src: "main", limit: 2 })), [3, 34], "最后两条");
    assert.deepEqual(seqs(events(db, { src: "main", before: 34, limit: 2 })), [2, 3], "往前翻：这之前的最后两条");
    assert.deepEqual(seqs(events(db, { src: "main", before: 2 })), [1]);
    assert.deepEqual(seqs(events(db, { src: "main", before: 1 })), []);
    assert.deepEqual(seqs(events(db, { src: "main", after: 2 })), [3, 34]);
    assert.deepEqual(seqs(events(db, { src: "hippocampus", limit: 3 })), [42, 43, 44]);
    assert.deepEqual(events(db, { src: "nobody" }), []);
    // 不给 src：和原来一样
    assert.deepEqual(seqs(events(db, { limit: 3 })), [42, 43, 44]);
    assert.deepEqual(seqs(events(db, { before: 4, limit: 2 })), [2, 3]);
  } finally { db.close(); }
});

test("region rows: /api/central takes ?src= together with before / after / limit, and treats it as a plain value", async () => {
  const f = fixture();
  const server = createConsole({ tell: OPEN_READS,
    dbPath: f.dbPath, sockPath: join(f.dir, "no.sock"), helperSessionsDir: join(f.dir, "cc"), projectsDir: join(f.dir, "projects"), logPath: join(f.dir, "hh.jsonl"),
    pageHtml: "<!doctype html><title>t</title>", now: () => T0,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (q: string): Promise<{ rows: Array<{ seq: number; src: string }>; maxSeq: number }> => await (await fetch(base + "/api/central" + q)).json() as { rows: Array<{ seq: number; src: string }>; maxSeq: number };
  try {
    const page = await get("?limit=200&src=main&before=35");
    assert.deepEqual([seqs(page.rows), page.maxSeq], [[1, 2, 3, 34], 44]);
    assert.deepEqual(seqs((await get("?src=main&before=34&limit=2")).rows), [2, 3]);
    assert.deepEqual(seqs((await get("?src=hippocampus&after=40")).rows), [41, 42, 43, 44]);
    assert.deepEqual((await get("?src=" + encodeURIComponent("main' OR '1'='1"))).rows, [], "当成一个名字去比，不是拼进查询里");
    assert.deepEqual(seqs((await get("?src=&limit=2")).rows), [43, 44], "空的 src 等于没给");
    assert.equal((await fetch(base + "/api/central?src=main", { method: "POST" })).status, 405);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("region rows: with a region selected the page asks for that region's own earlier rows, draws them ahead of what it holds, and the region card counts them too", () => {
  const src = consoleSource();
  // 向服务端要的是这个脑区自己的、接在手里最早那条之前
  assert.match(src, /fetch\("\/api\/central\?limit=" \+ REGION_PAGE \+ "&src=" \+ encodeURIComponent\(src\) \+ "&before=" \+ before\)/);
  assert.match(src, /const before = more\.rows\.length \? more\.rows\[0\]\.seq : firstSeq;/);
  // 手里太少才自己去要；数的是它全部的记录，不管勾选和搜索（不然筛得一条不剩时会一页页要个没完）
  assert.match(src, /const asking = !!more && olderLeft && !more\.failed && mine < REGION_MIN;/);
  assert.match(src, /if \(selected && r\.src === selected\) mine\+\+;\s*if \(!listed\(r\)\) continue;/);
  // 「更早的」在只看一个脑区时翻的是它自己的
  assert.match(src, /b\.addEventListener\("click", selected \? \(\) => loadRegionOlder\(selected, true\) : loadOlder\);/);
  // 这一段的开头变了（整个大脑往上翻了、或者丢掉了最早的一截）：在路上的那一页作废
  assert.match(src, /if \(era !== regionEra\) \{ if \(selected === src\) renderAll\(\); return; \}/);
  // 脑区卡片上「最后一条」「最后一次动手」也看得到这一段以前的
  assert.match(src, /const mine = rowsOf\(selected\);/);
  // 空的时候三种说法分开：还在找、没取到（不代表没动过）、真的没有
  assert.match(src, /asking \? T\("timeline\.regionLoading", \{ name \}\) : more\.failed \? T\("timeline\.regionFailed", \{ name, error: more\.failed \}\) : T\("timeline\.emptyRegion", \{ name \}\)/);
});
