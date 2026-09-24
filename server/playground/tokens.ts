// Token 本地估算（官方未公布分语言口径，此为保守上界）：
// ASCII（含半角标点）按 0.5，非 ASCII（中日韩及全角，约 1 token/字）按 1。
// 方向只取高估：预算护栏用它不会把超限放过去，费用估算宁可多算；
// 精确值以官方 usage 实测为准（Jev 响应 usage 必填，chat 多数情况也带）。
export function estimateTokens(text: string): number {
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) <= 0xff) ascii++
    else wide++
  }
  return Math.ceil(ascii / 2 + wide)
}
