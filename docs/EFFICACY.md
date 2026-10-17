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

### Live re-run with extractor v7 (6 reps per arm)

`node bench/run-ab.mjs --facts 100 --reps 6 --out bench/results/ab-100
--tag v7 --max-spend 7.5`. Same seeded session, plugin at b338cdc, 12/12
valid runs, $3.11.

| arm | correct (mean of 100) | lossy runs | facts the summary dropped | carried by block | recalled of carried | recalled of not carried |
|---|---|---|---|---|---|---|
| A baseline | 97.0 | 1/6 | 17 | — | — | 0/17 |
| C plugin | 97.3 | 1/6 | 63 | 54 | **47/54** | 0/9 |

- **The block is the difference on dropped facts.** Pooling every lossy
  run so far (v3 C3 plus this batch): the agent recalled **52 of 60**
  dropped facts the block carried (87%). It recalled **1 of 37** dropped
  facts the block did not carry. It never guessed; misses were "unknown".
- **C1 shows what a bad summary costs.** Its summary kept only 37 of 100
  facts, and the block brought the run to 84 correct.
- **A4 shows the cost without the plugin.** It dropped every file lookup and
  scored 0 of 17 on them. v7 replays that kind of loss at 17 of 17 offline
  (see above).
- **The arm means are nearly equal** (97.0 vs 97.3) because lossy summaries
  are rare at this scale (2 of 12) and land on either arm at random. The
  per-fact comparison above is the measure of the plugin. The mean mostly
  measures summary luck.
- **The 7 carried-but-missed facts are a context-window problem.** All were
  versions or ports stated as "For brisk-payouts, the pinned SDK version is
  5.13.1". The 60-char snippet, centered on the value, cut the service name
  ("…payouts, the pinned SDK version is 5.13.1"). For ports, the item was the
  service name and the number sat only in the snippet. The agent couldn't
  bind the value to its owner and answered "unknown".
- **Next fix:** bias the snippet left (subject before value), or capture
  "the X is <value>" prose as a setting. This needs a live re-check, since
  the offline audit cannot see binding.

### Extractor v8 (values bound to owners), live under a forced-lossy summary

**Offline first** (`bench/replay-ab.mts`, no model calls). The three lossy
live runs so far dropped 97 facts in total.
- **v7** carried 88 of them, but only 61 sat on a block line together with
  their owner (service or key).
- **v8** carries all 97, every one bound.
- **On real data**, v8 nudged every audit measure up (see
  docs/DESIGN-compact-hook.md).

**Live stress batch.** Lossy summaries are rare in natural runs (3 of 24 so
far), so this batch gives `/compact` brevity instructions in **both** arms:
"Keep this summary to five sentences. Do not list identifiers, values,
versions, ports, hashes, names or file contents." That is a stress
condition, not natural behavior: it shows what the block does when the
summary keeps almost nothing.

Run: `--tag v8stress`, 4 reps per arm, plugin c0a1576, 8/8 valid, $3.41.

| arm | correct (mean of 100) | in summary | carried by block | recalled of carried | recalled of not carried |
|---|---|---|---|---|---|
| A baseline | **2.0** | 0.5 | — | — | 8/398 |
| C plugin | **85.0** | 0.0 | 84 per run | 332/336 | 8/64 |

- **Without the plugin the agent keeps 2 facts of 100.** Those are the two
  cron schedules, held by the message the compaction preserved verbatim.
- **With it, 85.** That's identical in all 4 reps, because the block is
  deterministic once the summary is.
- **Binding works.** The agent recalled 332 of the 336 carried facts. The 4
  misses are all F91, whose answer is `41`. The "carried" check matches any
  "41" in the block, so it was probably never actually carried, and the
  true rate is 332 of about 332.
- **The 16 facts per run not carried are a capacity and pattern gap, not a
  binding gap:**
  - **Budget:** the block was full at 84 items. The earliest file lookups
    (F11–F15, F92–F95) lose on recency.
  - **Patterns:** stated forms the patterns don't catch yet. "Our deploy
    region is …" and "On-call owner is …" (no "the"), "listens on port
    18443", and `@handles`.

What this establishes:
- When a summary loses details, the block is the agent's only source for
  them, and it binds them well enough to be recalled.
- How often that happens naturally (3 of 24 runs at ~190k tokens; far more
  at ~1M tokens per the real-data audit) decides how much it matters in
  practice.

Spend across all A/B runs: about $11.80 (smoke $1.75, first 100-fact batch
$3.54, v7 batch $3.11, v8 stress batch $3.41).

### The recall tool (plugin 0.8.0), live

What the tool does:
- It archives every tool output as it happens, and every message a
  compaction replaces, with secrets redacted.
- It registers `mcp__amnesia__recall` so the agent can search that archive,
  verbatim.
- The block stops being the only way back, and the 6,000-char budget stops
  being the ceiling.

`node bench/run-recall.mjs` runs one session per arm. Each is forked from
the seeded 100-fact session and compacted with the brevity instruction
above, so the summary kept 0 of the 20 probed facts. The block budget is cut
to 1,000 chars, and recall is the agent's only tool.

| arm | recall | correct (of 20) | recall calls |
|---|---|---|---|
| B | off | **0** | — |
| R | on | **20** | one per question |

Notes:
- **One configuration pitfall, now fixed in the script.** `--tools ""`
  removes plugin tools too: the first arm-R probe ran without the tool and
  scored 2 of 20.
- **Registration is fast:** the tool registers at session start and was
  visible after 50 ms.
- **Recall also works in an interactive session.** In the session that built
  it, the tool returned that session's own tool output from minutes earlier.
- **Known gap: the archive is kept per session id.** A `--fork-session` (or
  any new session id) starts an empty archive and cannot search its
  parent's.
- **Spend:** about $1.67.

## Known limits of this bench

- Short sessions maximize summary retention; long-session behavior is
  extrapolated, not measured, in v1.
- Headless (`-p`) sessions use the same engine, hooks, and compaction path as
  interactive ones, but the TUI is not covered.
- 12 items × 3 runs is a signal check, not a paper. Scale runs before making
  strong numeric claims.
