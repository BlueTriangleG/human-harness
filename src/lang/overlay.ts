// A pack filled entry by entry: each of its parts is an overlay — the entries translated so far — laid over the
// reference pack's part, which gives every entry the overlay does not have yet. Built here and not in index.ts because
// a pack's index.ts calls overlay() while it loads, and index.ts imports the packs.
import type { Widen } from "./index.ts";

/**
 * What an overlay holds of a part shaped T: every entry optional, to any depth. A string is a string, a function keeps its
 * parameter list and returns the widened type, arrays and regular expressions are whole values (given or not).
 */
export type Overlay<T> =
  T extends string | number | boolean | RegExp | readonly unknown[] ? Widen<T> :
  T extends (...args: infer A) => infer R ? (...args: A) => Widen<R> :
  T extends object ? { [K in keyof T]?: Overlay<T[K]> } :
  T;

/**
 * The overlay O as tsc accepts it over the reference R, beyond Overlay<R> (which a module namespace with extra exports, or a
 * function with fewer parameters, still satisfies): a key R lacks is never, at any depth, and a function has R's parameter
 * list exactly.
 */
type Exact<O, R> = { [K in keyof O]: K extends keyof R ? ExactEntry<O[K], R[K]> : never };
type ExactEntry<O, R> =
  R extends (...args: infer A) => unknown ? (O extends (...args: infer B) => unknown ? ([A, B] extends [B, A] ? O : never) : O) :
  R extends string | number | boolean | RegExp | readonly unknown[] ? O :
  Exact<O, R>;

/** A group of entries, merged key by key; anything else (a string, a function, an array, a regular expression) is one entry */
const isGroup = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof RegExp);

/**
 * The reference part ref with the overlay own laid over it: own's entry where it has one, ref's where it has none, groups
 * merged key by key to any depth. Module namespace objects are fine on both sides. The result is a new object; ref is
 * never written into.
 */
export function overlay<R, O extends Overlay<R>>(ref: R, own: O & Exact<O, R>): Widen<R> {
  return lay(ref, own) as Widen<R>;
}

function lay(ref: unknown, own: unknown): unknown {
  if (own === undefined) return ref;
  if (!isGroup(ref)) return own;
  return Object.fromEntries(Object.entries(ref).map(([k, v]) => [k, lay(v, (own as Record<string, unknown>)[k])]));
}

/**
 * The overlay own against its reference ref, as dotted paths under at: the reference's entries own lacks (missing), the
 * entries own has that the reference does not (extra: never read, most likely a misspelled name), and how many entries
 * the reference has (total).
 */
export function gaps(ref: unknown, own: unknown, at: string): { total: number; missing: string[]; extra: string[] } {
  if (!isGroup(ref)) return { total: 1, missing: own === undefined ? [at] : [], extra: [] };
  const mine: Record<string, unknown> = isGroup(own) ? own : {};
  const out = { total: 0, missing: [] as string[], extra: Object.keys(mine).filter((k) => !Object.hasOwn(ref, k)).map((k) => `${at}.${k}`) };
  for (const [k, v] of Object.entries(ref)) {
    const g = gaps(v, mine[k], `${at}.${k}`);
    out.total += g.total;
    out.missing.push(...g.missing);
    out.extra.push(...g.extra);
  }
  return out;
}
