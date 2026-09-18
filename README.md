# HarnessWindTunnel

Wind-tunnel testing for AI agent harnesses: fix the model and the task, then experiment on everything around the model.

**Agent = Model + Harness.** Frontier models have converged; whether a task gets done reliably now depends on the execution scaffold around the model — loop, tools, memory, context compression, verifiers, permission gates. Existing tools either replay a single trace (LangSmith-style) or evolve harnesses as black-box research code. Nothing gives developers a **wind tunnel**: controlled experiments that show what each harness module contributes, plus human-approved, rollback-safe evolution.

## The 2-minute story

Same model, same task, two harnesses: **34% vs 77%**. The gap is not the model. Take the 12-step guided demo tour (`▶ 一键演示` / `#/demo`) and watch a failure become a verified, human-approved config change.

Three screens, one loop:

1. **Run Insight** (`#/insight`) — see what the model saw at each step: layered context stack, five-stage compression pipeline firing cheap-to-expensive, verifier verdicts, failure tags.
2. **Wind Tunnel** (`#/tunnel`) — flip any of 20 harness modules, compare configs side by side (success rate, Δ vs baseline, tokens, latency, failure-mode transfer), and diff two trajectories step by step to the first divergence.
3. **Evolution Forge** (`#/forge`) — cluster failures, propose a change card with a predicted interval, falsify it in the wind tunnel, require human approval, commit to a version tree with instant rollback.

Core finding the demo is built around: **more parts ≠ better performance.** Adding a verifier drops a cross-app workflow by 8.4pp; writing scope to a file first gains 5.5pp. You can only see that with controlled ablation, never from a single trace.

## Quickstart

```bash
npm install
npm run dev        # fixture server :4000 + web :5173
```

Open http://localhost:5173/#/demo for the guided tour. No keys, no network needed — the default offline track replays deterministic fixtures.

| Script | What it does |
|---|---|
| `npm run dev` | server + web together |
| `npm run build` / `typecheck` | production build / `tsc --noEmit` |
| `npm test` | i18n + fixture-content tests |
| `npm run check:paper` | asserts preset readings match cited paper deltas (26 checks) |
| `npm run gen:fixtures` | regenerates `data/` from `scripts/gen-fixture.ts` (hand-editing JSONL is forbidden) |

## Honest data labeling

Every number, trajectory, and metric carries a source badge, and the UI never mixes them:

- `fixture` — illustrative scripted data for a stable demo
- `paper-reproduction` — direction and deltas cite the paper below; baselines are illustrative
- `live` — runs against a user-configured model provider

One-click paper presets (wind-tunnel empty state): **NLAH** controlled ablation (arXiv:2603.25723), **AHE** ten-generation climb 69.7% → 77.0% (arXiv:2604.25850), **Harness-R1** counter-example 41.6% → 35.4% (arXiv:2608.02276).

## Failure taxonomy

12 first-class failure tags + `other`, aligned to MAST (arXiv:2503.13657, 14 modes FM-1.1–FM-3.3) where applicable and extended from task-family analysis where not. Six close over the designed scenario traps; six close the paper-review gaps (step repetition, reasoning-action mismatch, unaware-of-stopping, task derailment, fail-to-clarify, context loss). `other` holds the four remaining multi-agent-only modes. Mapping table and per-mode prevalence review: PRD §2.5.

## Layout

```
shared/        # 20-field harness config DSL, events schema, failure taxonomy, paper presets
src/screens/   # Demo tour, Run Insight, Wind Tunnel, Evolution Forge
src/stores/    # zustand stores (run replay, tunnel variants, forge generations)
server/        # fixture server (:4000) — replay + metrics APIs
scripts/       # fixture generator, paper-number checks, i18n tests
data/          # generated fixtures (scenarios × branches + forge curve) — do not hand-edit
HarnessWindTunnel-PRD-v1.1.html   # product requirements (Chinese)
harness-research-v0.5.html        # research report behind the PRD (Chinese)
```

## References

- MAST: Why Do Multi-Agent LLM Systems Fail? (arXiv:2503.13657) — failure taxonomy, κ=0.88
- NLAH: Natural-Language Agent Harnesses (arXiv:2603.25723) — per-module ablation
- AHE: Agentic Harness Engineering (arXiv:2604.25850) — 10-generation evolution
- Harness-R1 (arXiv:2608.02276) — naive self-modification regresses; wind-tunnel falsification + human gates
- AutoHarness (arXiv:2603.03329), Airbnb PRISM (arXiv:2609.05736), L-MARS (arXiv:2509.00761)

## Status & values

Offline-first demo MVP. Non-negotiables: wind-tunnel falsification before any claim, human approval before any commit, instant rollback always. No real side effects in the offline track — sends, writes, and payments are simulated.

## License

MIT — see [LICENSE](LICENSE).
