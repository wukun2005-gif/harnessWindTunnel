// M2 persistence for live playground runs — a sqlite DB fully isolated from
// both the fixture data/ tree and the knowledge DB (design §14.3).
//
// Immutable surfaces:
//   pg_events  — append-only; the module exposes inserts, never update/delete
//   pg_verdicts— revisioned; corrections add a new row, never overwrite
// The pg_runs row itself is mutable only while the run is alive (queued →
// running → scored/error); afterwards callers treat it as read-only.
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'
import type { HarnessConfig } from '../../shared/config'
import type { HarnessEvent } from '../../shared/events'
import type { LegalAssertion } from '../../shared/legal'
import type { JevJudgeResult } from '../../shared/jev'
import type { MastTag } from '../../shared/mast'
import type {
  BlastRadiusEntry,
  ControlsSnapshot,
  KillChainObservation,
  LadderRung,
  MaterialsInfo,
  PgDomain,
  PgMounts,
  PgPresetId,
  PgSplit,
  ProviderSnapshot,
  RunSource,
  RunStatus,
  RunSummary,
  ScoreResult,
} from '../../shared/playground'
import { ALL_LEGAL_CONTROLS, ALL_SECURITY_CONTROLS } from './presets'
import { designedChain } from './killChain'
import { getTask } from './evalset'

/** L0 attack id for a question, straight from the eval set annotation. */
function taskAttackId(taskId: string): string | null {
  return getTask(taskId)?.attackChain?.attackId ?? null
}

function emptyControlsSnapshot(): ControlsSnapshot {
  const security = Object.fromEntries(ALL_SECURITY_CONTROLS.map((k) => [k, false])) as ControlsSnapshot['security']
  const legal = Object.fromEntries(ALL_LEGAL_CONTROLS.map((k) => [k, false])) as ControlsSnapshot['legal']
  return { security, legal }
}

const defaultDbPath = process.env['HWT_PLAYGROUND_DB'] ?? path.resolve(process.cwd(), 'server-data', 'playground.db')

let db: DatabaseSync | null = null
let dbPathOverride: string | null = null

function dbFile(): string {
  return dbPathOverride ?? defaultDbPath
}

function getDb(): DatabaseSync {
  if (db) return db
  const file = dbFile()
  if (file !== ':memory:' && !fs.existsSync(path.dirname(file))) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }
  db = new DatabaseSync(file)
  // SQLite 默认 busy_timeout 为 0：只要有并发写就立刻抛 "database is locked"。
  // 实跑队列是并发的（runner 同时写事件/判分/观察表），创建 run 的请求也会
  // 同时写 —— 没有等待窗口时批量实跑必然丢格。改成等锁而不是失败。
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS pg_runs (
      run_id TEXT PRIMARY KEY,
      scenario_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_title TEXT NOT NULL,
      domain TEXT NOT NULL,
      split TEXT NOT NULL,
      preset_id TEXT,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'live',
      config_json TEXT NOT NULL,
      mounts_json TEXT NOT NULL DEFAULT '{}',
      provider_json TEXT,
      temperature REAL,
      seed INTEGER,
      max_tokens INTEGER,
      answer TEXT,
      tokens INTEGER,
      latency_ms INTEGER,
      error TEXT,
      materials_json TEXT,
      verdict_json TEXT,
      jev_result_json TEXT,
      failure_tags_json TEXT NOT NULL DEFAULT '[]',
      success INTEGER,
      score REAL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pg_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_pg_events_run ON pg_events(run_id);

    CREATE TABLE IF NOT EXISTS pg_verdicts (
      run_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      verdict_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, revision)
    );

    CREATE TABLE IF NOT EXISTS pg_legal_assertions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      origin TEXT NOT NULL,
      claim_text TEXT NOT NULL,
      cited_authority TEXT NOT NULL,
      label TEXT NOT NULL,
      evidence_event_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pg_assertions_run ON pg_legal_assertions(run_id);

    CREATE TABLE IF NOT EXISTS pg_config_versions (
      fingerprint TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      mounts_json TEXT NOT NULL DEFAULT '{}',
      controls_json TEXT NOT NULL,
      mapping_version TEXT NOT NULL,
      ladder_rung TEXT NOT NULL,
      ladder_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pg_materials (
      file_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      chars INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    -- L2 measured attack chain (design §15.2). The designed chain stays in
    -- data/redteam/attacks.json and is never written here: the two are
    -- separate names and neither may overwrite the other (§11.1#7).
    CREATE TABLE IF NOT EXISTS pg_killchain_observations (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      attack_id TEXT,
      derive_version TEXT NOT NULL,
      observed_stages_json TEXT NOT NULL,
      observed_blast_radius_json TEXT NOT NULL,
      breached INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pg_blast_radius_observations (
      run_id TEXT NOT NULL,
      target TEXT NOT NULL,
      via TEXT NOT NULL,
      reached INTEGER NOT NULL,
      evidence_event_ids_json TEXT NOT NULL,
      PRIMARY KEY (run_id, target)
    );
  `)

  // CREATE TABLE IF NOT EXISTS never widens a table that already exists, so a
  // database created by an earlier build keeps its old shape. Additive columns
  // added later must be declared here or every write against them throws
  // "no such column". Keep this list append-only; never drop or retype a column.
  for (const [table, column, ddl] of [
    ['pg_runs', 'jev_result_json', 'TEXT'],
  ] as const) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }

  return db
}

/** Test helper: point the store at another file (or ':memory:') and reset. */
export function useLiveDbPath(p: string): void {
  if (db) {
    try { db.close() } catch { /* already closed */ }
  }
  db = null
  dbPathOverride = p
  getDb()
}

export function liveDbFile(): string {
  return dbFile()
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ── runs ───────────────────────────────────────────────────────────────────

export interface NewRunInput {
  runId: string
  scenarioId: string
  taskId: string
  taskTitle: string
  domain: PgDomain
  split: PgSplit
  presetId: PgPresetId | null
  fingerprint: string
  config: HarnessConfig
  mounts: PgMounts
  provider: ProviderSnapshot | null
  temperature: number | null
  seed: number | null
  maxTokens: number | null
  source: RunSource
  materials: MaterialsInfo | null
  createdAt: string
}

export function insertRun(input: NewRunInput): void {
  getDb()
    .prepare(
      `INSERT INTO pg_runs (run_id, scenario_id, task_id, task_title, domain, split, preset_id, fingerprint,
        status, source, config_json, mounts_json, provider_json, temperature, seed, max_tokens,
        materials_json, failure_tags_json, created_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, NULL)`,
    )
    .run(
      input.runId,
      input.scenarioId,
      input.taskId,
      input.taskTitle,
      input.domain,
      input.split,
      input.presetId,
      input.fingerprint,
      input.source,
      JSON.stringify(input.config),
      JSON.stringify(input.mounts ?? {}),
      input.provider ? JSON.stringify(input.provider) : null,
      input.temperature,
      input.seed,
      input.maxTokens,
      input.materials ? JSON.stringify(input.materials) : null,
      input.createdAt,
    )
}

export interface RunPatch {
  status?: RunStatus
  startedAt?: string | null
  finishedAt?: string | null
  answer?: string | null
  tokens?: number | null
  latencyMs?: number | null
  error?: string | null
  verdict?: ScoreResult | null
  /** Jev side review (bypass only — never affects success/score). */
  jevResult?: JevJudgeResult | null
  success?: boolean | null
  score?: number | null
  failureTags?: MastTag[]
  /** Provider 回退发生时写回真实应答方（列表/详情的模型列读它）。 */
  provider?: ProviderSnapshot
}

export function patchRun(runId: string, patch: RunPatch): void {
  const sets: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vals: any[] = []
  if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status) }
  if (patch.startedAt !== undefined) { sets.push('started_at = ?'); vals.push(patch.startedAt) }
  if (patch.finishedAt !== undefined) { sets.push('finished_at = ?'); vals.push(patch.finishedAt) }
  if (patch.answer !== undefined) { sets.push('answer = ?'); vals.push(patch.answer) }
  if (patch.tokens !== undefined) { sets.push('tokens = ?'); vals.push(patch.tokens) }
  if (patch.latencyMs !== undefined) { sets.push('latency_ms = ?'); vals.push(patch.latencyMs) }
  if (patch.error !== undefined) { sets.push('error = ?'); vals.push(patch.error) }
  if (patch.verdict !== undefined) { sets.push('verdict_json = ?'); vals.push(patch.verdict ? JSON.stringify(patch.verdict) : null) }
  if (patch.jevResult !== undefined) { sets.push('jev_result_json = ?'); vals.push(patch.jevResult ? JSON.stringify(patch.jevResult) : null) }
  if (patch.success !== undefined) { sets.push('success = ?'); vals.push(patch.success === null ? null : patch.success ? 1 : 0) }
  if (patch.score !== undefined) { sets.push('score = ?'); vals.push(patch.score) }
  if (patch.failureTags !== undefined) { sets.push('failure_tags_json = ?'); vals.push(JSON.stringify(patch.failureTags)) }
  if (patch.provider !== undefined) { sets.push('provider_json = ?'); vals.push(JSON.stringify(patch.provider)) }
  if (sets.length === 0) return
  vals.push(runId)
  getDb().prepare(`UPDATE pg_runs SET ${sets.join(', ')} WHERE run_id = ?`).run(...vals)
}

// ── events (append-only) ─────────────────────────────────────────────────────

export function appendEvent(runId: string, ev: HarnessEvent): number {
  const database = getDb()
  const row = database.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM pg_events WHERE run_id = ?').get(runId) as { n: number }
  const seq = row.n + 1
  database.prepare('INSERT INTO pg_events (run_id, seq, event_json) VALUES (?, ?, ?)').run(runId, seq, JSON.stringify(ev))
  return seq
}

export function countEvents(runId: string): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM pg_events WHERE run_id = ?').get(runId) as { n: number }
  return row.n
}

export function getEvents(runId: string): HarnessEvent[] {
  const rows = getDb().prepare('SELECT event_json FROM pg_events WHERE run_id = ? ORDER BY seq ASC').all(runId) as Array<{ event_json: string }>
  return rows.map((r) => safeParse<HarnessEvent | null>(r.event_json, null)).filter((x): x is HarnessEvent => x !== null)
}

// ── verdicts / legal assertions (L2 fact tables) ─────────────────────────────

export function insertVerdict(runId: string, verdict: ScoreResult, revision = 1): void {
  getDb()
    .prepare('INSERT INTO pg_verdicts (run_id, revision, verdict_json, created_at) VALUES (?, ?, ?, ?)')
    .run(runId, revision, JSON.stringify(verdict), new Date().toISOString())
}

export interface LegalAssertionRow {
  runId: string
  origin: 'runtime' | 'scorer'
  claimText: string
  citedAuthority: string
  label: LegalAssertion
  evidenceEventId?: string
}

export function insertLegalAssertions(rows: LegalAssertionRow[]): void {
  if (rows.length === 0) return
  const database = getDb()
  const stmt = database.prepare(
    `INSERT INTO pg_legal_assertions (id, run_id, revision, origin, claim_text, cited_authority, label, evidence_event_id, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  )
  for (const [i, r] of rows.entries()) {
    const id = `${r.runId}-${r.origin}-${i}-${Math.random().toString(36).slice(2, 8)}`
    stmt.run(id, r.runId, r.origin, r.claimText, r.citedAuthority, r.label, r.evidenceEventId ?? null, new Date().toISOString())
  }
}

// ── kill chain / blast radius observations ──────────────────────────────────

/**
 * Store one run's measured attack chain. Upsert semantics per run: the row is
 * keyed by run_id and the derivation is a pure function of the event stream,
 * so re-deriving after a correction replaces the row rather than accumulating
 * duplicates (the event log itself stays append-only).
 */
export function insertKillChainObservation(obs: KillChainObservation, blast: BlastRadiusEntry[]): void {
  const database = getDb()
  database
    .prepare(
      `INSERT INTO pg_killchain_observations
         (run_id, task_id, attack_id, derive_version, observed_stages_json, observed_blast_radius_json, breached, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         derive_version = excluded.derive_version,
         observed_stages_json = excluded.observed_stages_json,
         observed_blast_radius_json = excluded.observed_blast_radius_json,
         breached = excluded.breached`,
    )
    .run(
      obs.runId,
      obs.taskId,
      obs.attackId,
      obs.deriveVersion,
      JSON.stringify(obs.observedStages),
      JSON.stringify(obs.observedBlastRadius),
      obs.breached ? 1 : 0,
      new Date().toISOString(),
    )

  const del = database.prepare('DELETE FROM pg_blast_radius_observations WHERE run_id = ?')
  const ins = database.prepare(
    `INSERT INTO pg_blast_radius_observations (run_id, target, via, reached, evidence_event_ids_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id, target) DO UPDATE SET
       via = excluded.via, reached = excluded.reached, evidence_event_ids_json = excluded.evidence_event_ids_json`,
  )
  del.run(obs.runId)
  for (const b of blast) {
    ins.run(obs.runId, b.target, b.via, b.reached ? 1 : 0, JSON.stringify(b.evidenceEventIds))
  }
}

export function getKillChainObservation(runId: string): KillChainObservation | null {
  const row = getDb()
    .prepare('SELECT * FROM pg_killchain_observations WHERE run_id = ?')
    .get(runId) as Record<string, string | number> | undefined
  if (!row) return null
  return {
    runId: String(row['run_id']),
    taskId: String(row['task_id']),
    attackId: row['attack_id'] == null ? null : String(row['attack_id']),
    deriveVersion: String(row['derive_version']),
    observedStages: JSON.parse(String(row['observed_stages_json'])),
    observedBlastRadius: JSON.parse(String(row['observed_blast_radius_json'])),
    breached: Number(row['breached']) === 1,
  }
}

export function getBlastRadiusObservations(runId: string): BlastRadiusEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM pg_blast_radius_observations WHERE run_id = ? ORDER BY target')
    .all(runId) as Array<Record<string, string | number>>
  return rows.map((r) => ({
    target: String(r['target']),
    via: String(r['via']) as BlastRadiusEntry['via'],
    reached: Number(r['reached']) === 1,
    evidenceEventIds: JSON.parse(String(r['evidence_event_ids_json'])),
  }))
}

// ── queue recovery ──────────────────────────────────────────────────────────

/**
 * The execution queue is in-memory, so a server restart silently drops every
 * run that was still waiting: the row stays `queued` in the DB forever and
 * neither runs nor fails. Callers use this on boot to re-admit them.
 */
export function listQueuedRunIds(): string[] {
  return (getDb().prepare("SELECT run_id FROM pg_runs WHERE status = 'queued' ORDER BY created_at").all() as Array<{ run_id: string }>)
    .map((r) => r.run_id)
}

/**
 * Runs that were mid-flight when the process died. They are neither queued nor
 * finished, so they must be closed out explicitly rather than reported as
 * still running forever.
 */
export function listOrphanedRunIds(): string[] {
  return (getDb().prepare("SELECT run_id FROM pg_runs WHERE status = 'running'").all() as Array<{ run_id: string }>)
    .map((r) => r.run_id)
}

// ── deletion ─────────────────────────────────────────────────────────────────

export interface DeleteRunResult {
  runId: string
  deleted: boolean
  /** Rows removed per table, so the caller reports what actually went. */
  events: number
  verdicts: number
  assertions: number
  killChain: number
  blastRadius: number
  reason?: 'not-found' | 'in-flight'
}

/**
 * Drop one run and every row keyed by it.
 *
 * §14.3 calls pg_events append-only, and that still holds for anything the
 * harness itself writes. This is the one deliberate exception, and it is
 * user-initiated rather than automatic: purging a run is an explicit request to
 * stop counting a result, not a silent rewrite of history. Two guards keep it
 * from being a data-integrity hole:
 *
 *  - **in-flight runs are refused.** The runner holds the id in a module-level
 *    queue and would keep appending events to it, resurrecting rows seconds
 *    after they were deleted.
 *  - **shared tables are left alone.** pg_config_versions is keyed by
 *    fingerprint and pg_materials by file id; other runs point at the same
 *    rows, so deleting one run must not strip their config provenance.
 *
 * Everything else goes in one transaction — a run that survives without its
 * trajectory is exactly the "仅指标 · 无轨迹" state this codebase refuses to
 * fabricate, and a half-deleted run would fake it.
 */
export function deleteRun(runId: string): DeleteRunResult {
  const database = getDb()
  const base = { runId, events: 0, verdicts: 0, assertions: 0, killChain: 0, blastRadius: 0 }
  const row = database.prepare('SELECT status FROM pg_runs WHERE run_id = ?').get(runId) as { status: RunStatus } | undefined
  if (!row) return { ...base, deleted: false, reason: 'not-found' }
  if (row.status === 'queued' || row.status === 'running') return { ...base, deleted: false, reason: 'in-flight' }

  database.exec('BEGIN')
  try {
    const blast = database.prepare('DELETE FROM pg_blast_radius_observations WHERE run_id = ?').run(runId)
    const chain = database.prepare('DELETE FROM pg_killchain_observations WHERE run_id = ?').run(runId)
    const assertions = database.prepare('DELETE FROM pg_legal_assertions WHERE run_id = ?').run(runId)
    const verdicts = database.prepare('DELETE FROM pg_verdicts WHERE run_id = ?').run(runId)
    const events = database.prepare('DELETE FROM pg_events WHERE run_id = ?').run(runId)
    database.prepare('DELETE FROM pg_runs WHERE run_id = ?').run(runId)
    database.exec('COMMIT')
    return {
      runId,
      deleted: true,
      events: Number(events.changes),
      verdicts: Number(verdicts.changes),
      assertions: Number(assertions.changes),
      killChain: Number(chain.changes),
      blastRadius: Number(blast.changes),
    }
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

// ── config versions / materials ─────────────────────────────────────────────

export function upsertConfigVersion(input: {
  fingerprint: string
  config: HarnessConfig
  mounts: PgMounts
  controlsSnapshot: ControlsSnapshot
  mappingVersion: string
  ladderRung: LadderRung
  ladderVersion: string
}): void {
  getDb()
    .prepare(
      `INSERT INTO pg_config_versions (fingerprint, config_json, mounts_json, controls_json, mapping_version, ladder_rung, ladder_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO NOTHING`,
    )
    .run(
      input.fingerprint,
      JSON.stringify(input.config),
      JSON.stringify(input.mounts ?? {}),
      JSON.stringify(input.controlsSnapshot),
      input.mappingVersion,
      input.ladderRung,
      input.ladderVersion,
      new Date().toISOString(),
    )
}

export function upsertMaterial(input: { fileId: string; category: 'dossier' | 'legal-kb'; relPath: string; contentHash: string; chars: number }): void {
  getDb()
    .prepare(
      `INSERT INTO pg_materials (file_id, category, rel_path, content_hash, chars, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_id) DO NOTHING`,
    )
    .run(input.fileId, input.category, input.relPath, input.contentHash, input.chars, new Date().toISOString())
}

// ── reads ────────────────────────────────────────────────────────────────────

interface RawRunRow {
  run_id: string
  scenario_id: string
  task_id: string
  task_title: string
  domain: PgDomain
  split: PgSplit
  preset_id: PgPresetId | null
  fingerprint: string
  status: RunStatus
  source: RunSource
  config_json: string
  mounts_json: string
  provider_json: string | null
  temperature: number | null
  seed: number | null
  max_tokens: number | null
  answer: string | null
  tokens: number | null
  latency_ms: number | null
  error: string | null
  materials_json: string | null
  verdict_json: string | null
  jev_result_json: string | null
  failure_tags_json: string
  success: number | null
  score: number | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  event_count: number
}

const SELECT_COLUMNS = `
  r.run_id, r.scenario_id, r.task_id, r.task_title, r.domain, r.split, r.preset_id, r.fingerprint,
  r.status, r.source, r.config_json, r.mounts_json, r.provider_json, r.temperature, r.seed,
  r.max_tokens, r.answer, r.tokens, r.latency_ms, r.error, r.materials_json, r.verdict_json,
  r.jev_result_json,
  r.failure_tags_json, r.success, r.score, r.created_at, r.started_at, r.finished_at,
  (SELECT COUNT(*) FROM pg_events e WHERE e.run_id = r.run_id) AS event_count`

function hydrateSummary(row: RawRunRow): RunSummary {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    domain: row.domain,
    split: row.split,
    presetId: row.preset_id,
    fingerprint: row.fingerprint,
    status: row.status,
    source: row.source,
    success: row.success === null ? null : row.success === 1,
    score: row.score,
    tokens: row.tokens,
    latencyMs: row.latency_ms,
    failureTags: safeParse<MastTag[]>(row.failure_tags_json, []),
    model: safeParse<ProviderSnapshot | null>(row.provider_json, null)?.model ?? '—',
    temperature: row.temperature,
    seed: row.seed,
    eventCount: row.event_count,
    hasTrajectory: row.event_count > 0,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export interface RunFilter {
  taskId?: string
  domain?: PgDomain
  fingerprint?: string
  presetId?: PgPresetId
  model?: string
  tag?: string
  source?: RunSource
  status?: RunStatus
  from?: string
  to?: string
  limit?: number
}

export function listRuns(filter: RunFilter = {}): RunSummary[] {
  const where: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vals: any[] = []
  if (filter.taskId) { where.push('r.task_id = ?'); vals.push(filter.taskId) }
  if (filter.domain) { where.push('r.domain = ?'); vals.push(filter.domain) }
  if (filter.fingerprint) { where.push('r.fingerprint = ?'); vals.push(filter.fingerprint) }
  if (filter.presetId) { where.push('r.preset_id = ?'); vals.push(filter.presetId) }
  if (filter.model) { where.push("json_extract(r.provider_json, '$.model') = ?"); vals.push(filter.model) }
  if (filter.source) { where.push('r.source = ?'); vals.push(filter.source) }
  if (filter.status) { where.push('r.status = ?'); vals.push(filter.status) }
  if (filter.from) { where.push('r.created_at >= ?'); vals.push(filter.from) }
  if (filter.to) { where.push('r.created_at <= ?'); vals.push(filter.to) }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(500, filter.limit ?? 200))
  const rows = getDb()
    .prepare(`SELECT ${SELECT_COLUMNS} FROM pg_runs r ${clause} ORDER BY r.created_at DESC, r.run_id DESC LIMIT ${limit}`)
    .all(...vals) as unknown as RawRunRow[]
  const summaries = rows.map(hydrateSummary)
  if (filter.tag) return summaries.filter((s) => s.failureTags.includes(filter.tag as MastTag))
  return summaries
}

export function getRunDetail(runId: string) {
  const database = getDb()
  const row = database
    .prepare(`SELECT ${SELECT_COLUMNS} FROM pg_runs r WHERE r.run_id = ?`)
    .get(runId) as RawRunRow | undefined
  if (!row) return null
  const summary = hydrateSummary(row)
  const cvRow = database
    .prepare('SELECT controls_json, mapping_version, ladder_rung, ladder_version FROM pg_config_versions WHERE fingerprint = ?')
    .get(row.fingerprint) as { controls_json: string; mapping_version: string; ladder_rung: LadderRung; ladder_version: string } | undefined
  return {
    ...summary,
    scenarioId: row.scenario_id,
    config: safeParse<HarnessConfig>(row.config_json, {} as HarnessConfig),
    mounts: safeParse<PgMounts>(row.mounts_json, {}),
    provider: safeParse<ProviderSnapshot | null>(row.provider_json, null),
    maxTokens: row.max_tokens,
    answer: row.answer,
    verdict: safeParse<ScoreResult | null>(row.verdict_json, null),
    jevResult: safeParse<JevJudgeResult | null>(row.jev_result_json, null),
    events: getEvents(runId),
    materials: safeParse<MaterialsInfo | null>(row.materials_json, null),
    configVersion: cvRow
      ? {
          controlsSnapshot: safeParse<ControlsSnapshot>(cvRow.controls_json, emptyControlsSnapshot()),
          mappingVersion: cvRow.mapping_version,
          ladderRung: cvRow.ladder_rung,
          ladderVersion: cvRow.ladder_version,
        }
      : {
          controlsSnapshot: emptyControlsSnapshot(),
          mappingVersion: 'unknown',
          ladderRung: 'bare' as LadderRung,
          ladderVersion: 'unknown',
        },
    // Measured attack chain + blast radius. `designed` is read from the
    // fixture attack catalogue on demand; it is not stored on the run row so
    // the two states can never overwrite one another (§11.1#7).
    security: {
      designed: designedChain(taskAttackId(row.task_id)),
      observed: getKillChainObservation(runId),
      blastRadius: getBlastRadiusObservations(runId),
    },
  }
}

export interface ScoredRunRow {
  runId: string
  taskId: string
  domain: PgDomain
  presetId: PgPresetId | null
  fingerprint: string
  success: boolean
  tokens: number | null
  latencyMs: number | null
  tags: MastTag[]
  createdAt: string
}

// ── import (round-trip of the native export envelope) ───────────────────────

export interface ImportableRun {
  run: Omit<import('../../shared/playground').RunDetail, 'events'>
  events: HarnessEvent[]
}

/**
 * Import an exported run as provenance 'imported' (design §14.1): a fresh
 * runId, source='imported', every event re-stamped with author='imported' so
 * the UI can never render foreign trajectories as this harness's own
 * interventions. Returns the new runId.
 */
export function importRun(payload: ImportableRun): string {
  const database = getDb()
  const d = payload.run
  const newId = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  database
    .prepare(
      `INSERT INTO pg_runs (run_id, scenario_id, task_id, task_title, domain, split, preset_id, fingerprint,
        status, source, config_json, mounts_json, provider_json, temperature, seed, max_tokens,
        answer, tokens, latency_ms, error, materials_json, verdict_json, failure_tags_json,
        success, score, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId,
      d.scenarioId,
      d.taskId,
      d.taskTitle,
      d.domain,
      d.split,
      d.presetId,
      d.fingerprint,
      d.status === 'error' ? 'error' : 'scored',
      JSON.stringify(d.config),
      JSON.stringify(d.mounts ?? {}),
      d.provider ? JSON.stringify(d.provider) : null,
      d.temperature,
      d.seed,
      d.maxTokens ?? null,
      d.answer,
      d.tokens,
      d.latencyMs,
      d.error,
      d.materials ? JSON.stringify(d.materials) : null,
      d.verdict ? JSON.stringify(d.verdict) : null,
      JSON.stringify(d.failureTags ?? []),
      d.success === null ? null : d.success ? 1 : 0,
      d.score,
      d.createdAt,
      d.startedAt,
      d.finishedAt,
    )
  for (const [seq, ev] of payload.events.entries()) {
    const imported = { ...ev, id: `${newId}-evt-${seq + 1}`, runId: newId, scenarioId: d.scenarioId, author: 'imported' as const }
    database.prepare('INSERT INTO pg_events (run_id, seq, event_json) VALUES (?, ?, ?)').run(newId, seq + 1, JSON.stringify(imported))
  }
  if (d.verdict) insertVerdict(newId, d.verdict, 1)
  if (d.configVersion?.mappingVersion && d.configVersion.mappingVersion !== 'unknown') {
    upsertConfigVersion({
      fingerprint: d.fingerprint,
      config: d.config,
      mounts: d.mounts ?? {},
      controlsSnapshot: d.configVersion.controlsSnapshot,
      mappingVersion: d.configVersion.mappingVersion,
      ladderRung: d.configVersion.ladderRung,
      ladderVersion: d.configVersion.ladderVersion,
    })
  }
  return newId
}

/** L3 aggregation input: scored live runs only (imported excluded by default, design §11.1#4). */
export function listScoredLiveRuns(): ScoredRunRow[] {
  const rows = getDb()
    .prepare(
      `SELECT run_id, task_id, domain, preset_id, fingerprint, success, tokens, latency_ms,
              failure_tags_json, created_at
       FROM pg_runs
       WHERE status = 'scored' AND source = 'live' AND success IS NOT NULL
       ORDER BY created_at ASC`,
    )
    .all() as Array<{
    run_id: string
    task_id: string
    domain: PgDomain
    preset_id: PgPresetId | null
    fingerprint: string
    success: number
    tokens: number | null
    latency_ms: number | null
    failure_tags_json: string
    created_at: string
  }>
  return rows.map((r) => ({
    runId: r.run_id,
    taskId: r.task_id,
    domain: r.domain,
    presetId: r.preset_id,
    fingerprint: r.fingerprint,
    success: r.success === 1,
    tokens: r.tokens,
    latencyMs: r.latency_ms,
    tags: safeParse<MastTag[]>(r.failure_tags_json, []),
    createdAt: r.created_at,
  }))
}
