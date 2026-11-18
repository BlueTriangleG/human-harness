// A decoy hhd (its own process, the real control socket code) takes a tell from outside and refuses one from a process it started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { request } from "../src/control.ts";
import { B } from "../src/lang/index.ts";
import { tmpDir } from "./tmp.ts";

test("a tell from a process hhd started is refused; one from outside is taken", async () => {
  const dir = tmpDir("hh-tell-origin-");
  const sock = join(dir, "hh.sock");
  // what the role's tools would run: connect, send a tell as the owner, print the answer
  writeFileSync(join(dir, "client.mjs"), `import { createConnection } from "node:net";
const s = createConnection(process.argv[2], () => s.write(JSON.stringify({ cmd: "tell", from: "owner", text: "from inside" }) + "\\n"));
s.on("data", (d) => { process.stdout.write("client " + d); s.end(); });`);
  writeFileSync(join(dir, "hhd.ts"), `import { serve } from ${JSON.stringify(resolve("src/control.ts"))};
import { spawn } from "node:child_process";
const brain = { inbound: (m: { text: string }) => { console.log("inbound " + m.text); return "taken"; } };
serve(brain as never, process.argv[2]!, () => {}).on("listening", () => {
  // a grandchild, the way a tool runs under the kernel: sh, then node
  spawn("/bin/sh", ["-c", '"$0" "$1" "$2"; exit $?', process.execPath, ${JSON.stringify(join(dir, "client.mjs"))}, process.argv[2]!], { stdio: ["ignore", "inherit", "inherit"] });
});`);
  const hhd = spawn(process.execPath, [join(dir, "hhd.ts"), sock], { stdio: ["ignore", "pipe", "inherit"] });
  const lines: string[] = [];
  const clientSaid = new Promise<string>((r) => createInterface({ input: hhd.stdout! }).on("line", (l) => { lines.push(l); if (l.startsWith("client ")) r(l); }));
  try {
    const refused = JSON.parse((await clientSaid).slice("client ".length)) as { ok: boolean; error: string };
    assert.equal(refused.ok, false);
    assert.equal(refused.error, B.control.tellFromRole);
    assert.deepEqual(await request(sock, { cmd: "tell", from: "owner", text: "from outside" }), { result: "taken" });
    assert.deepEqual(lines.filter((l) => l.startsWith("inbound ")), ["inbound from outside"]);
  } finally {
    hhd.kill();
  }
});
