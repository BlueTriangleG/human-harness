// What a kernel session is given: the kernel's own tools by an explicit list (config kernel.builtinTools, or the region's
// own), and no MCP server but the ones HH passes. Found 11-15: with nothing said, the kernel hands a role every tool it
// ships (push notifications, remote triggers, schedules, …) and the connectors of the signed-in account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { givenOf, sessionOptions } from "../src/kernel/sdk.ts";
import type { SessionSpec } from "../src/kernel/types.ts";
import { makeBrain, testConfig } from "./helpers.ts";

const LIST = ["Agent", "Bash", "Edit", "EnterWorktree", "ExitWorktree", "ListAgents", "Monitor", "Read", "SendMessage", "Skill", "TaskStop", "ToolSearch", "WebFetch", "WebSearch", "Write"];
/** Kernel tools that send, schedule or start things outside HH's outbound filter and simulated sending: never a default */
const GO_ROUND_HH = ["PushNotification", "RemoteTrigger", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "Workflow", "DesignSync", "SendUserMessage", "SendUserFile"];

test("kernel tools: the default list is the fifteen, and none of the tools that go round HH is on it", () => {
  const list = testConfig().kernel.builtinTools;
  assert.deepEqual(list, LIST);
  assert.deepEqual(list.filter((t) => GO_ROUND_HH.includes(t)), []);
});

test("kernel tools: a session is opened with exactly the spec's list, only the MCP servers passed, and no settings file", () => {
  const spec = { model: "opus-x", permissionMode: "bypassPermissions", tools: [], systemAppend: "", cwd: "/tmp", builtinTools: ["Read", "Bash"], mcpServers: { bili: { command: "x" } } } as unknown as SessionSpec;
  const o = sessionOptions(spec, { name: "self" } as never);
  assert.deepEqual(o.tools, ["Read", "Bash"]);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.settingSources, []);
  assert.deepEqual(Object.keys(o.mcpServers ?? {}).sort(), ["bili", "self"]);
});

test("kernel tools: every region opens with the config's list unless its spec names its own; an instance may name another list", () => {
  const t = makeBrain({ gate: { enabled: false }, regions: { perception: ["messages"] } });
  t.brain.wakeRegion("main", "回一下");
  t.brain.wakeRegion("side-1", "看一下");
  t.brain.fromSenses("B站 有人回复了你");
  assert.deepEqual(t.driver.latest("main").spec.builtinTools, LIST);
  assert.deepEqual(t.driver.latest("side-1").spec.builtinTools, LIST);
  assert.deepEqual(t.driver.latest("perception-messages").spec.builtinTools, ["Read", "Grep", "Glob"], "a region with its own list keeps it");
  const own = makeBrain({ kernel: { builtinTools: ["Bash", "Read"] } });
  own.brain.wakeRegion("main", "回一下");
  assert.deepEqual(own.driver.latest("main").spec.builtinTools, ["Bash", "Read"]);
});

test("kernel tools: the session's first message says what the kernel gave it — its own tools and the MCP servers, HH's tools left out", () => {
  const init = { type: "system", subtype: "init", tools: ["Bash", "Task", "mcp__self__message", "mcp__bili__search"], mcp_servers: [{ name: "self", status: "connected" }, { name: "bili", status: "pending" }] };
  assert.deepEqual(givenOf(init), { builtin: ["Bash", "Task"], mcpServers: ["self", "bili"] });
  assert.equal(givenOf({ type: "system", subtype: "informational" }), null);
  assert.equal(givenOf({ type: "assistant" }), null);
});
