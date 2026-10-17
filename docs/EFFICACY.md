# Efficacy: does amnesia actually help?

amnesia's mechanism is verified. Its *outcome* — that agents lose seeded
instructions across a compaction, and that amnesia measurably reduces that
loss — is what the bench exists to measure. This is the protocol.

## Question

After a forced compaction, how many of 12 seeded project instructions can the
agent still answer or comply with:

- **arm A (baseline):** plain Claude Code, no hooks.
- **arm B (treatment):** amnesia installed for the session.

## Design

1. Fresh headless session per run (`--session-id`), scratch project dir,
   scratch `AMNESIA_HOME`.
2. Seed one message with 12 items: 4 hard rules, 4 exact details, 2 more
   rules phrased without keywords, 1 behavioral convention, 1 secret-style
   token. Then one filler turn so compaction has material.
3. Force `/compact` (verified: a real `compact_boundary` lands in the
   transcript; Pre/PostCompact hooks fire in headless mode).
4. Ask 12 probes — factual ("what version is pinned?"), constraint
   ("can you edit src/legacy/..."), and behavioral ("write the commit
   message"). Deterministic scorers per probe; a blind independent agent can
   re-score the fuzzy ones from exported answers.
5. Repeat 3× per arm to smooth single-run variance.

## Control and validity

- Same model, same scenario, same prompts in both arms; model recorded.
- Arm B isolation: hooks injected via `--settings`, artifacts in a scratch
  store — the machine's real configuration is untouched.
- Per-run validity gates: compaction happened, and in arm B the injection
  actually fired (`snapshots > 0`, `injections > 0`). Invalid runs are
  marked, not scored.

## Interpreting results

- **Sizable arm B delta, mostly on exact details and behavioral probes:**
  the self-healing claim holds — that's the headline.
- **Small or zero delta:** summaries retain most rules in short sessions, and
  amnesia's value then concentrates in longer sessions, exact details, and
  tool-output recovery. That would redirect the pitch honestly.
- Public artifacts for any write-up: scenario, scorer, raw per-run JSON,
  summary table. Publish the protocol, not just the win.

## Real-data audit (measured on 190 real sessions, $0)

No model calls: for every real compaction boundary, take the exact dropped
prompt set (the agent-verified reconstruction) and measure what of it appears
in the `isCompactSummary` text that replaced it. Run with
`node bench/audit-real.mjs`.

Results — 81 boundaries, 28 sessions, 3,020 dropped prompts, 4.8 MB of prompt
text:

| class | examined | survived in summary | rate |
|---|---|---|---|
| exact technical strings (paths, IDs, versions, dotted names) | 40,124 | 11,694 | **29.1%** |
| explicit constraints (>=50% of content words present) | 8,257 | 6,845 | **82.9%** |

What this says:

- The summarizer preserves instructions well at this scale — "it forgets your
  rules" is mostly wrong as the headline. Short-session benchmarks agree.
- Exact specifics die: ~71% of unparaphrasable tokens (paths, field names,
  versions, IDs) never reach the summary. Worst real boundaries retained
  1.6–5.5%. Example lost strings from one session: `dataset-identity`,
  `arm.config`, `config.temperature`, `runtime/config`,
  `provider/model/toolsets`.
- ~1,412 constraints across the history were materially absent — even rules
  erode at extreme compression ratios (998k -> 31k).

Interpretation limits: string absence is a floor (summaries can paraphrase
prose but not paths); presence is not proof of fidelity; this measures text
survival, not behavior.

## Raising rule retention toward 100%

The 82.9% is the summarizer's baseline, with no amnesia involved. The layers
stack on top:

- **Per-compaction injection** restores the most recent dropped prompts
  verbatim on the next message — the rules stop depending on the summary at
  all. Budget: ~1.5k tokens of the most recent lost messages.
- **`protect --write`** pins chosen rules into CLAUDE.md, which the platform
  re-injects at full fidelity every session — 100% durable, entirely outside
  the compaction system, for anything pinned.
- **The PreCompact snapshot** is the durable source of everything beyond the
  injection budget.

Honest gap: a rule dropped and injected in one round can fall off in later
rounds — each injection covers its own round. Invariants you cannot afford to
lose belong in CLAUDE.md (protect), which compaction cannot touch.

## Plugin A/B: exact-detail recall after compaction (2026-10-17)

`node bench/run-ab.mjs --facts 100 --reps 3` (Claude Code 2.1.302,
`--model sonnet`). One session is seeded over 10 turns. It holds 80 stated
facts across 35 services and 20 facts the agent looks up in ten ~70 KB
files, about 190k tokens of context. The seeded session is forked per arm and
rep, given a plain `/compact`, then probed once with **tools disabled** (100
exact-value questions, "unknown" allowed).

Controls:
- auto-memory off
- user settings, plugins and MCP servers not loaded
- nothing installed
- arm C differs only by `--plugin-dir plugin`

| scenario | arm | runs | correct | in summary | correct but not in summary |
|---|---|---|---|---|---|
| 20 salient facts | A baseline | 1 | 20/20 | 20/20 | 0 |
| 20 salient facts | C plugin | 1 | 20/20 | 20/20 | 0 |
| 100 facts | A baseline | 3 | 100.0 | 100.0 | 0 |
| 100 facts | C plugin | 3 | 96.0 | 94.3 | 2.0 |

What it says:

- **At this scale the summarizer barely loses anything.** It compressed
  191k tokens to about 5k, yet kept all 100 facts in 5 of 6 runs. The
  20-fact smoke run kept everything too. In this regime the plugin has
  almost nothing to add, and the arm means mostly measure which run drew a
  lossy summary.
- **Arm C's lower mean is summary variance, not harm.** The plugin never
  changes the summary. One C run (C3) drew a summary that dropped 17 facts,
  all of them file lookups.
- **When the summary did drop facts, the block worked as designed.** It
  carried 6 of the 17. The agent answered 5 of those 6 correctly, and 1 of
  the 11 the block lacked. It answered "unknown" to the rest rather than
  guessing.
- **The extractor, not the mechanism, capped the gain.** C3's block spent
  its budget on absolute file paths and `/opt/ledger/bin/*` paths from a
  cron file. The missing values were never candidates: bare numbers next to
  keys (`7350`), uppercase codes (`E-LEDGER-4471`, `OPS-77412`) and
  colon-hex serials (`6A:3F:91:0C:5D`). The agent's own replies had stated
  every one of them, for example "`settlement_retry_timeout_ms` is 7350".
- **Extractor v7 closes that gap offline.** `bench/replay-ab.mts` replays
  C3's real compaction with the current extractor. It reproduces v3's 6 of
  17 exactly, and v7 carries **17 of 17**. The fixes came from this run, so
  this is not independent evidence; docs/DESIGN-compact-hook.md has the
  real-data audit that checks v7 for overfitting.
  - It has not been re-run live. Whether the agent then recalls the other 11
    is the next live check. The one live data point is 5 recalled of 6
    carried.

Not measured here: the 1M-token regime where the real-data audit sees 80%
of prompt strings lost. A session of that size costs far more to seed. The
audit's numbers, not this A/B, are the evidence for loss at that scale.

Spend: about $5.30 in total. `total_cost_usd` is cumulative across resumes
and forks, so the runner logs per-call deltas.

## Known limits of this bench

- Short sessions maximize summary retention; long-session behavior is
  extrapolated, not measured, in v1.
- Headless (`-p`) sessions use the same engine, hooks, and compaction path as
  interactive ones, but the TUI is not covered.
- 12 items × 3 runs is a signal check, not a paper. Scale runs before making
  strong numeric claims.
