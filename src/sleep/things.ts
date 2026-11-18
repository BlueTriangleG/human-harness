// 题和改动说到的是哪样东西：考试、交题、题库挑题都照这一个说法比（不 import 别的模块：题库、考试、host 都要用）。

/** 中央记忆的序号：#N，或者 c:N（段的工作单列原话用的写法，切换前 P7）；别的写法给 null */
export function centralRef(ref: string): number | null {
  const m = /^(?:#|c:)(\d+)$/.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

/** 事件库的编号：事件 e、经过 n、人和东西的登记 t、印象 i（切换前 P3：t、i 跟 e、n 一样认），至少 3 位（跟机械检查一样） */
export const MEM_ID = /^[enti]\d{3,}/;

/**
 * 说到的那样东西：e/n/t/i 编号，或者文件路径（跟机械检查一样在空白、「小节」、#锚点处切开，再去掉 :行号）；
 * #序号、c:序号这类说不出是哪样东西的给 ""
 */
export const thing = (s: string): string => centralRef(s) !== null ? "" : MEM_ID.exec(s.trim())?.[0] ?? s.trim().split(/[\s「#]/)[0]!.replace(/:\d+(-\d+)?$/, "");

/** ref 说到了 target：一字不差，或者两边说到的是同一样东西 */
export const mentions = (ref: string, target: string): boolean => ref === target || (thing(ref) !== "" && thing(ref) === thing(target));

/**
 * 一道题挂在这些东西上吗（题库挑「挂在改过的东西上的旧题」、全天考试挑两段都碰过的用；终审修正轮 M4）：
 * 人照名字比；文件、事件、教训跟题的出处和标签照 thing 比（「路径「小节」」「编号（注）」、只写在出处里的都算）
 */
export function touchesTags(q: { sources: string[]; tags: { who: string[]; files: string[]; events: string[]; lessons: string[] } },
  t: { who?: string[]; files?: string[]; events?: string[]; lessons?: string[] }): boolean {
  if (t.who?.some((w) => q.tags.who.includes(w))) return true;
  const want = new Set([...(t.files ?? []), ...(t.events ?? []), ...(t.lessons ?? [])].map(thing).filter(Boolean));
  if (!want.size) return false;
  return [...q.sources, ...q.tags.files, ...q.tags.events, ...q.tags.lessons].some((r) => { const x = thing(r); return x !== "" && want.has(x); });
}
