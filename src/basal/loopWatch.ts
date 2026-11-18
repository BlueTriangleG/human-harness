// 事件循环卡顿自检（CEO 11-12）：hhd 的事件循环被一段同步重活占住时，relay 等不到回话（11-12 两天超时 10 次）。
// 每 everyMs 看一次，比预期晚到 thresholdMs 以上就报一次，报卡了多久；只记数据，不改她看到的
export function watchLoop(o: { everyMs: number; thresholdMs: number; now: () => number; onBlocked: (ms: number) => void }): () => void {
  let expected = o.now() + o.everyMs;
  const timer = setInterval(() => {
    const t = o.now();
    const late = t - expected;
    expected = t + o.everyMs;
    if (late >= o.thresholdMs) o.onBlocked(late);
  }, o.everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
