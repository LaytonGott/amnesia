# Design: append-to-core compaction (`session.compact` plugin hook)

Status: proposal with a working prototype. Researched against Claude Code
2.1.302 (binary) and the 2.1.299 plugin API typings (`claude-code.d.ts`,
plugin-authoring reference). See "Open questions — answered" below.

## Why

`docs/EFFICACY.md` measured what compaction loses on 81 real boundaries:
explicit constraints mostly survive (82.9%), exact technical strings mostly do
not (29.1% survive). The summarizer prompt explains it: one variant is capped
"in 2000 words or fewer" (behind a `capped` flag, not every compaction), and
even the uncapped prompt asks for "all facts, file paths, function names" and
still drops most of them.

The current hooks (PostCompact + UserPromptSubmit) re-inject recent *user
prompts* on the next turn. The strings that die mostly live in assistant
replies and tool output, which that path never touches.

## What the platform offers

| Fact | Source |
|---|---|
| Compaction is a hookable event, `session.compact`, in the **plugin hooks-module** API (`hooks/hooks.json` → `{ "modules": ["./register.ts"] }`), not the `settings.json` command-hook system amnesia uses today | typings `EventInputs['session.compact']`; binary `$i("session.compact", { core: … })` |
| Hook signature `($, e, next)`; `next(e)` runs plugins beneath, then **core** (the LLM summary). `next` resolves `{ messages, tokensBefore?, tokensAfter?, usage? }` | typings `SessionCompactResult` |
| Input: `trigger` (`manual` / `auto` / `plugin` / `precompute`, pinned), `agentId?` (pinned), `instructions?` (rewritable), `messages: SessionMessage[]` (rewritable, each with an engine `handle`) | typings `SessionCompactInput` |
| `SessionMessage` = `{ role, text, toolUses: { tool, input, text?, result?, isError? }[], toolResults?, handle? }`. A message handed back **with** its handle "stands as the engine has it"; one **without** is built from `role`, `text`, tool blocks | typings |
| If the hook's returned messages equal core's rows, core's result is used as-is; otherwise the log reads `a hook's N messages stand … core ran beneath`, telemetry `tengu_compact_replaced_by_hook { ranCore: true }`, and `postTokens` is recomputed from the hook's messages | binary |
| Result checks: `{ messages }` or `{ skip }`, numeric token counts, valid usage; a `skip` after `next()` compacted is refused | binary `check` for `session.compact` |
| A hook that throws / returns a bad shape / outlasts its budget is skipped. With `.catch(($, e, next) => next.called ? next(e) : next(e))`, a failure after `next` replays core's settled result, so **nothing runs twice** | reference.md |
| `precompute` dispatches install nothing; their result is kept and reused by the next real compaction, which dispatches again (`usage` absent when core reused a precomputed summary) | typings |
| **`session.compact` is a privileged event**: where an organization manages Claude Code, it does not run in a plugin a person installs, only in one the org lists in managed settings | binary (`… do not run in a plugin a person installs where an organization manages Claude Code`) |
| Module runtime has no Node and no DOM; I/O goes through `$` (`$.fs`, …) | skill docs |

## Design

Wrap core, never replace it. Core keeps doing what it does well (narrative,
rules); amnesia adds back the exact strings core verifiably dropped.

```ts
on("session.compact", async ($, e, next) => {
  if (e.trigger === "precompute" || e.agentId) return next(e);   // v1: main loop, real compactions only

  const before = e.messages;
  const done = await next(withMustKeep(e));                       // phase 1 (optional), see below
  if (done.skip) return done;

  const inHandles = new Set(before.map(m => m.handle));
  const outHandles = new Set(done.messages.map(m => m.handle));
  const dropped = before.filter(m => !outHandles.has(m.handle));  // exact: no line-number reconstruction
  const summary = done.messages.filter(m => !inHandles.has(m.handle)).map(m => m.text).join("\n");

  const block = specificsBlock(dropped, summary, options.budgetChars);
  if (!block) return done;                                        // nothing missing → core result untouched

  const msgs = [...done.messages];
  msgs.splice(1, 0, { role: "user", text: block, toolUses: [] }); // right after the summary
  const { tokensAfter: _stale, ...rest } = done;                  // the engine recounts postTokens
  return { ...rest, messages: msgs };
}).catch(($, e, next) => next(e));                                // any failure → core's own result
```

### `specificsBlock(dropped, summary, budget)`

1. Collect candidate strings from every dropped message: `text`, each
   `toolUses[].input` (stringified values) and `toolUses[].text`,
   `toolResults[].text`. Kinds: file paths, `name.ext` files, dotted names,
   identifiers containing `_`/digits/camelCase humps, versions, hashes and
   IDs, URLs, CLI flags, env vars, error codes.
   Also captured since v7:
   - **Settings: a value bound to its key.** In what the person or the agent
     wrote, `` `key` is `value` `` or `` `key` is 7350 ``. Anywhere,
     `key: value`, `key = value`, `KEY=value` or `"key": "value"`. The item
     is `key = value`, so the value never travels without its name. Code
     defaults and type hints (`= None`, `= bool`, `= 0.0`) are skipped.
   - **Codes:** uppercase coded IDs with a digit (`OPS-77412`,
     `E-LEDGER-4471`), and colon-hex serials (`6A:3F:91:0C:5D`).
   - **Backticked spans** in what the person or the agent wrote that look
     like a detail (a digit, a symbol, mixed case). A single name with no
     digit (`created_at`) ranks as the identifier it is.
2. Keep those **absent from `summary`** (exact substring, case-sensitive).
   A setting counts as kept only if the summary has both its key and its
   value.
3. Score (as tuned against the audit below):
   `4·source + 2·kind + log2(1+count) + 3·recency − 8 if seen only in
   Read/Grep/Glob output − 3 if seen only in tool traffic − 12 for a path
   never written by the person or the agent`.
   - **Source**: what the person typed 4; the agent's text and carried
     items 3; tool inputs and an earlier summary 2; tool output and harness
     rows (`<system-reminder>`, skill bodies) 1; Read/Grep/Glob output 0.
   - **Kind**:
     - 5: setting (stated in prose), URL, hash, serial
     - 4: version, code, path, env var
     - 3: file name, backticked detail
     - 2: flag, dotted name, setting found only in tool traffic
     - 1: identifier
   - Hex runs inside UUIDs are not hashes.
   - A tool_result that mirrors its tool use's text is counted once, and so
     is one occurrence matched by two patterns.
   - A single mention in tool traffic is dropped.
4. Emit until `budget` (default 6,000 chars ≈ 1.5k tokens, `userConfig`):
   one line per string with ~60 chars of context from its best occurrence,
   so the agent knows what it refers to. Settings lines carry no context:
   `key = value` already says what the value is.

```
[amnesia] Exact details the summary above dropped (verbatim from the replaced
history; for reference, newer instructions win; do not redo completed actions):
- src/runtime/config.ts — "moved temperature handling into src/runtime/config.ts"
- config.temperature — "arm.config overrides config.temperature per run"
…
```

The framing line fixes the risk flagged in the audit: the current injection
says old prompts "still apply", which invites redoing one-shot actions.

### Phase 1 (optional): steer the summarizer first

`next({ ...e, instructions })` changes what the summarizer is told. Before
calling core, append (never replace the user's own `/compact` text) a short
must-keep list: the top ~30 specifics from **user prompts** only. Core then
spends its own budget on them, and phase 2 only adds what it still dropped.
Ship v1 without it; turn it on only if the offline audit shows phase 2's block
is regularly near budget.

### Relationship to the existing command hooks

When the plugin is active, the PostCompact + UserPromptSubmit injection is
redundant (and worse: it lands a turn late and outside the compacted context).
`amnesia install` should install one or the other; `doctor` should flag both
present. Keep the PreCompact snapshot.

### amnesia's own parser

The appended message is stored as a plain user row (verified, see below). It
starts with `[amnesia]`, so `scanFile` / `collectHistory` must skip rows that
start with that marker; otherwise receipts count it as a prompt. The plugin
itself re-reads only an earlier block's item lines, to carry them forward.

## Packaging

- `plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json`
  (`{ "modules": ["./register.ts"] }`), `plugin/hooks/register.ts`.
- No Node in the module; static relative imports work (verified). The
  extractor is pure string code in `hooks/specifics.ts`. Node 24 runs that file
  directly (type stripping), so the CLI audit can import the same file, as the
  prototype's benchmark script does. On Node 18–22 the CLI needs a `.mjs`
  build of it.
- Repo-root `.claude-plugin/marketplace.json` →
  `/plugin install amnesia --marketplace LaytonGott/amnesia`.
- `userConfig`: `budgetChars` (default 6000), `steerSummarizer` (default off).

## Open questions — answered by the prototype (2026-10-17, CC 2.1.302)

The prototype is a scratch plugin (`plugin.json`, `hooks/hooks.json`,
`hooks/register.ts`, `hooks/specifics.ts`, two test files). It passes
`claude plugin validate`, `tsc` under the strict config the typings
prescribe, and 9/9 `claude plugin test` cases. It also ran two real headless
`/compact`s in a scratch project via `--plugin-dir`. Nothing was installed
and no settings were touched.

1. **Stored shape: a plain `user` row.** It is its own row with no `isMeta`
   and no `isCompactSummary`, parented to the summary row, and does not merge
   with it. The boundary's `postTokens` include it (8,166 after the first
   compaction). amnesia's own parsers would count it as a prompt, so
   `scanFile` / `collectHistory` must skip rows that start with `[amnesia]`.
   The engine logged `session.compact (manual): a hook's 4 messages stand
   (hooked by amnesia+cc-plugin-agents-md); core ran beneath`.
2. **Inserting after the summary is safe in what was observed, and is safe by
   construction.** Both real compactions kept only the last assistant reply,
   so a kept `tool_use`/`tool_result` pair was **not** reproduced. The block
   goes directly after core's last new message (the summary). Core's kept
   messages follow it already, so the insert can only split a pair that core
   itself split. The next turn after each compaction ran normally, and
   back-to-back user rows (summary, then block) were accepted.
3. **Budget: 10 s of the hook's own time, and time spent in `next()` does not
   count.** `session.compact` sets no override of the engine default
   (`Xme=1e4`). Evidence: a kit test put 12 s beneath the plugin (an inline
   `builtin`-tier plugin sleeping 6 s above a 6 s fake core), and the block was
   still appended. A single hook sleeping 12 s of its own was cut at 10 s.
   On your largest real compactions (0.5–0.8M chars dropped, 1.3–1.5k
   messages) the extractor takes about 80–95 ms in Node.
4. **Relative imports: yes, as static `import` declarations of plugin files
   named `.ts`/`.js`/….** `import { … } from './specifics.ts'` validates and
   loads. `import()` is not allowed, and there is no Node or `require`.
5. **Minimum version: unknown exactly.** `session.compact`,
   `tengu_compact_replaced_by_hook` and hooks modules are present in 2.1.299
   and 2.1.302 and absent from 2.1.169 (your June binary). The changelog
   embedded in 2.1.302 only goes back to 2.1.293. Gate on what loads, not on
   a version number: keep the command-hook path for older installs, and have
   `doctor` report which path is active.

### Also found while prototyping

- **Org-managed installs are confirmed by the validator itself:** "hooks on
  session.compact do not run in a plugin a person installs where an
  organization manages Claude Code".
- **Carry-forward:** the first version skipped earlier `[amnesia]` blocks.
  A second compaction then loses the first block's items unless the original
  text happens to survive. The prototype now re-reads each earlier block's
  `- <item>` lines (not its header or context) as candidates. They rank as
  old, so newer details win the budget.
- **Ranking quality was the weak spot; tuned against an offline audit.**
  The first ranker filled the block with code field names (`sessionStore`,
  `formData`, `whyShouldWork`) ahead of commits, PR links and paths. See
  "Ranking audit" below.
- **Noise guards added:** slash-separated prose (`deploy/infra`) is not taken
  for a path. A shorter string inside a longer chosen one (`config.ts` in
  `src/runtime/config.ts`) is dropped. Any `scheme://` URL is caught whole.
- **Claude Code's summary now ends with a pointer to the full transcript
  file** ("read the full transcript at: …"). That's a built-in partial
  answer to `restore`.
- **The auto-memory feature can capture "remember X" facts on its own**
  (the probe's region and ticket ended up in the project's `memory/`). Any
  recall bench has to disable it or probe facts it didn't save.
- `$.ui.status` is a no-op headless (logged only).

## Ranking audit (2026-10-17)

`node bench/audit-specifics.mts` (Node 22.18+/24, no model calls) rebuilds,
for every real compaction under `~/.claude/projects`, the messages the
compaction replaced. It rebuilds them the way the engine hands them to the
hook, with tool results attached to their tool uses. It then runs
`specificsBlock` against the real summary and scores the block with its own
classifiers, independent of the ranker. Run: 171 session files, 84 distinct
compactions, 6,000-char budget. `AUDIT_MODULE=<file>` runs another version
of the extractor.

| metric | summary alone | v0 (first prototype) | v3 (tuned) |
|---|---|---|---|
| exact strings from dropped prompts (EFFICACY.md's class) present | 19.6% | 27.1% | **29.5%** |
| high-value strings (hash, URL, version, path, env var) missing from the summary that the block brings back | 0% | 1.9% | **6.0%** |
| block items that are identifiers | — | 67.0% | 24.0% |
| block items only ever seen in Read/Grep/Glob output | — | 0.2% | 0.0% |
| slowest extraction | — | 274 ms | 257 ms |

Per kind, v3 brings back hashes 11.3%, URLs 10.3%, versions 8.0%, env vars
5.5% and paths 4.0% of what the summary dropped. v3's block mix: paths
25.7%, identifiers 24.0%, hashes 16.6%, URLs 14.4%, files 9.0%, env vars
8.7%, versions 1.6%.

How the tuning went:

- **v1, kind tiers above source:** high-value recovery rose to 7.2%, but
  prompt strings fell to 23.4%. UUID fragments and tool-output hashes
  pushed out what the person typed. That is the wrong trade.
- **v2, source weighted above kind:** also excludes UUID hex and catches
  kebab-case names. Both metrics beat v0.
- **v3, two more changes:**
  - Context snippets shortened from 120 to 60 chars. That fits about 25%
    more items per block.
  - A double-count fix, caught by a unit test: one occurrence matched by two
    patterns was counted twice, which let single tool-output mentions past
    the noise filter.
- **Context length is the main remaining lever.** At 40 chars: 31.1% /
  7.0%. At 60: 29.4% / 5.9%. At 90: 28.6% / 5.1%. The audit cannot measure
  whether context helps the agent understand an item, so 60 is a judgment
  call. Only the behavioral A/B can settle it.
- **The Read/Grep down-weight barely mattered.** Read-only strings were
  0.2% of the first ranker's block. The flood came from identifiers in the
  person's and the agent's own text, and from tool output being counted
  twice.
- **The real ceiling is the budget.** Per compaction there are about 670
  missing high-value strings and about 160 missing prompt strings, against
  about 50 lines in 6,000 chars. Raising the budget is the remaining big
  lever, and it costs context on every turn after.

The block on the largest real compaction (f3d9 event 16) now leads with
routes, merge commits (`fdd2b8b`, `9431b59`), env vars (`SUPABASE_URL`) and
PR links, instead of field names.

### v7: the gaps the behavioral A/B exposed

The A/B (docs/EFFICACY.md) had one run where the summary dropped 17 facts.
The v3 block carried 6 of them. Every miss was a kind the extractor never
looked for:
- a bare value next to its key (`settlement_retry_timeout_ms` is 7350)
- uppercase codes (`E-LEDGER-4471`)
- colon-hex serials (`6A:3F:91:0C:5D`)

Meanwhile absolute file paths only ever passed to tools filled the spare
budget. v7 adds settings, codes, serials and backticked details, and
penalizes tool-only paths (see the scoring spec above).

`node bench/replay-ab.mts bench/results/ab-100` replays each A/B run's real
compaction offline (fork transcript, real summary) with the current
extractor. It reproduces the live result exactly for v3 (6 of 17). With v7
it carries all **17 of 17**. That number is partly by construction, since the
fixes came from that run, so the real-data audit is the check for
overfitting. For that audit, synthetic bench sessions are now excluded,
leaving 163 files and 73 compactions, and two measures were added:
- the high-value strings the person or the agent actually wrote
- named settings stated in prose (`` `key` is 7350 ``, `key_x = 41`)

| metric (73 real compactions) | v0 | v3 | v7 |
|---|---|---|---|
| exact strings from dropped prompts present (summary alone 19.1%) | 26.5% | 28.9% | **30.6%** |
| named settings stated in prose, missing from summary, brought back | 7.6% | 7.3% | **29.6%** |
| high-value strings the person or the agent wrote, brought back | 10.6% | **51.2%** | 48.0% |
| all high-value strings incl. tool traffic, brought back | 1.8% | **6.0%** | 5.2% |
| items per block (avg chars ~5,490) | 47.7 | 58.4 | 69.6 |
| slowest extraction | 227 ms | 266 ms | 221 ms |

The trade:
- **Settings quadrupled**, and prompt strings rose another 1.7 points.
- **High-value strings the person or the agent wrote dipped 3.2 points.**
  About 235 settings were gained against about 175 such strings lost.
- **The fall in all high-value strings is mostly intended.** Paths seen only
  in tool traffic are deprioritized (path recovery 4.0% → 2.8%).

How v7 got there:
- **v4:** the first cut made backticked spans tier 3. On real sessions that
  promoted every backticked column name (`created_at`, `item_key`), and
  agent-written high-value recovery fell to 43.6%.
- **v5:** single names now rank as identifiers, and trivial code-default
  values are skipped.
- **v6:** settings found only in tool traffic rank as tier 2. This barely
  mattered, because the settings were mostly prose already.
- **v7:** settings lines dropped their redundant context. That fit about 20%
  more items, and lifted every measure.

### v8: binding values to their owners

The v7 live batch carried 54 of the 63 facts its summary dropped, and the
agent recalled 47. Every carried miss was a value whose owner sat outside
the snippet ("…payouts, the pinned SDK version is 5.13.1"). v8:
- **Snippets lean left:** 70 chars before the value, 20 after, from the
  start of its sentence to its end. Shown up to 80 chars, cut from the
  right.
- **Prose clauses are captured as settings.** "For cobalt-payouts, the
  staging port is 17448" becomes one item, so the value carries its owner.

| | v7 | v8 |
|---|---|---|
| dropped facts carried, three lossy live runs (replay) | 88/97 | **97/97** |
| of those, value and owner on one line | 61 | **97** |
| real data: dropped-prompt strings | 30.6% | 30.9% |
| real data: high-value strings the person/agent wrote | 48.0% | 50.2% |
| real data: named settings | 29.6% | 30.6% |

Live under a forced-lossy summary (docs/EFFICACY.md):
- the baseline recalled 2 of 100 facts, the plugin arm 85;
- 332 of 336 carried facts were recalled.

Remaining gaps:
- the budget (the block filled at 84 items);
- prose without "the" ("Our deploy region is …", "On-call owner is …");
- `@handles`.

### v9: the remaining phrasings, and agent-reported values on equal terms

- **More prose clauses are caught.**
  - Clauses without "the": "Our deploy region is …", "On-call owner is …".
  - New verbs: "listens on port", "runs on", "pinned to", "set to".
  - `@handle` values.
  - Guards: no pronoun subjects ("there are 12"), no bare one- or two-digit
    counts, no estimates (`~15`), and no markdown, table, arrow or quoted
    fragments.
- **`@handles` are their own kind** (tier 4), matched only in what the
  person or the agent wrote. Emails don't match.
- **Settings stated by the agent weigh the same as the person's.** A value
  the agent looked up and reported ("`settlement_retry_timeout_ms` is
  7350") is as settled as one the person typed. In v8 those lost the
  budget to the person's own clauses.

| | v8 | v9 |
|---|---|---|
| stress runs: dropped facts carried (replay, 8 runs) | 662/798 | **766/798**, all bound |
| natural lossy runs: dropped facts carried (replay) | 97/97 | 97/97 |
| real data: dropped-prompt strings present | 30.9% | 30.9% |
| real data: named settings brought back | 30.6% | 32.4% |
| real data: high-value strings the person/agent wrote | 50.2% | 48.5% |
| slowest extraction | 412 ms | 506 ms |

The trade on real data is a 1.7-point dip in agent- and person-written
high-value strings. It splits about evenly between the wider prose patterns
(their items count as "other" in the audit, which cannot credit a clause)
and the equal weighting. That's the cost of carrying 104 more facts per
8 stress runs.

Left uncarried under stress, all for budget:
- one ticket (`OPS-77412`);
- one cert serial;
- two cron schedules.

Every remaining loss is the 6,000-char budget.

## Validation

1. **Offline, $0:** extend `bench/audit-real.mjs` to run `specificsBlock` on
   each real boundary's dropped set and report survival of exact strings in
   `summary + block` vs `summary` alone (today 29.1%), plus block size.
   Expect large gains by construction; the useful numbers are block size and
   what fraction of the budget is noise.
2. **Behavioral:** the existing A/B bench with arm C = plugin. Probes on exact
   details are the ones that should move. Only this result goes in the README
   headline.

## Risks

- Org-managed installs: the event does not run for user-installed plugins.
  Detect and say so (`doctor`), fall back to command hooks.
- Budget creep: every appended token is post-compaction context the user
  pays for on every turn until the next compaction. Default small,
  configurable, measured.
- Noise: identifier regexes over tool output pick up junk. Source weighting
  and the min-frequency rule for tool output are the guard; the audit
  measures it.
- API churn: the plugin API is new and moving. Pin the tested CC version in
  the README and keep the command-hook path working.
