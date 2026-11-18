// An address opened in the person's browser: macOS's open; on Linux xdg-open, where there is a desktop to open it in.
// A server or a container has none (no DISPLAY, no WAYLAND_DISPLAY, or no xdg-open): the address is then not opened,
// and whoever asked says it for the person to open themselves.
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { runProcess, type Runner } from "../util/run.ts";

const onPath = (cmd: string, path = ""): boolean => path.split(":").some((d) => {
  try { accessSync(join(d || ".", cmd), constants.X_OK); return true; } catch { return false; }
});

/** Opened (true), or not, for want of a desktop here (false); throws with why when the opener itself fails */
export async function openUrl(url: string, o: { platform?: string; env?: NodeJS.ProcessEnv; run?: Runner } = {}): Promise<boolean> {
  const platform = o.platform ?? process.platform, env = o.env ?? process.env, run = o.run ?? runProcess;
  const cmd = platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  if (platform !== "darwin" && ((!env.DISPLAY && !env.WAYLAND_DISPLAY) || !onPath(cmd, env.PATH))) return false;
  const r = await run(cmd, [url], { timeoutMs: 30_000 });
  if (r.code) throw new Error(r.stderr.trim() || `${cmd}: exit ${r.code}`);
  return true;
}
