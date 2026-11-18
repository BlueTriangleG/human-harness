// Words, for the association when there are no vectors (no OpenAI key): Han runs as character pairs, other letters and
// digits as lower-cased words of three or more. Two texts are as close as the words they share.
const HAN = /[㐀-鿿]+/g;

export function wordsOf(s: string): Set<string> {
  const out = new Set<string>();
  for (const run of s.match(HAN) ?? []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  for (const w of s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) out.add(w);
  return out;
}

export function sharedWords(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}
