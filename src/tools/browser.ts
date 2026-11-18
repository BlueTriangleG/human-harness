// browser: the role's own Chrome, its logins kept; which ones the description names is the role's (browser.logins).
// HH drives it directly, not through openclaw's browser command line; the actions match that command's one for one:
// open / snapshot / click / type / evaluate / screenshot / upload / tabs / stop…
import { z } from "zod";
import type { Page } from "playwright-core";
import type { ToolDef } from "../kernel/types.ts";
import type { ToolContext } from "./hhtools.ts";
import { evalSource } from "../browser/chrome.ts";
import { T } from "../lang/index.ts";

const ACTIONS = ["open", "navigate", "back", "tabs", "focus", "close", "snapshot", "click", "type", "press", "evaluate", "screenshot", "upload", "wait", "status", "start", "stop"] as const;
type Action = (typeof ACTIONS)[number];

/** 页面结构太长时截到这么多字（她可以用 max 要更多） */
const SNAPSHOT_MAX = 20_000;
const RESULT_MAX = 8_000;

/** 一个动作最多等这么久（页面卡死、evaluate 一直不回时不把这一轮堵住；wait 另算） */
const ACTION_MAX_MS = 120_000;

const cut = (s: string, n: number) => (s.length > n ? T.browser.clipped(s.slice(0, n), s.length - n) : s);

async function where(p: Page, id: string): Promise<string> {
  const title = await p.title().catch(() => "");
  return T.browser.where(id, title, p.url());
}

/** ref（snapshot 里的 e12）或 CSS 选择器 → 页面上的那个东西 */
function target(p: Page, a: { ref?: string; selector?: string }) {
  if (a.ref) return p.locator(`aria-ref=${a.ref.replace(/^ref=/, "")}`);
  if (a.selector) return p.locator(a.selector).first();
  return null;
}

export function browserTool(ctx: ToolContext): ToolDef {
  return {
    name: "browser",
    description: T.browser.description.replace("{logins}", () => ctx.browser?.o?.logins ?? T.browser.loginsDefault),
    shape: {
      action: z.enum(ACTIONS),
      url: z.string().optional(),
      tab: z.string().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      text: z.string().optional(),
      submit: z.boolean().optional(),
      slowly: z.boolean().optional(),
      key: z.string().optional(),
      js: z.string().optional(),
      files: z.array(z.string()).optional(),
      full: z.boolean().optional(),
      ms: z.number().optional(),
      max: z.number().optional(),
    },
    handler: async (args) => {
      const chrome = ctx.browser;
      if (!chrome) return T.browser.noBrowser;
      const a = args as { action: Action; url?: string; tab?: string; ref?: string; selector?: string; x?: number; y?: number; text?: string; submit?: boolean; slowly?: boolean; key?: string; js?: string; files?: string[]; full?: boolean; ms?: number; max?: number };
      const limit = a.action === "wait" ? Math.min(a.ms ?? 15_000, 60_000) + 15_000 : ACTION_MAX_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<string>((r) => {
        timer = setTimeout(() => r(T.browser.timedOut(limit / 1000)), limit);
      });
      try {
        return await Promise.race([act(chrome, a), late]);
      } finally {
        clearTimeout(timer);
      }
    },
  };

  async function act(chrome: NonNullable<ToolContext["browser"]>, a: { action: Action; url?: string; tab?: string; ref?: string; selector?: string; x?: number; y?: number; text?: string; submit?: boolean; slowly?: boolean; key?: string; js?: string; files?: string[]; full?: boolean; ms?: number; max?: number }): Promise<string> {
      const who = ctx.regionId;
      try {
        switch (a.action) {
          case "status": {
            if (!(await chrome.running())) return T.browser.notRunning;
            return T.browser.running((await chrome.pages()).length);
          }
          case "start": {
            const { started } = await chrome.connect();
            return started ? T.browser.started : T.browser.alreadyRunning;
          }
          case "stop": {
            const others = chrome.othersUsing(who);
            if (others.length) return T.browser.stopHeld(others.map((o) => ({ who: o.who, tab: chrome.idOf(o.page) })));
            return (await chrome.stop()) ? T.browser.stopped : T.browser.alreadyStopped;
          }
          case "tabs": {
            const pages = await chrome.pages();
            if (!pages.length) return T.browser.noTabs;
            const cur = chrome.currentOf(who);
            const lines = await Promise.all(pages.map(async (p) => `${p === cur ? T.browser.currentMark : "  "}${await where(p, chrome.idOf(p))}`));
            return lines.join("\n");
          }
          case "open": {
            const p = await chrome.newPage(who);
            if (a.url) await p.goto(a.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            return T.browser.opened(await where(p, chrome.idOf(p)));
          }
          case "close": {
            if (!a.tab && !chrome.currentOf(who)) return T.browser.closeWhich;
            const p = await chrome.page(who, a.tab);
            const id = chrome.idOf(p);
            await p.close();
            return T.browser.closed(id);
          }
        }
        const p = await chrome.page(who, a.tab);
        p.setDefaultTimeout(10_000);
        const id = chrome.idOf(p);
        switch (a.action) {
          case "focus":
            await p.bringToFront();
            return T.browser.nowAt(await where(p, id));
          case "navigate":
            if (!a.url) return T.browser.navigateNeedsUrl;
            await p.goto(a.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            return T.browser.arrived(await where(p, id));
          case "back":
            await p.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
            return T.browser.wentBack(await where(p, id));
          case "snapshot": {
            const snap = await p.ariaSnapshot({ mode: "ai", timeout: 20_000 } as Parameters<Page["ariaSnapshot"]>[0]);
            return `${await where(p, id)}\n${cut(snap, a.max ?? SNAPSHOT_MAX)}`;
          }
          case "click": {
            const t = target(p, a);
            if (t) await t.click();
            else if (a.x !== undefined && a.y !== undefined) await p.mouse.click(a.x, a.y);
            else return T.browser.clickNeeds;
            await p.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
            return T.browser.clicked(await where(p, id));
          }
          case "type": {
            const t = target(p, a);
            if (!t || a.text === undefined) return T.browser.typeNeeds;
            if (a.slowly) await t.pressSequentially(a.text, { delay: 30 });
            else await t.fill(a.text);
            if (a.submit) await t.press("Enter");
            return a.submit ? T.browser.typedSubmitted(await where(p, id)) : T.browser.typed;
          }
          case "press":
            if (!a.key) return T.browser.pressNeedsKey;
            await p.keyboard.press(a.key);
            return T.browser.pressed(a.key);
          case "evaluate": {
            if (!a.js) return T.browser.evaluateNeedsJs;
            const v = await p.evaluate(evalSource(a.js));
            if (v === undefined) return T.browser.evaluatedNothing;
            return cut(typeof v === "string" ? v : JSON.stringify(v, null, 1), a.max ?? RESULT_MAX);
          }
          case "screenshot": {
            const file = chrome.shotPath(a.full ? "jpeg" : "png");
            const t = target(p, a);
            if (t) await t.screenshot({ path: file });
            else await p.screenshot({ path: file, fullPage: Boolean(a.full), ...(a.full ? { type: "jpeg" as const, quality: 80 } : {}) });
            return T.browser.shot(file);
          }
          case "upload": {
            if (!a.files?.length) return T.browser.uploadNeedsFiles;
            await (target(p, a) ?? p.locator("input[type=file]").first()).setInputFiles(a.files);
            return T.browser.uploaded(a.files);
          }
          case "wait":
            if (a.text) await p.getByText(a.text).first().waitFor({ timeout: Math.min(a.ms ?? 15_000, 60_000) });
            else await p.waitForTimeout(Math.min(a.ms ?? 1000, 30_000));
            return a.text ? T.browser.textAppeared(a.text) : T.browser.waited;
        }
        return T.browser.unknownAction(a.action);
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 400);
        if (/aria-ref/.test(msg)) return T.browser.refGone(a.ref);
        if (/Execution context was destroyed|navigation/i.test(msg)) return T.browser.navigatedAway(msg);
        return T.browser.failed(msg);
      }
  }
}
