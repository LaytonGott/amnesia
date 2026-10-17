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

## Known limits of this bench

- Short sessions maximize summary retention; long-session behavior is
  extrapolated, not measured, in v1.
- Headless (`-p`) sessions use the same engine, hooks, and compaction path as
  interactive ones, but the TUI is not covered.
- 12 items × 3 runs is a signal check, not a paper. Scale runs before making
  strong numeric claims.
