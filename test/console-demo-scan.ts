// 英文演示里还剩哪些中文：建一份英文假数据、起控制台，把每个接口读一遍（不带语言 cookie，界面默认英文），列出带中文的地方。
// 只是看的工具，不改东西：node test/console-demo-scan.ts
import { tmpDir } from "./tmp.ts";
import { buildDemo, seedsFor, startDemo } from "./console-demo.ts";

const CJK = /[㐀-鿿！-｠　-〿]+/g;
const NOW = Date.UTC(2026, 10, 12, 3, 30);
const seeds = await seedsFor("en");
const dir = tmpDir("hh-demo-scan-");
const info = buildDemo(dir, NOW, { tz: "Australia/Melbourne", seeds });
const demo = await startDemo({ dir, port: 0, now: () => NOW, seeds });
const paths = ["/", "/api/status", "/api/events?limit=600", "/api/gate", `/api/gate?day=${info.sample.yesterday}`, "/api/learn", "/api/workers", "/api/log", "/api/activity",
  "/api/mem/midterm", "/api/mem/people", "/api/mem/events", `/api/mem/event?id=${info.sample.event}`, `/api/mem/batch?id=${encodeURIComponent(info.sample.batch)}`, "/api/mem/quotes",
  `/api/memory/block?id=${info.sample.block}`, "/api/memory", "/api/prompt?region=main", `/api/prompt?session=${info.sample.session}`, "/api/prompt/sessions?region=main"];
try {
  const people = await (await fetch(demo.url + "/api/mem/people")).json() as { people: Array<{ id: string }> };
  for (const p of people.people) paths.push(`/api/mem/person?id=${encodeURIComponent(p.id)}`);
  for (const path of paths) {
    const r = await fetch(demo.url + path);
    const text = await r.text();
    const hits = new Map<string, number>();
    for (const m of text.matchAll(CJK)) hits.set(m[0], (hits.get(m[0]) ?? 0) + 1);
    const list = [...hits].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}${n > 1 ? `×${n}` : ""}`).join("  ");
    console.log(`${r.status} ${path}  ${hits.size ? `中文 ${[...hits.values()].reduce((a, b) => a + b, 0)} 处：${list}` : "没有中文"}`);
  }
} finally { await demo.close(); }
