// 旁路复核日志：打到服务端 stdout（与 [playground-runner] 同口径）。
// 铁律：永不记录 apiKey；baseUrl 只记 host；答案与 state 正文不进日志。
export function jevLog(msg: string, ...args: unknown[]): void {
  console.log(`[playground-jev] ${new Date().toISOString()} ${msg}`, ...args)
}

export function jevWarn(msg: string, ...args: unknown[]): void {
  console.error(`[playground-jev] ${new Date().toISOString()} WARN ${msg}`, ...args)
}

export function llmLog(msg: string, ...args: unknown[]): void {
  console.log(`[playground-llm] ${new Date().toISOString()} ${msg}`, ...args)
}

export function llmWarn(msg: string, ...args: unknown[]): void {
  console.error(`[playground-llm] ${new Date().toISOString()} WARN ${msg}`, ...args)
}

/** baseUrl 只记 host（防 key 泄漏：key 从不在 URL 里，但 host 足够定位）。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '(bad-url)'
  }
}
