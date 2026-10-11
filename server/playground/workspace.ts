// Run-scoped file store — the "file-backed state" a harness config can mount.
//
// Design §13 gives the general-domain preset C1 exactly one knob:
// `filesystem=file-backed-state`, described as "key scope written to a file
// first" (long dossiers + injection defence). That knob only means anything if
// the runner actually hands the material over *as files* instead of pasting it
// into the prompt — which is what this module provides.
//
// The same store is what `sandbox=write-barrier` has to guard: a write barrier
// with nothing writable is a label, not a control. So a run gets a workspace
// whenever it is file-backed OR sandboxed.
import type { ChatToolSpec } from './llmClient'

export interface WorkspaceFile {
  path: string
  content: string
}

export interface WorkspaceListing {
  path: string
  chars: number
}

export interface WorkspaceRead {
  content: string
  chars: number
  truncated: boolean
}

export interface Workspace {
  list(): WorkspaceListing[]
  /** null = no such file. Reads are always allowed; only writes are gated. */
  read(path: string, start: number, maxChars: number): WorkspaceRead | null
  write(path: string, content: string): void
  has(path: string): boolean
}

/** A single read is capped so one call cannot blow the context budget. */
export const FS_READ_MAX_CHARS = 12_000

export function createWorkspace(seed: WorkspaceFile[] = []): Workspace {
  const files = new Map<string, string>()
  for (const f of seed) files.set(f.path, f.content)
  return {
    list: () =>
      [...files.entries()]
        .map(([p, c]) => ({ path: p, chars: c.length }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    read: (p, start, maxChars) => {
      const c = files.get(p)
      if (c == null) return null
      const from = Math.max(0, start)
      const slice = c.slice(from, from + Math.min(Math.max(1, maxChars), FS_READ_MAX_CHARS))
      return { content: slice, chars: c.length, truncated: from + slice.length < c.length }
    },
    write: (p, c) => {
      files.set(p, c)
    },
    has: (p) => files.has(p),
  }
}

/** The one tool whose effect is a write — the sandbox gate keys off this. */
export const FS_WRITE_TOOL = 'fs_write'

/**
 * File tools. Declared separately from the MCP toolset so the two can be
 * mounted independently: C1 gets only these, C2 only the MCP's, C3 only these.
 */
export const FS_TOOL_SPECS: ChatToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'fs_list',
      description: '列出本次工作区内的文件（路径与字符数）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_read',
      description: '读取工作区内某个文件的内容；长文件可分段读取。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'fs_list 返回的文件路径' },
          start: { type: 'number', description: '起始字符偏移，默认 0' },
          maxChars: { type: 'number', description: `本次最多读取的字符数，上限 ${FS_READ_MAX_CHARS}` },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: FS_WRITE_TOOL,
      description: '把内容写入工作区文件（同名覆盖）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目标文件路径' },
          content: { type: 'string', description: '要写入的全文' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
]

/** What a tool does, so the sandbox gate has something to read. */
export function toolEffect(name: string): 'read' | 'write' {
  return name === FS_WRITE_TOOL ? 'write' : 'read'
}

/** Manifest text handed to the model instead of the file contents. */
export function manifestText(files: WorkspaceListing[]): string {
  if (files.length === 0) return '（工作区为空）'
  return files.map((f) => `- ${f.path}（${f.chars} 字）`).join('\n')
}
