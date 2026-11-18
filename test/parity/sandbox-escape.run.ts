// 沙箱测试用的小脚本：一条条走 JS 围栏包不住的路——node:sqlite 原生开库、Worker 里写、cpSync 顺着目的地里已有的符号链接写、
// 把外面的文件硬链进来再写、TCP 连接、fetch、连外面的 unix socket、给别的进程发 SIGTERM、读外面的 secrets.json——外加草稿区里的写和读、
// 给自己发信号，每一条的结果（ok 或错误码）连同 insideSandbox 的回答（给的是真的父进程、给的是 launchd 的 1 号）打成一行 JSON；
// 最后用 process.execve 把自己换成 /bin/sh 再往外写一次（成没成 sh 自己打一行）。
// test/parity-sandbox.test.ts 套着 sandboxProfile 的沙箱跑它（往外的都该不成），再不套沙箱跑一遍对照（都成：这些路是真的）。
// 不叫 *.test.ts：全套测试不单独跑它。用法：node sandbox-escape.run.ts <work> <out> <outside> <port> <unix socket> <别的进程的 pid>
import { cpSync, linkSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { insideSandbox } from "../../src/parity/sandbox.ts";

const [work, out, outside, port, socket, other] = process.argv.slice(2) as [string, string, string, string, string, string];
const tried: Record<string, string> = {};
const failure = (e: unknown): string => {
  const x = e as { code?: unknown; cause?: { code?: unknown }; message?: unknown };
  return String(x.code ?? x.cause?.code ?? x.message);
};
const attempt = async (name: string, f: () => unknown): Promise<void> => {
  try { await f(); tried[name] = "ok"; } catch (e) { tried[name] = failure(e); }
};

await attempt("sqlite", () => {
  const db = new DatabaseSync(join(outside, "escape.db"));
  db.exec("CREATE TABLE t (x)");
  db.close();
});
await attempt("worker", () => new Promise((done, fail) => {
  const w = new Worker("require('node:fs').writeFileSync(require('node:worker_threads').workerData, 'x')", { eval: true, workerData: join(outside, "worker.txt") });
  w.on("error", fail);
  w.on("exit", done);
}));
// <work>/dst/f.txt 是指向 <outside>/cp-victim.txt 的符号链接
await attempt("cp", () => cpSync(join(work, "src"), join(work, "dst"), { recursive: true }));
await attempt("link", () => linkSync(join(outside, "linked.txt"), join(work, "alias")));
await attempt("writeAlias", () => writeFileSync(join(work, "alias"), "改了"));
const connect = (...where: [number, string] | [string]): Promise<void> => new Promise((done, fail) => {
  const s = net.connect(...(where as [string]));
  s.on("connect", () => { s.destroy(); done(); });
  s.on("error", fail);
});
await attempt("tcp", () => connect(Number(port), "127.0.0.1"));
await attempt("fetch", () => fetch(`http://127.0.0.1:${port}/`));
await attempt("unixSocket", () => connect(socket));
await attempt("signalOther", () => process.kill(Number(other), "SIGTERM"));
await attempt("signalSelf", () => process.kill(process.pid, 0));
await attempt("readOutsideSecrets", () => readFileSync(join(outside, "secrets.json"), "utf8"));
await attempt("readWorkSecrets", () => readFileSync(join(work, "secrets.json"), "utf8"));
await attempt("writeWork", () => writeFileSync(join(work, "inside.txt"), "x"));
await attempt("writeOut", () => writeFileSync(join(out, "inside.txt"), "x"));
// 同步写到 fd 1：下面一 execve 这个进程就没了
// 1 号进程（launchd，root 的）不管在不在沙箱里都问不到（EPERM）：它不是父进程，不能凭这个算「在沙箱里」
writeSync(1, `${JSON.stringify({ ...tried, inside: insideSandbox(process.ppid), insideWrongParent: insideSandbox(1) })}\n`);
process.execve!("/bin/sh", ["sh", "-c", "echo x > \"$0/execve.txt\" && echo 'execve: ok' || echo 'execve: denied'", outside]);
