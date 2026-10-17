# Efficacy bench

Measures one claim: **do agents retain seeded instructions better across a
compaction when amnesia is active?**

- `scenario.json` — 12 seeded items (rules, exact details, conventions) and 12
  probes with deterministic scorers.
- `run-bench.mjs` — runs the full protocol per (arm, run) using headless
  Claude Code: seed → filler → `/compact` → 12 probes, all with
  `--output-format json` for cost capture.
- `results/` — per-run records + `summary.md` (gitignored).

## Arms

- **arm a** — baseline. No hooks.
- **arm b** — amnesia installed for the session via `--settings` (your real
  settings are never touched; artifacts go to a scratch `AMNESIA_HOME`).

## Run

```
node bench/run-bench.mjs                     # full matrix: 2 arms x 3 runs
node bench/run-bench.mjs --runs 5
node bench/run-bench.mjs --arms b --runs 1 --smoke   # 3 probes, plumbing check
node bench/run-bench.mjs --model sonnet      # pin model to cut variance/cost
```

Each run makes ~15 headless model calls. The smoke run costs roughly $1; a
full matrix is roughly $10-15 at default settings. Use `--model` to control
this.

## Validity checks (per run, in summary.md)

- `boundaries` — compaction actually happened (> 0 required)
- `injections` — `[amnesia]` appears in the transcript (arm b must be > 0)
- `snapshots` — PreCompact archive written under the scratch store (arm b > 0)

A run with `boundaries=0` or an arm-b run with `injections=0` is **invalid
data** — the bench itself caught a real bug (hooks silently not firing under
PowerShell) this way before any results were trusted.

## Scoring

Deterministic regex checks (`all` / `any` / `ban` per probe), reported per
probe per arm. Fuzzy behavioral probes are also candidates for a blind judge:
export answers without arm labels and have an independent agent score them
against the rubric in `scenario.json`.
