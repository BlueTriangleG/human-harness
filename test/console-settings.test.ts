// 设置 → 系统权限 (src/console/routes/settings.ts): the instance's read-only check, kept to what the page shows.
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./tmp.ts";
import { permissionsOf, settingsRoutes } from "../src/console/routes/settings.ts";
import type { ConsoleOptions } from "../src/console/server.ts";
import type { Translate } from "../src/console/lang/index.ts";

const CHECK = {
  user: "mira", judged_as: "/opt/mira/node", items: [
    { program: "/opt/mira/node", permission: "screen", name: "录屏与系统录音", why: "screenshots", status: "没给", link: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", note: "" },
    { program: "/opt/mira/node", permission: "ax", name: "辅助功能", why: "clicks", status: "已给", link: "", note: "" },
    { program: "/Applications/Other.app", permission: "screen", name: "录屏与系统录音", why: "its tool", status: "查不了", link: "javascript:alert(1)", note: "only the app can ask" },
    { program: "/opt/mira/node", permission: "odd", name: "?", why: "", status: "maybe", link: "https://example.com", note: "" },
  ],
};

const site = (o: Partial<ConsoleOptions>, now: () => number) => ({ o: o as ConsoleOptions, now, withDb: () => { throw new Error("no database here"); } });
const ask = (routes: ReturnType<typeof settingsRoutes>, q = "") => routes["/api/permissions"]!({ q: new URLSearchParams(q), tx: ((k: string) => k) as Translate, told: (e: unknown) => String(e) });

test("settings: the check's JSON is kept to what the page shows; only system settings links get through", () => {
  const p = permissionsOf(CHECK);
  assert.deepEqual([p.user, p.program], ["mira", "/opt/mira/node"]);
  assert.deepEqual(p.items.map((i) => [i.status, i.link]), [
    ["missing", CHECK.items[0]!.link], ["granted", ""], ["unknown", ""], ["unknown", ""],
  ]);
});

test("settings: /api/permissions runs the instance's command at most once a minute unless asked again; without one it says so", async () => {
  const dir = tmpDir("hh-console-perm-");
  try {
    const runs = join(dir, "runs"), script = join(dir, "check.mjs");
    writeFileSync(script, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(runs)}, "x"); console.log(${JSON.stringify(JSON.stringify(CHECK))});`);
    let t = 1_000_000;
    const routes = settingsRoutes(site({ permissionsCheck: [process.execPath, script] }, () => t));
    const first = await ask(routes);
    assert.equal(first.code, 200);
    assert.equal((first.body as { items: unknown[] }).items.length, 4);
    t += 30_000; await ask(routes);
    assert.equal(readFileSync(runs, "utf8").length, 1);
    await ask(routes, "fresh=1");
    t += 61_000; await ask(routes);
    assert.equal(readFileSync(runs, "utf8").length, 3);
    assert.deepEqual((await ask(settingsRoutes(site({}, () => t)))).body, { configured: false });
    const broken = await ask(settingsRoutes(site({ permissionsCheck: [process.execPath, "-e", "process.exit(3)"] }, () => t)));
    assert.equal(broken.code, 502);
  } finally { rmSync(dir, { recursive: true }); }
});
