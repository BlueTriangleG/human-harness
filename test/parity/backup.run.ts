// 「拷库的时候虚拟时间不走」的检查用的（test/parity.test.ts 起一个新进程跑它，参数是一个空的临时目录）。
// 要新进程：determinism.ts 得赶在 node:sqlite 第一次被当 ES 模块 import 之前包它的 backup，测试进程里它早就被 import 过了。
// 照场景子进程的先后：先装确定性，再照树的写法 import * as sqlite、真拷一个几兆的库（线程池里要拷好多步），
// 同时排一个 1 秒后的虚拟计时器，把时间走到 5 秒后。打出一行 JSON：两件事的先后和各自发生时的虚拟时刻。
import { join } from "node:path";
import { installDeterminism } from "../../src/parity/determinism.ts";

const dir = process.argv[2]!;
const T0 = Date.UTC(2026, 10, 1, 2, 0);
const det = installDeterminism(T0);
const sqlite = await import("node:sqlite");
const db = new sqlite.DatabaseSync(join(dir, "src.db"));
db.exec("CREATE TABLE t (x TEXT)");
const ins = db.prepare("INSERT INTO t VALUES (?)");
db.exec("BEGIN");
for (let i = 0; i < 2000; i++) ins.run(String(i).padEnd(2000, "木"));
db.exec("COMMIT");

const order: string[] = [];
setTimeout(() => order.push(`timer@${Date.now() - T0}`), 1_000);
const copied = sqlite.backup(db, join(dir, "copy.db")).then(() => { order.push(`backup@${Date.now() - T0}`); });
await det.clock.advanceTo(T0 + 5_000);
await copied;
const failed = await det.clock.run(sqlite.backup(db, join(dir, "no-such-dir", "copy.db"))).then(() => "resolved", () => "rejected");
const copy = new sqlite.DatabaseSync(join(dir, "copy.db"));
const rows = (copy.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;
console.log(JSON.stringify({ order, now: Date.now() - T0, rows, failed, wrapped: sqlite.backup === process.getBuiltinModule("node:sqlite").backup }));
process.exit(0);
