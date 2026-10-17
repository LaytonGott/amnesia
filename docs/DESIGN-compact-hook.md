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
2. Keep those **absent from `summary`** (exact substring, case-sensitive).
3. Score: recency (last occurrence index), frequency, source weight
   (user > assistant > tool input > tool output). Drop single-use strings
   from tool output (noise from logs).
4. Emit until `budget` (default 6,000 chars ≈ 1.5k tokens, `userConfig`):
   one line per string with ~60 chars of context from its last occurrence, so
   the agent knows what it refers to:

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
- **Ranking quality on real data is the weak spot.** On f3d9 event 16 there
  were 3,402 candidates and 500+ missing from the summary, and only 53 fit in
  6,000 chars. The top of the list was dominated by code field names
  (`sessionStore`, `formData`, `whyShouldWork`) the agent could re-read from
  files, ahead of commits, PR numbers and paths. Next tuning steps:
  - Rank by kind: hash / URL / version / path / env var above identifiers.
  - Down-weight strings that only appear in Read/Grep output (recoverable
    from disk).
  - Measure with the offline audit.
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
