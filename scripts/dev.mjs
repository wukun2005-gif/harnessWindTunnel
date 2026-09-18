// 单命令启动入口：同时拉起 server(:4000) 与 web(:5173)，等价于 concurrently。
import { spawn } from 'node:child_process'

const procs = [
  { name: 'server', cmd: 'npm', args: ['run', 'dev:server'], color: '\x1b[36m' },
  { name: 'web', cmd: 'npm', args: ['run', 'dev:web'], color: '\x1b[35m' },
]

const children = []
for (const p of procs) {
  const c = spawn(p.cmd, p.args, { shell: true })
  children.push(c)
  const pipe = (stream, isErr) => {
    let buf = ''
    stream.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) process[isErr ? 'stderr' : 'stdout'].write(`${p.color}[${p.name}]\x1b[0m ${l}\n`)
    })
  }
  pipe(c.stdout, false)
  pipe(c.stderr, true)
  c.on('exit', (code) => {
    process.stdout.write(`${p.color}[${p.name}]\x1b[0m exited (${code})\n`)
    if (code !== null && code !== 0) shutdown(code ?? 1)
  })
}

function shutdown(code = 0) {
  for (const c of children) if (!c.killed) c.kill('SIGTERM')
  setTimeout(() => process.exit(code), 300)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
