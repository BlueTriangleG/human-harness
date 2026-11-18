// Helpers: Claude Code sessions the role starts, talks to while they work, and reads back; a session wakes the role when
// it is done (scripts/cc.py and its hook, the first role's scripts moved as they were). The role runs it as the `helper`
// command; the senses collector runs this module's source "cc" for the helpers' reports. HH's hands tool, which runs it
// from the kernel today, comes over with the role's switch.
import { defineModule, z } from "../../src/modules/api.ts";

export default defineModule({
  name: "helpers",
  summary: "Claude Code helper sessions: start one, talk to it while it works, it wakes the role when it is done",
  config: {
    shape: {
      // where the helpers work (default ~/agent-tasks/<name>) and where their session records live (default: module state)
      tasksDir: z.string(), sessionsDir: z.string(),
      // OpenClaw's leak-guard plugin, whose rules a guest's task runs under; unset: guest tasks are refused
      leakGuardDir: z.string(),
      // the model every helper session runs on (opus, sonnet, haiku, default); unset: whoever sends one picks it
      model: z.string(),
      // the built-in tools a helper session gets, nothing more (the same names as the kernel's kernel.builtinTools); no
      // MCP server but those HH passes, so none of the account's connectors
      tools: z.array(z.string()),
      senses: z.record(z.string(), z.record(z.string(), z.unknown())),
      // the project board (scripts/project_board.py): which directories under <workspace>/projects are projects (globs;
      // "!dir" leaves one out), and the names the role writes its project pages with
      boardDirs: z.array(z.string()),
      boardSections: z.object({ todo: z.string(), decisions: z.string(), status: z.string(), ended: z.array(z.string()) }).partial(),
    },
    defaults: {
      tasksDir: "", sessionsDir: "", leakGuardDir: "", model: "",
      boardDirs: ["*"], boardSections: { todo: "To do", decisions: "Decisions", status: "Status:", ended: ["done", "dropped", "stopped"] },
      tools: ["Agent", "Bash", "Edit", "EnterWorktree", "ExitWorktree", "ListAgents", "Monitor", "Read", "SendMessage", "Skill", "TaskStop", "ToolSearch", "WebFetch", "WebSearch", "Write"],
      senses: { cc: { type: "command", cmd: "helper events" } },
    },
  },
  // a new session passes the load gate first
  requires: { bins: ["claude"], modules: ["load-guard"] },
  senses: ["cc"],
  senseKinds: { hands: ["cc"] },
  async check(m) {
    const r = await m.run("scripts/cc.py", ["ls"], { timeoutMs: 20_000 });
    if (r.code !== 0 || r.timedOut) return [{ status: "broken", text: (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join("\n") }];
    const dir = (await m.run("scripts/cc.py", ["untrusted"], { timeoutMs: 20_000 })).stdout.trim();
    if (dir) return [{ status: "setup", text: `Claude Code does not trust ${dir} yet, so helpers there run as claude -p (about twice the quota): run claude in it once and accept the prompt` }];
    return [{ status: "ok", text: r.stdout.trim().split("\n")[0] ?? "" }];
  },
});
