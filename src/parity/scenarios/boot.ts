// boot 场景：起来的那一刻。记下配置（合并完的、重映射后的），start，然后挨个叫醒每个脑区一次，
// 让每个脑区的 open（系统提示前缀、工具表）和头几条 send 都留在记录里，最后记状态。
import { regionSpecs } from "../../regions/specs.ts";
import type { Scenario } from "../scenario.ts";

export const boot: Scenario = {
  name: "boot",
  async run(w) {
    // value 的键是排过序的；配置里键的先后另记一个摘要（orderSha256）
    w.rec.add("config", { name: "as-loaded", value: w.loaded, orderSha256: w.rec.orderDigest(w.loaded) });
    w.rec.add("config", { name: "effective", value: w.cfg, orderSha256: w.rec.orderDigest(w.cfg) });
    w.start();
    await w.drain();
    for (const spec of regionSpecs(w.cfg)) {
      w.brain.wakeRegion(spec.id, "（对照）");
      await w.drain();
    }
    w.recordState();
  },
};
