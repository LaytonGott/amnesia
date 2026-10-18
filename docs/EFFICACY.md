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

### Unprompted, with ordinary tools: Claude Code's own route matches recall

`node bench/run-recall.mjs --unprompted`:
- **One compaction,** with the same brevity instruction and a 1,000-char
  block.
- **A natural question:** "we're about to cut the release, remind me of
  these exact values", with no mention of recall or of looking anything
  up.
- **Ordinary tools:** Read, Grep and Glob were available; no shell.
- **Two arms:** UB forks the compacted session with recall off; UR resumes
  it with recall on.

| arm | correct (of 20) | what the agent did | spend |
|---|---|---|---|
| UB, recall off | **20** | 7 Grep + 1 Glob, mostly over the session's own transcript file | $0.19 |
| UR, recall on | **20** | 16 recall calls, unprompted | $0.23 |

What this says:
- **Agents do reach for recall on their own,** and use it well.
- **But Claude Code already gives them a way back.** Its summary ends with
  the path to the full transcript ("read the full transcript at …"). With
  Grep allowed, the agent searched that file with regex alternation and
  recovered every fact, in fewer calls and slightly cheaper.
- **So the earlier no-tool numbers overstate the real-world gap.** The
  stress A/B scored 2 vs 85 of 100, and the recall check 0 vs 20 of 20,
  but those probes ran with tools off. They show what the summary and the
  block carry, not what an agent with Grep can reach.

Where amnesia still adds something an agent with Grep lacks:
- **Details the agent doesn't know it lost.** Recall and Grep both need the
  agent to realize something is missing and go looking. Here it was asked
  directly about specific values. The block is the only part that puts lost
  details in front of the agent unasked. This bench doesn't measure what
  unasked loss does; the next one does: 0/30 vs 22/30.
- **Not tool results Claude Code cleared, as far as we've seen.** An earlier
  draft said the transcript keeps only a placeholder for those, and that
  this session had 3. That was wrong: the 3 were results whose own text
  quoted the placeholder string (amnesia's tests and docs). No transcript on
  the test machine has a real micro-compact event, and every cleared-looking
  result still holds its full output. Clearing happens in the live context;
  the transcript keeps the original, so Grep reaches it too.
- **Places the transcript isn't reachable:** permission rules that deny
  reading `~/.claude`, sandboxes, and setups without file tools. There,
  recall is the only way back.
- **Clean results.** Recall returns ranked snippets; Grep over JSONL returns
  escaped JSON lines. In this test that made no difference to accuracy.

Spend: $1.06.

### Unasked: does the block change the work itself? (plugin 0.8.1)

Every test above asks the agent about the lost details. The failure that
matters is different: after compaction the agent does ordinary work and
never learns that something it needs was lost. `bench/run-unasked.mjs`
measures that.

Setup:
- **Session and summary:** the same seeded ~190k-token session as above,
  compacted with the same lossy summary.
- **Arms:** A is Claude Code alone, with no plugin. C adds the plugin at its
  defaults (6,000-char block, recall on).
- **Tools:** Read, Grep, Glob, Write and Edit, so the transcript route
  stays open.
- **Runs:** 3 compactions per arm, each followed by two tasks. The tasks
  never mention a compaction, lost context, or recalling anything.

**Task 1, slots named:** "create release/release.env with RELEASE_COMMIT,
DEPLOY_REGION, … using the values we settled on." 20 slots, every value
stated earlier in the conversation and in no project file.

| arm | correct | wrong | transcript searches | tool calls | task spend |
|---|---|---|---|---|---|
| Claude Code alone | 60/60 | 0 | 36 | 42 | $0.56 |
| with amnesia | 60/60 | 0 | 0 | 6 | $0.29 |

When the task names what it needs, the agent knows it is missing something
and searches the transcript; it gets everything. The block makes that
unnecessary: 7x fewer tool calls, half the spend.

**Task 2, nothing named:** "Write release/deploy-staging.sh for the
ledger-holds release." Scored on 10 details a correct script needs:
release commit, feature toggle, staging port, ticket, region, pydantic pin,
artifact URI, next migration, status page, on-call. Each scores *correct*
(the stated value is in the script), *wrong* (a different value of the same
shape) or *absent*.

| arm | correct | wrong | absent | transcript searches |
|---|---|---|---|---|
| Claude Code alone | **0/30** | 0 | 30 | 0 |
| with amnesia | **22/30** | 0 | 8 | 0 |

- **Without the block, the agent never looked.** All three scripts were
  generic, with required inputs (`${REGION:?}`) and invented infrastructure
  (ssh + systemd in one, kubectl in another). Each reply said the details
  weren't available, e.g. "the project has no ledger-holds deploy details
  for me to use", when they had been stated earlier in the conversation.
  This is the case the transcript route can't cover: nothing told the agent
  to search.
- **With the block, the scripts carried the release's own values:** the
  pinned commit, region, port, artifact bucket, migration and pydantic pin,
  plus feature-flag keys the agent had read from files before the
  compaction.
- **Neither arm invented a value.** The harm without the block was not a
  wrong port but a script that didn't do the release you described, along
  with a confident claim that the details didn't exist.

Limits: one seeded session, a forced lossy summary (unforced summaries at
this size usually keep these facts), Sonnet, 3 runs per arm, and scoring by
pattern for 10 facts. Paths or tools the agent made up outside those 10 are
not counted. Spend: $6.30, smoke run included.

### When the block is too small: the loss index (plugin 0.9.0)

On real long compactions the block can't hold most of what was lost. The 68
compactions on the test machine that dropped 200+ messages each had 500+
missing details, and the 6,000-char block carried 60–150 of them. To mimic
that, the same deploy task ran with the block cut to 1,000 chars, which
holds about 15 of this session's ~140 missing details, none of them the
release's own. Two arms, both with recall on:
- **V:** values only.
- **I:** values plus the loss index. A line names what else was lost,
  without the values ("lumen-ledger (owner handle, pinned SDK version) ·
  incident status page · … and 92 more"), and says to look things up with
  recall.

| arm (1,000-char block) | correct | wrong | absent | recall calls |
|---|---|---|---|---|
| values only | 1/30 | **6** | 23 | 0 |
| values + loss index | **9/30** | **0** | 21 | 8 |

- **A small values-only block misleads.** All 3 V runs deployed the release
  at `lumen-holds`' commit and region. Those were the only commit and region
  in the block, and they belong to a different service. This is the first
  wrong-value harm in any arm. Claude Code alone left the values out
  instead; the full 6,000-char block had the right ones.
- **The index works by telling the agent something was lost.** None of the
  10 deploy facts were named in the index line. The agent searched recall
  anyway, for the task ("ledger-holds release staging region port deploy")
  and to check the stray values ("lumen-holds"). That recovered the commit,
  port and pydantic pin and caught the confusion: 0 wrong.
- **Still well short of a block that holds everything** (22/30). The agent
  searched broadly, then parameterized what it didn't find.

So the index is on by default whenever recall is on (`lossIndex`). Limits:
the same as above, plus 3 runs per arm. Spend: $4.28.

### Steering the summary (branch feat/steer): no measurable gain at 190k

The plugin can hand Claude Code's summarizer a must-keep list before it
writes, through the hook's `instructions`. Claude Code appends that list
verbatim after its own prompt. The list holds about 2,000 chars of the
top-ranked exact values, and it runs on `precompute` too (see
docs/MECHANISMS.md). Tested on the same seeded session with a **plain
`/compact`**, no lossy instruction, so whatever loss happens is the
summarizer's own. B is the plugin with steering off, S with it on, 3 runs
each, all on the same summary prompt arm.

| arm | seeded facts the summary kept (of 100) | deploy script correct |
|---|---|---|
| block only | 21, 100, 100 (mean 74) | 25/30 |
| steered + block | 100, 51, 100 (mean 84) | 28/30 |

- **Unforced loss here is all or nothing.** Either the summary quotes every
  user message (100/100), or it condenses them and keeps 21–51. Steering
  didn't stop the condensed mode (one steered run kept 51).
- **The differences are within noise** at 3 runs. The first steered run
  (100 vs 21) looked like a big win; the next two didn't hold it up.
- **Cost:** steered summaries ran about 30% longer (13.4k vs 10.2k chars), so
  roughly 800 more tokens stay in context after each compaction.

Not shown to help at this size. Where it might help is where summaries
lose the most, ~1M-token sessions, which this bench can't afford to seed.
Spend: $4.58.

### Just-in-time recall: the lost message rides with the prompt (branch feat/jit)

After a compaction the plugin matches each new prompt against the messages
compactions replaced (the recall archive). The prompt has to share at least
two distinctive words with a message, one of them rare across the archive.
The best few messages are then attached verbatim as hidden prompt context
(`prompt.submit`'s `context`): the agent reads them, the person doesn't see
them. The same message isn't attached twice before the next compaction.

Test: the seeded session, a lossy compaction, a 1,000-char block, the
recall tool on. The task names two services and none of their values:
"Write release/deploy-staging.sh that deploys acme-billing and kestrel-audit
to staging". Scored on the 4 values stated for them earlier (acme-billing's
staging port and ticket, kestrel-audit's bucket and commit). 3 runs per arm.

| arm (1,000-char block) | stated values in the script | wrong | recall searches |
|---|---|---|---|
| block only | **0/12** | 0 | 0 |
| block + just-in-time recall | **11/12** | 0 | 4 |

- **Without it, the agent never looked.** The recall tool was there every
  run and went unused. The scripts were generic.
- **With it, the scripts used the stated values.** One run missed the
  ticket. In two runs the attached message also led the agent to search
  recall for more.
- **It needs words to match on.** For the vaguer "Write
  release/deploy-staging.sh for the ledger-holds release", only one replaced
  message passes the threshold, offline. Each release detail sits in a
  different message, and those messages share only common words with the
  prompt ("deploy", "staging"). That would bring back the release commit
  alone, so this one wasn't run live. The block and the loss index remain
  the cover for prompts that name nothing specific.

Spend: $4.29.

**Tuned on real sessions (no model calls).** The first live use was too
eager: routine prompts like "merge it and push" got old release messages
attached. `bench/jit-audit.mts` rebuilds the archive of each real
compaction, 63 of them, and replays the 1,625 prompts actually sent
afterwards.

| rule | real prompts that carry messages | routine prompts in this session (of 8) | bench owners prompt |
|---|---|---|---|
| two distinctive words, one rare | 73% | 4 attach | 4/4 values |
| + the rare one must be a name (`acme-billing`, `v0.17.0`, `retry_ms`) | 42% | — | — |
| + a name in at most 3 replaced messages | 22% | — | — |
| + match only what a message said, not the tool calls archived with it | **23%** | **0 attach** | **4/4 values** |

- **The 23% that still attach** are mostly the intended kind. A prompt that
  names a specific case gets the message that first specified it ("Re-run
  the failed `configunits` v7 / `async_webhooks` calibration" brings back
  that calibration's spec). Standing rules also come back for a related
  task.
- **One loss:** the vague ledger-holds prompt now attaches nothing, not
  even the release commit.

**Tried and not shipped: write-time recall.** The same matcher, fed what
an edit names (the file and its folder, plus the head of the text written),
with results attached to the Write/Edit result. Replayed offline on the
7,850 real edits made after compactions, 13% would have carried messages.
- **Some fit:** editing a harness file brought back that task's spec, and
  editing a test brought back the rule it checks.
- **Many didn't:** the agent's own earlier design notes, matched on shared
  code names, and one match on a summary's transcript-path line, because
  scripts contain long paths and ids.

With no bench showing a gain, that context cost isn't justified.

## Ranking learned from what real sessions needed again

Until now the block's ranking was hand-tuned, and it was judged by eye or
on synthetic sessions. Real sessions hold a ground truth: after a
compaction, which of the dropped details did the person or the agent use
again? `bench/needed-later.mts` rebuilds every real compaction on the test
machine (69 with work after them) and counts a dropped detail (missing
from the summary and the kept messages) as needed when its value shows up
later in a prompt, the agent's text, or a tool call's input. Tool output
doesn't count, because re-reading a file isn't memory. 39,321 dropped
details were needed again; the hand-tuned block carried 14.6% of them.

What predicts reuse, from the same data:

| signal | used again |
|---|---|
| seen 10+ times / once | 34% / 9% |
| in the last 10% of what was replaced / the first quarter | 28.5% / 8% |
| a setting (`key = value`) | 34% |
| hashes / URLs / paths / versions | 1.9% / 3.9% / 5.6% / 5.4% |
| 4–11 characters / 30+ | 20.6% / 3.3% |

The hand-tuned ranking had it partly backwards: hashes, URLs, paths and
versions sat in the top tiers.

**The learned ranking.** A log-odds weight per signal (kind, who wrote it,
recency, count, length, seen only in file reads), fitted to the strictest
label: details the person later had to say again.
- **Protected kinds:** hashes, URLs, settings and ticket codes keep a fixed
  bonus. They're rarely repeated, but they can't be re-derived when they
  are.
- **Cap:** no single kind takes more than 12 lines.
- **URL pieces:** a domain or path fragment inside a URL is no longer a
  detail of its own.

Fitted on half the sessions and measured on the other half, both ways:

| measured on | hand-tuned | learned |
|---|---|---|
| the person said it again later | 41.5% / 39.3% | **49.0% / 45.0%** |
| used again at all | 15.5% / 13.9% | **22.0% / 21.5%** |
| hash/URL lines kept | 352 / 617 | 363 / 671 |

On all 69 compactions, with the shipped weights: **22.5% of needed-later
details carried, up from 14.6%**, at the same 6,000 chars, with line
precision unchanged (58.1%). The synthetic A/B replays are unchanged: all
80 and all 788 dropped facts are still carried, bound to their owners.

**The first version flooded one real block** (a session writing semver
tests) with fixture versions and dropped its commits. That's why versions
lost their protection and the per-kind cap exists. On that compaction the
block now carries 4 more commits, the test files and the flags in use,
instead of about 20 research links and version strings.

## Known limits of this bench

- Short sessions maximize summary retention; long-session behavior is
  extrapolated, not measured, in v1.
- Headless (`-p`) sessions use the same engine, hooks, and compaction path as
  interactive ones, but the TUI is not covered.
- 12 items × 3 runs is a signal check, not a paper. Scale runs before making
  strong numeric claims.
