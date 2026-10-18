# amnesia

**When Claude Code compacts a long session, the summary keeps the story and
drops the specifics. amnesia shows you what was dropped, and puts the exact
details back.**

The specifics are the commit you pinned, the port, the env var, the value
the agent looked up twenty minutes ago. amnesia does two jobs:

- **The receipt** (CLI, free, read-only): for every compaction on your
  machine, what was replaced, by what summary, and what it cost.
- **The plugin** (recommended): at each compaction it lets Claude Code
  write its normal summary, then appends the exact details that summary
  dropped, right after it, with the words that say what each one belongs to.

## The evidence

All numbers come from benches in this repo you can re-run
([docs/EFFICACY.md](docs/EFFICACY.md)).

**When the summary loses details, the plugin is what brings them back.** One
session was seeded with 100 exact facts (~190k tokens), then compacted with a
summary told to keep almost nothing, and probed with tools off. Same session,
same model; the arms differ only by the plugin.

| | facts recalled (of 100) |
|---|---|
| Claude Code alone | **2** |
| with the amnesia plugin | **85** (identical in all 4 runs) |

- **The agent recalls what the block carries.** 332 of 336 carried facts.
- **Without it, the agent says "unknown" rather than guessing.**
- **The rest is budget.** Most of the 15 missed per run simply didn't fit in
  the block's ~1.5k-token budget.

**Read that with tools in mind.** Those probes ran with tools off. Claude
Code's summary ends with the path to the full transcript, and an agent that
knows it lost something and has Grep can search that file itself. In an
unprompted test with ordinary tools, it recovered 20 of 20 that way, as did
an agent using amnesia's recall tool.

What amnesia adds over that:
- **Lost details shown unasked.** The block puts them in front of the agent
  before it realizes they're missing, which is the case the transcript
  route can't cover. Measured with tools on: asked only to "write
  release/deploy-staging.sh", the agent alone used 0 of 30 stated details.
  It wrote generic scripts and said the details didn't exist, and never
  searched the transcript. With the plugin it used 22 of 30. Neither arm
  invented a value.
- **Less searching when it does know.** When a task names the values it
  needs, both arms get them all, but the plugin arm used 6 tool calls to
  the plain arm's 42, at half the spend.
- **Setups where the transcript isn't readable.**
- **No transcript path needed.** Recall searches without the agent knowing
  where the session file is, and returns ranked snippets, not JSONL lines.

Details: [docs/EFFICACY.md](docs/EFFICACY.md).

**How often summaries lose details depends on session length.**
- **At ~190k tokens it's rare.** Unforced summaries kept every fact in 17 of
  20 runs. When they did drop facts, the block carried them and the agent
  recalled 52 of 60, against 1 of 37 it lacked.
- **At ~1M tokens loss is the norm.** On 73 real compactions from long
  sessions, only **19%** of the exact strings in your dropped prompts made it
  into the summary.

**What summaries keep well: your rules.** About 83% of dropped constraints
survive. The loss is in the specifics, which is what the plugin targets.

## Install

**The plugin.** In Claude Code (one-step install needs Claude Code 2.1.275
or later; verified on 2.1.299+):

```
/plugin install amnesia --marketplace LaytonGott/amnesia
```

- **From a shell:** `claude plugin install amnesia --marketplace LaytonGott/amnesia`.
- **In the desktop app:** click + next to the prompt box, then Plugins, Add
  marketplace with `LaytonGott/amnesia`, then add the plugin.
- **Org-managed installs:** Claude Code only runs this hook in a plugin
  your organization lists in managed settings.

**The CLI** (receipts, restore, doctor) needs Node 18+. It isn't on npm yet;
run it straight from GitHub:

```
npx github:LaytonGott/amnesia
```

Below, `amnesia` stands for that command. Check your setup anytime with
`amnesia doctor`.

**Older Claude Code** without hooks-module plugins: `amnesia install` wires
command hooks instead. They snapshot your prompts before each compaction and
re-inject the most recent ones on your next prompt. That's weaker than the
plugin: it covers your prompts only, and it lands a turn late. If the plugin
is active, `install` skips the hooks and `doctor` warns when both are on.

## What the plugin adds

Right after Claude Code's summary, in the compacted context itself:

```
[amnesia] Exact details the summary above dropped, verbatim from the replaced
history. For reference only: newer instructions win, and do not redo actions
that were already completed.
- For brisk-payouts, the pinned SDK version is 5.13.1
- settlement_retry_timeout_ms = 7350
- E-LEDGER-4471 — "The only FATAL is `E-LEDGER-4471` (line 700)…"
- 0ef02c3 — "merged as 0ef02c3 after review"
```

How it picks what to add:
- **What it looks for:** settings, paths, URLs, hashes, versions, tickets,
  env vars and @handles.
- **What ranks first:** what you or the agent wrote, ahead of tool output.
  Output of tools that only read files ranks last, since it can be read
  again.
- **What it leaves out:** anything the summary already has.
- **The budget:** 6,000 chars by default, about 1.5k tokens, added to
  context after each compaction. It is the plugin's `budgetChars` setting
  (1,000–40,000): `claude plugin configure amnesia`, or the plugin's row in
  the config menu.
- **When it doesn't all fit:** long sessions lose far more than any block
  holds. Then part of the budget names the rest without values ("Also
  dropped (look up with recall …): acme-billing (staging port, ticket) · …
  and 92 more"). That way the agent knows something was lost and searches
  before relying on a guess. With a 1,000-char block, that took a deploy
  task from 6 wrong values to 0. The `lossIndex` setting turns it off.

It never changes the summary, and on any failure Claude Code's own result
stands. Design and measurements: [docs/DESIGN-compact-hook.md](docs/DESIGN-compact-hook.md).

### The recall tool

The block is capped. Recall is not:
- **What it keeps:** the plugin archives every tool output as it happens,
  and every message a compaction replaces.
- **What the agent gets:** a tool, `mcp__amnesia__recall`, that searches all
  of it word for word, including old tool results Claude Code has since
  cleared from the live context.
- **Measured:** with a summary that kept nothing and a tiny block, the agent
  answered 0 of 20 exact-detail questions without recall and 20 of 20 with
  it ([docs/EFFICACY.md](docs/EFFICACY.md)).

Where it lives, and how to control it:
- **Location:** archives go to `~/.claude/amnesia/archive/<session id>/`
  (`AMNESIA_HOME` overrides it), beside Claude Code's own transcripts.
- **Secrets:** private keys, common token formats and `password=`/`token:`
  values are redacted before anything is written.
- **Turning it off:** set the plugin's `recall` option to `false` to stop
  archiving.
- **Forked sessions:** a forked session starts its own, empty archive.

## The receipt

```
  amnesia · compaction receipt for claude-code
  my-project/5fdbd371
  ────────────────────────────────────────────────────────────────
  event 1/1 2026-08-18 20:23 UTC · trigger auto

   context     998,312 → 31,348 tokens   (96.9% dropped)
   dead time   1m 56s
   replaced    ~731 messages (45 prompts, 686 replies, 490 tool batches)
   origin      replaced history lives in session a74c3675 (this file starts post-compaction)
   preserved   8 message(s) kept verbatim
   kept        summary has 71 of 292 exact strings from your dropped prompts (24%)
   cumulative  966,964 tokens forgotten this session

   what your agent now believes:
   │ This session is being continued from a previous conversation…

   what it dropped (oldest first):
   03:13  user  You are auditing Hermes to define the minimum stable…
   03:24  user  Audit only. Do not modify code. …
```

`kept` counts the distinct paths, ids, versions and hyphenated names (5+
characters) in the prompts that were replaced, and how many of them the
summary still contains. It is the same measure as the 19% figure above.

With the plugin active, each compaction's receipt also shows what the block
kept:

```
   kept        summary has 22 of 79 exact strings from your dropped prompts (28%); amnesia's block brought back 8 more
   amnesia     block kept 75 exact detail(s) the summary dropped (5,999 chars)

   what amnesia kept (first 5):
   + For brisk-payouts: the pinned SDK version is 5.13.1; the staging port is 45574
   + settlement_retry_timeout_ms = 7350
   …
```

## Commands

```
amnesia                          scan all sessions for compaction events
amnesia <session-id>             full receipt for one session
amnesia card [<session-id>]      shareable receipt card (HTML)
amnesia codex [<session-id>]     the same for Codex CLI sessions

amnesia restore [<session-id>]   write your dropped prompts + the summary to a file
amnesia restore --all            every compaction in a session

amnesia doctor                   check the plugin or the hooks are active
amnesia install | uninstall      command-hook fallback for older Claude Code
amnesia home                     where amnesia keeps its files

amnesia protect [--write]        pin dropped rules into CLAUDE.md (see below)
amnesia recover [<session-id>]   copy tool outputs Claude Code persisted to disk

--json                           machine-readable output
--root <dir>                     a different projects root
```

**restore.** Claude Code keeps the full history in the session file; it just
stops loading it. `restore` writes the prompts you wrote before each
compaction, and the summary that replaced them, to
`~/.claude/amnesia/<project>/`, with one line to paste back to your agent.
The summary itself now ends with the transcript path too.

**protect** is a sharp tool. It keyword-matches constraint-like sentences
from your dropped prompts and, with `--write`, pins them into a marked
section of the session's project `CLAUDE.md`. Pinned rules apply to every
future session there, so drop one-off instructions ("audit only today")
before writing. Summaries already keep most rules.

**recover** copies tool outputs Claude Code persisted to disk
(`<session>/tool-results/`) into one folder with a manifest. It only copies
files inside a session's own `tool-results/` directory.

## How it works

Claude Code stores every session as JSONL under `~/.claude/projects/`.
Compactions are recorded inline as `compact_boundary` events: token counts,
duration, and the messages kept verbatim. amnesia reconstructs what each
compaction replaced and reads the summary that took its place. The plugin
hooks Claude Code's `session.compact` event, calls Claude Code's own
compaction first, and appends to the result.

- Reads only your local files. No network, no dependencies.
- Everything amnesia writes lives under `~/.claude/amnesia/` (`AMNESIA_HOME`
  overrides it). The exceptions are `CLAUDE.md` when you run
  `protect --write`, and files you point `--out` at.
- Your `settings.json` is backed up before any change, and only amnesia's
  entries are touched.
- Every scan reports unrecognized journal entries, so format drift is loud.
  More: [docs/MECHANISMS.md](docs/MECHANISMS.md),
  [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Roadmap

- [x] Receipts for Claude Code and Codex CLI
- [x] Compaction plugin: exact details appended after the summary
- [ ] Publish the CLI to npm
- [ ] Natural ~1M-token behavioral test
- [ ] Gemini CLI / opencode session support

## License

MIT
