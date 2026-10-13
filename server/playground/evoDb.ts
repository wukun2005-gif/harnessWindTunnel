// M4 evolution persistence (design §7 / §14.3). Four tables, all isolated from
// fixture state:
//   pg_evo_clusters      — deterministic failure clusters
//   pg_evo_cards         — LLM change cards (with full proposal trace)
//   pg_evo_generations   — immutable config generations (version tree)
//   pg_evo_mutations     — applied cards + paired falsification
//
// Generations and mutations are append-only: rollback means pointing a new
// current generation at a parent, never editing a committed config.
import type { DatabaseSync } from 'node:sqlite'
import { getPlaygroundDb } from './liveDb'
import type {
  ChangeCard,
  EvoCluster,
  EvoGeneration,
  EvoMutation,
  FalsificationResult,
} from '../../shared/playground'

let ensured = false

function db(): DatabaseSync {
  const d = getPlaygroundDb()
  if (!ensured) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS pg_evo_clusters (
        cluster_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        tag TEXT NOT NULL,
        seam TEXT NOT NULL,
        key TEXT NOT NULL,
        count INTEGER NOT NULL,
        domain TEXT NOT NULL,
        critical_steps_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        run_ids_json TEXT NOT NULL,
        task_ids_json TEXT NOT NULL,
        route_history_json TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pg_evo_cards (
        card_id TEXT PRIMARY KEY,
        cluster_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        surface TEXT NOT NULL,
        seam TEXT NOT NULL,
        title TEXT NOT NULL,
        nl TEXT NOT NULL,
        prompt_diff_json TEXT,
        middleware_diff_json TEXT,
        mount_diff_json TEXT,
        surface_reason TEXT NOT NULL,
        in_table INTEGER NOT NULL,
        predicted_gain_pp REAL,
        hard_gate INTEGER NOT NULL,
        status TEXT NOT NULL,
        verdict TEXT NOT NULL,
        llm_prompt TEXT,
        llm_output TEXT,
        proposal_source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pg_evo_cards_cluster ON pg_evo_cards(cluster_id);

      CREATE TABLE IF NOT EXISTS pg_evo_generations (
        generation_id TEXT PRIMARY KEY,
        parent_id TEXT,
        label TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        config_json TEXT NOT NULL,
        mounts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL,
        card_id TEXT,
        is_current INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS pg_evo_mutations (
        commit_id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        cluster_id TEXT NOT NULL,
        parent_generation_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        config_diff_json TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        autonomy_level INTEGER NOT NULL,
        falsification_json TEXT NOT NULL,
        gate_json TEXT,
        gate_status TEXT NOT NULL DEFAULT 'idle'
      );
    `)
    // Migration for DBs created before gate verification existed.
    for (const stmt of [
      'ALTER TABLE pg_evo_mutations ADD COLUMN gate_json TEXT',
      "ALTER TABLE pg_evo_mutations ADD COLUMN gate_status TEXT NOT NULL DEFAULT 'idle'",
    ]) {
      try { d.exec(stmt) } catch { /* column already exists */ }
    }
    ensured = true
  }
  return d
}

// ── clusters ───────────────────────────────────────────────────────────────

export function insertCluster(c: EvoCluster): void {
  const d = db()
  d.prepare(
    `INSERT INTO pg_evo_clusters
       (cluster_id, created_at, tag, seam, key, count, domain, critical_steps_json,
        summary, run_ids_json, task_ids_json, route_history_json, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(cluster_id) DO UPDATE SET
       count=excluded.count, critical_steps_json=excluded.critical_steps_json,
       summary=excluded.summary, run_ids_json=excluded.run_ids_json,
       task_ids_json=excluded.task_ids_json, route_history_json=excluded.route_history_json,
       status=excluded.status`,
  ).run(
    c.clusterId, c.createdAt, c.tag, c.seam, c.key, c.count, c.domain,
    JSON.stringify(c.criticalSteps), c.summary, JSON.stringify(c.runIds),
    JSON.stringify(c.taskIds), JSON.stringify(c.routeHistory), c.status,
  )
}

function rowToCluster(row: Record<string, unknown>): EvoCluster {
  return {
    clusterId: row.cluster_id as string,
    createdAt: row.created_at as string,
    tag: row.tag as EvoCluster['tag'],
    seam: row.seam as string,
    key: row.key as string,
    count: row.count as number,
    domain: row.domain as EvoCluster['domain'],
    criticalSteps: JSON.parse(row.critical_steps_json as string) as number[],
    summary: row.summary as string,
    runIds: JSON.parse(row.run_ids_json as string) as string[],
    taskIds: JSON.parse(row.task_ids_json as string) as string[],
    routeHistory: JSON.parse(row.route_history_json as string) as EvoCluster['routeHistory'],
    status: row.status as EvoCluster['status'],
  }
}

export function listClusters(): EvoCluster[] {
  const rows = db().prepare('SELECT * FROM pg_evo_clusters ORDER BY created_at DESC').all() as Record<string, unknown>[]
  return rows.map(rowToCluster)
}

export function getCluster(id: string): EvoCluster | null {
  const row = db().prepare('SELECT * FROM pg_evo_clusters WHERE cluster_id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToCluster(row) : null
}

// ── cards ──────────────────────────────────────────────────────────────────

export function insertCard(card: ChangeCard): void {
  const d = db()
  d.prepare(
    `INSERT INTO pg_evo_cards
       (card_id, cluster_id, created_at, surface, seam, title, nl, prompt_diff_json,
        middleware_diff_json, mount_diff_json, surface_reason, in_table, predicted_gain_pp,
        hard_gate, status, verdict, llm_prompt, llm_output, proposal_source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(card_id) DO UPDATE SET
       status=excluded.status, verdict=excluded.verdict, predicted_gain_pp=excluded.predicted_gain_pp`,
  ).run(
    card.cardId, card.clusterId, card.createdAt, card.surface, card.seam, card.title, card.nl,
    card.promptDiff ? JSON.stringify(card.promptDiff) : null,
    card.middlewareDiff ? JSON.stringify(card.middlewareDiff) : null,
    card.mountDiff ? JSON.stringify(card.mountDiff) : null,
    card.surfaceReason, card.inTable ? 1 : 0, card.predictedGainPp, card.hardGate ? 1 : 0,
    card.status, card.verdict, card.llmPrompt, card.llmOutput, card.proposalSource,
  )
}

export function updateCardStatus(cardId: string, status: ChangeCard['status'], verdict: ChangeCard['verdict']): void {
  db().prepare('UPDATE pg_evo_cards SET status = ?, verdict = ? WHERE card_id = ?').run(status, verdict, cardId)
}

function rowToCard(row: Record<string, unknown>): ChangeCard {
  return {
    cardId: row.card_id as string,
    clusterId: row.cluster_id as string,
    createdAt: row.created_at as string,
    surface: row.surface as ChangeCard['surface'],
    seam: row.seam as string,
    title: row.title as string,
    nl: row.nl as string,
    promptDiff: row.prompt_diff_json ? (JSON.parse(row.prompt_diff_json as string) as ChangeCard['promptDiff']) : null,
    middlewareDiff: row.middleware_diff_json ? (JSON.parse(row.middleware_diff_json as string) as ChangeCard['middlewareDiff']) : null,
    mountDiff: row.mount_diff_json ? (JSON.parse(row.mount_diff_json as string) as ChangeCard['mountDiff']) : null,
    surfaceReason: row.surface_reason as string,
    inTable: (row.in_table as number) === 1,
    predictedGainPp: row.predicted_gain_pp as number | null,
    hardGate: (row.hard_gate as number) === 1,
    status: row.status as ChangeCard['status'],
    verdict: row.verdict as ChangeCard['verdict'],
    llmPrompt: row.llm_prompt as string | null,
    llmOutput: row.llm_output as string | null,
    proposalSource: row.proposal_source as ChangeCard['proposalSource'],
  }
}

export function listCards(clusterId?: string): ChangeCard[] {
  const d = db()
  const rows = clusterId
    ? (d.prepare('SELECT * FROM pg_evo_cards WHERE cluster_id = ? ORDER BY created_at DESC').all(clusterId) as Record<string, unknown>[])
    : (d.prepare('SELECT * FROM pg_evo_cards ORDER BY created_at DESC').all() as Record<string, unknown>[])
  return rows.map(rowToCard)
}

export function getCard(id: string): ChangeCard | null {
  const row = db().prepare('SELECT * FROM pg_evo_cards WHERE card_id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToCard(row) : null
}

// ── generations ────────────────────────────────────────────────────────────

export function insertGeneration(g: EvoGeneration): void {
  const d = db()
  d.prepare(
    `INSERT INTO pg_evo_generations
       (generation_id, parent_id, label, fingerprint, config_json, mounts_json,
        created_at, source, card_id, is_current)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(generation_id) DO NOTHING`,
  ).run(
    g.generationId, g.parentId, g.label, g.fingerprint,
    JSON.stringify(g.config), JSON.stringify(g.mounts), g.createdAt, g.source,
    g.cardId, g.generationId === currentGenerationId() ? 1 : 0,
  )
}

function rowToGeneration(row: Record<string, unknown>): EvoGeneration {
  return {
    generationId: row.generation_id as string,
    parentId: row.parent_id as string | null,
    label: row.label as string,
    fingerprint: row.fingerprint as string,
    config: JSON.parse(row.config_json as string) as EvoGeneration['config'],
    mounts: JSON.parse(row.mounts_json as string) as EvoGeneration['mounts'],
    createdAt: row.created_at as string,
    source: row.source as EvoGeneration['source'],
    cardId: row.card_id as string | null,
  }
}

export function listGenerations(): EvoGeneration[] {
  const rows = db().prepare('SELECT * FROM pg_evo_generations ORDER BY created_at ASC').all() as Record<string, unknown>[]
  return rows.map(rowToGeneration)
}

export function getGeneration(id: string): EvoGeneration | null {
  const row = db().prepare('SELECT * FROM pg_evo_generations WHERE generation_id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToGeneration(row) : null
}

const CURRENT_KEY = 'current'

/** The current pointer is a single-row table kept in a tiny kv store. */
function ensureKv(): void {
  db().exec('CREATE TABLE IF NOT EXISTS pg_evo_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
}

export function setCurrentGeneration(id: string): void {
  const d = db()
  ensureKv()
  d.prepare('INSERT INTO pg_evo_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(CURRENT_KEY, id)
  d.exec('UPDATE pg_evo_generations SET is_current = 0')
  d.prepare('UPDATE pg_evo_generations SET is_current = 1 WHERE generation_id = ?').run(id)
}

export function currentGenerationId(): string | null {
  const d = db()
  ensureKv()
  const row = d.prepare('SELECT v FROM pg_evo_kv WHERE k = ?').get(CURRENT_KEY) as { v: string } | undefined
  return row?.v ?? null
}

/** Generic JSON kv (used for the transient auto-evolution job status). */
export function kvGetJson<T>(key: string): T | null {
  const d = db()
  ensureKv()
  const row = d.prepare('SELECT v FROM pg_evo_kv WHERE k = ?').get(key) as { v: string } | undefined
  return row ? (JSON.parse(row.v) as T) : null
}

export function kvSetJson(key: string, value: unknown): void {
  const d = db()
  ensureKv()
  d.prepare('INSERT INTO pg_evo_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
    .run(key, JSON.stringify(value))
}

export function currentGeneration(): EvoGeneration | null {
  const id = currentGenerationId()
  return id ? getGeneration(id) : null
}

// ── mutations ──────────────────────────────────────────────────────────────

export function insertMutation(m: EvoMutation): void {
  db().prepare(
    `INSERT INTO pg_evo_mutations
       (commit_id, card_id, cluster_id, parent_generation_id, generation_id,
        created_at, config_diff_json, approved_by, autonomy_level, falsification_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(commit_id) DO NOTHING`,
  ).run(
    m.commitId, m.cardId, m.clusterId, m.parentGenerationId, m.generationId,
    m.createdAt, JSON.stringify(m.configDiff), m.approvedBy, m.autonomyLevel,
    JSON.stringify(m.falsification),
  )
}

export function listMutations(): EvoMutation[] {
  const rows = db().prepare('SELECT * FROM pg_evo_mutations ORDER BY created_at ASC').all() as Record<string, unknown>[]
  return rows.map((row) => ({
    commitId: row.commit_id as string,
    cardId: row.card_id as string,
    clusterId: row.cluster_id as string,
    parentGenerationId: row.parent_generation_id as string,
    generationId: row.generation_id as string,
    createdAt: row.created_at as string,
    configDiff: JSON.parse(row.config_diff_json as string) as Partial<EvoMutation['configDiff']>,
    approvedBy: row.approved_by as EvoMutation['approvedBy'],
    autonomyLevel: row.autonomy_level as number,
    falsification: JSON.parse(row.falsification_json as string) as FalsificationResult,
    gate: row.gate_json ? (JSON.parse(row.gate_json as string) as EvoMutation['gate']) : null,
    gateStatus: (row.gate_status as EvoMutation['gateStatus']) ?? 'idle',
  }))
}

/** Persist the §7.2④ held-out gate result on a committed mutation. */
export function updateMutationGate(
  commitId: string,
  gate: NonNullable<EvoMutation['gate']> | null,
  status: NonNullable<EvoMutation['gateStatus']>,
): void {
  db()
    .prepare('UPDATE pg_evo_mutations SET gate_json = ?, gate_status = ? WHERE commit_id = ?')
    .run(gate ? JSON.stringify(gate) : null, status, commitId)
}

/** Get a single mutation by its commit id (used by the gate worker). */
export function getMutation(commitId: string): EvoMutation | null {
  return listMutations().find((m) => m.commitId === commitId) ?? null
}

/**
 * Has a card from this cluster routed to this surface already been applied?
 * Used by the dynamic upgrade rule (prompt → joint → middleware).
 */
export function appliedSurfacesForCluster(clusterId: string): Array<{ surface: string; cardId: string }> {
  const rows = db()
    .prepare(
      `SELECT c.surface AS surface, c.card_id AS cardId
         FROM pg_evo_mutations m JOIN pg_evo_cards c ON c.card_id = m.card_id
         WHERE m.cluster_id = ?`,
    )
    .all(clusterId) as Array<{ surface: string; cardId: string }>
  return rows.map((r) => ({ surface: r.surface, cardId: r.cardId }))
}
