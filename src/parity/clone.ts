// 对照工具的克隆：每个场景的子进程起来时，把快照的 home 拷成工作副本 <work>/home，临时目录 <work>/tmp 清空重建。
// 文件、目录由 fs.cpSync 拷（这时围栏已经装好：这是进程里第一次 cpSync，Node 这时把它内部用的 fs 函数抓成包过的，树后来自己 cpSync 也过围栏）。
// 符号链接自己建（在 cpSync 的 filter 里，轮到它的那一刻：它的上级目录已经建好、权限还没改成快照里的——只读的目录里也建得进去）：
// 快照里的链接是照抄的输入，不是树的错——指到系统文件、别处的照原样留着，不过围栏里「目标得在草稿区里」那一条
// （顺着它往外写内核照样不让）；指进真 home 的换到工作副本里同一个位置，跟配置里的路径一样，克隆出来的东西自成一体、谁也不去读真 home。
import fs, { chmodSync, constants, cpSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isWithin } from "./fence.ts";

/** 没包过的 symlinkSync（这个文件一加载就记下，那时围栏还没装）：只给克隆建快照里的链接用，不留记录——它们是输入，两棵树一样 */
const symlinkAsIs = fs.symlinkSync;

/** 快照里一个链接在工作副本里指哪儿：绝对的、落在真 home 里的换到 cloneHome 下面同一个位置；相对的、指到别处的原样 */
function cloneTarget(target: string, liveHome: string, cloneHome: string): string {
  if (!isAbsolute(target)) return target;
  const abs = resolve(target);
  return isWithin(abs, liveHome) ? join(cloneHome, abs.slice(liveHome.length)) : target;
}

/** 上一次的克隆整个删掉。里面照抄了快照的权限：只读的目录（0555）里的东西删不动，先把目录都改成自己可写 */
function removeClone(dst: string): void {
  const unlock = (dir: string): void => {
    chmodSync(dir, 0o700);
    for (const d of readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) unlock(join(dir, d.name));
  };
  let st;
  try { st = lstatSync(dst); } catch { return; }
  if (st.isDirectory()) unlock(dst);
  rmSync(dst, { recursive: true, force: true });
}

/**
 * 克隆快照：先删再拷。写时复制（APFS 上大库也快）；修改时间照抄（系统按文件新旧做判断，每次要一样）；secrets.json 不拷；
 * 链接在 filter 里轮到它时当场建（换过去的目标在工作副本里没有的，就是一个悬空的链接：快照里就是这样）。liveHome 是快照里写的真 home
 */
export function cloneSnapshot(data: string, work: string, liveHome: string): void {
  const src = join(data, "home");
  const dst = join(work, "home");
  removeClone(dst);
  cpSync(src, dst, {
    recursive: true, mode: constants.COPYFILE_FICLONE, preserveTimestamps: true,
    filter: (p, to) => {
      if (basename(p) === "secrets.json") return false;
      if (p === src || !lstatSync(p).isSymbolicLink()) return true;
      symlinkAsIs(cloneTarget(readlinkSync(p), liveHome, dst), to);
      return false;
    },
  });
  chmodSync(dst, 0o700);
  const tmp = join(work, "tmp");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { mode: 0o700 });
}
