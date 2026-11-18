// token 估算：只用于记账和阈值判断；有 SDK 回报的真实用量时以真实用量为准。
// 中日韩文字约 1 字 1 token，其它约 3.6 字符 1 token（偏保守）。
const CJK = /[　-鿿가-힯＀-￯]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.1 + rest / 3.6);
}
