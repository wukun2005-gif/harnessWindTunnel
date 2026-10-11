// M2 playground harness presets + deterministic control/rung mappings.
// 设计 §13：playground 配置必须与 fixture 三域控件一一对应；
// §15.4 P1#7/#8：7 控件↔20 字段 DSL 映射与审计阶梯档必须是带版本号的
// 确定性函数（不能只活在设计文档表格里），各档 rates 由 run 汇总现算。
import { BASE_CONFIG, cfg, fingerprint, type HarnessConfig } from '../../shared/config'
import { LEGAL_CONTROLS, type LegalControl } from '../../shared/legal'
import { SECURITY_CONTROLS, type SecurityControl } from '../../shared/redteam'
import type {
  ControlsSnapshot,
  LadderRung,
  PgMounts,
  PgPreset,
  PgPresetId,
} from '../../shared/playground'

/** Bumped whenever the 7-control ↔ 20-field mapping rules change. */
export const MAPPING_VERSION = 'm2-v1'
/** Bumped whenever the audit-ladder rung rules change. */
export const LADDER_VERSION = 'm2-v1'
/** Permission-router rule set version carried by router.decision events. */
export const POLICY_VERSION = 'm2-v1'

export const PG_PRESETS: PgPreset[] = [
  {
    id: 'C0',
    name: 'C0 基线',
    domainFocus: '—',
    summary: '全部控件关闭：basic loop、无文件态、无传感器、open 权限、不挂 MCP',
    config: cfg(),
    mounts: {},
  },
  {
    id: 'C1',
    name: 'C0 + File-backed',
    domainFocus: 'general',
    summary: '通用域：filesystem=file-backed-state，长卷宗带文件态',
    config: cfg({ filesystem: 'file-backed-state' }),
    mounts: {},
  },
  {
    id: 'C2',
    name: 'C2 法律组',
    domainFocus: 'legal',
    summary: '挂载本地 patent-law-mcp（先检索后生成）＋sensors=verifier 引用核验＋guides=domain-checklist＋observability=trace+mast 全程留痕',
    config: cfg({
      guides: 'domain-checklist',
      sensors: 'verifier',
      // §13 maps the legal hash-audit-chain control to `trace+mast`; plain
      // `trace` lit nothing, so the preset claimed a control it did not have.
      observability: 'trace+mast',
    }),
    mounts: { patentLawMcp: true },
  },
  {
    id: 'C3',
    name: 'C3 安全组',
    domainFocus: 'security',
    summary: 'permissions=deny-first＋globalPolicy=policy-enforced（外发 DLP）＋sandbox=write-barrier＋lifecycle hooks（输入隔离）',
    config: cfg({
      permissions: 'deny-first',
      globalPolicy: 'policy-enforced',
      sandbox: 'write-barrier',
      hooks: 'lifecycle',
    }),
    mounts: {},
  },
]

export function getPreset(id: string): PgPreset | undefined {
  return PG_PRESETS.find((p) => p.id === id)
}

export function resolveConfig(presetId: PgPresetId | undefined, raw: HarnessConfig | undefined): { config: HarnessConfig; mounts: PgMounts; presetId: PgPresetId | null } {
  if (raw) return { config: { ...BASE_CONFIG, ...raw }, mounts: {}, presetId: null }
  const preset = getPreset(presetId ?? 'C0') ?? PG_PRESETS[0]!
  return { config: { ...preset.config }, mounts: { ...preset.mounts }, presetId: preset.id }
}

// ── 7 控件 ↔ 20 字段 DSL 确定性映射（设计 §13 表格的代码化） ──────────────

/**
 * 安全 7 控件（#/security SECURITY_CONTROLS）：
 * - input-isolation          ← hooks=lifecycle（卷宗输入包裹/扫描）∨ file-backed 隔离
 * - tool-boundary-gateway    ← permissions≠open（工具面收敛＋边界）
 * - least-privilege-creds    ← sandbox≠off
 * - exec-sandbox             ← sandbox=write-barrier
 * - human-approval-gate      ← humanInLoop=approval-gates
 * - egress-dlp               ← globalPolicy=policy-enforced
 * - outofband-killswitch     ← hooks=lifecycle ∧ globalPolicy=policy-enforced
 *
 * 法律 7 控件（#/legal LEGAL_CONTROLS）：
 * - authority-mcp            ← playground mount 开关（20 字段 DSL 无此槽位）
 * - citation-audit           ← sensors=verifier / verifier+critic
 * - deadline-ledger          ← planner≠off ∧ memory≠none
 * - jurisdiction-filter      ← guides=domain-checklist
 * - issue-close-gate         ← selfVerify=premature-victory-check
 * - risk-escalation-gate     ← humanInLoop≠none
 * - hash-audit-chain         ← observability=trace+mast
 */
export function controlsSnapshot(config: HarnessConfig, mounts: PgMounts = {}): ControlsSnapshot {
  const security = {
    'input-isolation': config.hooks === 'lifecycle' || config.filesystem === 'file-backed-state',
    'tool-boundary-gateway': config.permissions !== 'open',
    'least-privilege-creds': config.sandbox !== 'off',
    'exec-sandbox': config.sandbox === 'write-barrier',
    'human-approval-gate': config.humanInLoop === 'approval-gates',
    'egress-dlp': config.globalPolicy === 'policy-enforced',
    'outofband-killswitch': config.hooks === 'lifecycle' && config.globalPolicy === 'policy-enforced',
  } as Record<SecurityControl, boolean>

  const legal = {
    'authority-mcp': mounts.patentLawMcp === true,
    'citation-audit': config.sensors === 'verifier' || config.sensors === 'verifier+critic',
    'deadline-ledger': config.planner !== 'off' && config.memory !== 'none',
    'jurisdiction-filter': config.guides === 'domain-checklist',
    'issue-close-gate': config.selfVerify === 'premature-victory-check',
    'risk-escalation-gate': config.humanInLoop !== 'none',
    'hash-audit-chain': config.observability === 'trace+mast',
  } as Record<LegalControl, boolean>

  return { security, legal }
}

export function snapshotFingerprint(config: HarnessConfig, mounts: PgMounts = {}): string {
  return fingerprint(config)
}

// ── 审计阶梯档（设计 §11.2：最小可辩护确定性映射；rates 不落库、现算） ──────
//
// 口径（m2-v1，单测锁定；任何调整 bump LADDER_VERSION）：
// - hard    ：sensors 为 verifier(+critic)，且 permissions=deny-first
//             或 globalPolicy=policy-enforced（硬性确定性门禁在位）
// - soft-cn ：法律域软控件在位 —— authority-mcp 挂载或 guides=domain-checklist
// - soft-us ：程序性软控件在位 —— humanInLoop≠none 或 permissions=ask-write
// - bare    ：以上皆无
// 优先级 hard > soft-cn > soft-us > bare。本屏场景管辖路线固定为中国法院，
// jurisdictionRoute 参数预留给未来美法域场景，当前不改变结果。
export function ladderRung(
  config: HarnessConfig,
  mounts: PgMounts = {},
  _jurisdictionRoute: 'cn' | 'us' = 'cn',
): LadderRung {
  const verifierOn = config.sensors === 'verifier' || config.sensors === 'verifier+critic'
  const hardGateOn = config.permissions === 'deny-first' || config.globalPolicy === 'policy-enforced'
  if (verifierOn && hardGateOn) return 'hard'
  if (mounts.patentLawMcp === true || config.guides === 'domain-checklist') return 'soft-cn'
  if (config.humanInLoop !== 'none' || config.permissions === 'ask-write') return 'soft-us'
  return 'bare'
}

export function configVersionInfo(config: HarnessConfig, mounts: PgMounts = {}) {
  return {
    controlsSnapshot: controlsSnapshot(config, mounts),
    mappingVersion: MAPPING_VERSION,
    ladderRung: ladderRung(config, mounts),
    ladderVersion: LADDER_VERSION,
  }
}

export const ALL_SECURITY_CONTROLS = SECURITY_CONTROLS
export const ALL_LEGAL_CONTROLS = LEGAL_CONTROLS
