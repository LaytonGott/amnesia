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

## Known limits of this bench

- Short sessions maximize summary retention; long-session behavior is
  extrapolated, not measured, in v1.
- Headless (`-p`) sessions use the same engine, hooks, and compaction path as
  interactive ones, but the TUI is not covered.
- 12 items × 3 runs is a signal check, not a paper. Scale runs before making
  strong numeric claims.
