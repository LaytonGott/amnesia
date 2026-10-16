# amnesia

**Your AI coding agent forgets. Get it back.**

When a Claude Code session runs long, the agent quietly replaces your history
with a summary — hundreds of messages, hundreds of thousands of tokens, gone
from context. No notice, no receipt. amnesia gives you all four:

1. **The receipt** — see exactly what was forgotten, when, and what it cost you
2. **`restore`** — recover the dropped messages into a readable file your agent can re-read
3. **`protect`** — move your dropped rules into `CLAUDE.md` so they survive every future compaction
4. **`recover`** — bring back tool outputs that were persisted to disk and replaced with a pointer

```
  amnesia · compaction receipt for claude-code
  my-project/5fdbd371
  ────────────────────────────────────────────────────────────────
  event 1/1 2026-08-18 20:23 · trigger auto

   context     998,312 → 31,348 tokens   (96.9% dropped)
   dead time   1m 56s
   replaced    ~731 messages (45 prompts, 686 replies, 490 tool batches)
   origin      replaced history lives in session a74c3675 (this file starts post-compaction)
   preserved   8 message(s) kept verbatim
   cumulative  966,964 tokens forgotten this session

   what your agent now believes:
   │ This session is being continued from a previous conversation…

   what it dropped (oldest first):
   03:13  user  You are auditing Hermes to define the minimum stable…
   03:24  user  Audit only. Do not modify code. …
```

## Usage

```
npx amnesia-cli                          scan all sessions for compaction events
npx amnesia-cli <session-id>             full receipt for one session

npx amnesia-cli restore                  recover the most recent dropped history
npx amnesia-cli restore <session-id>     recover a specific session's dropped history
npx amnesia-cli restore --all            recover every compaction in a session

npx amnesia-cli protect                  show constraints that were dropped in this project
npx amnesia-cli protect --write          write them into CLAUDE.md (marked section, safe to re-run)

npx amnesia-cli recover                  recover tool outputs persisted in this project's latest session
npx amnesia-cli recover <session-id>     recover a specific session's persisted outputs

npx amnesia-cli codex                    scan Codex CLI sessions for compaction
npx amnesia-cli codex <session-id>       compaction receipt for a Codex session

npx amnesia-cli card                     shareable receipt card for the latest compaction (HTML)
npx amnesia-cli card <session-id>        card for a specific session

npx amnesia-cli install                  wire Claude Code hooks: auto-snapshot before
                                         every compaction, announce it after
npx amnesia-cli uninstall                remove the hooks

npx amnesia-cli --json                   machine-readable output
npx amnesia-cli --root <dir>             use a different projects root
```

### restore

Dropped content is never actually gone — Claude Code keeps the full history on
disk, it just stops loading it into context. `restore` extracts the replaced
messages into a markdown file (default `.amnesia/restored-<id>.md`) and prints
one line to paste back to your agent:

```
Read `.amnesia/restored-5fdbd371-2026-10-15-14-02.md` — this is context you lost to compaction.
```

### protect

Summaries drop rules first — "audit only," "never import X," "keep them
separate." But `CLAUDE.md` survives compaction (Claude Code re-injects it after
every compact). `protect` scans your dropped prompts, finds constraint-like
sentences, and writes them into a clearly marked section of your project's
`CLAUDE.md`. Dry-run by default; `--write` applies. Re-running updates the
section in place.

### recover

When a tool output is too large, Claude Code saves the full output to disk
(`<session>/tool-results/`) and leaves only a pointer and a short preview in the
conversation:

```
<persisted-output>
Output too large (46.8KB). Full output saved to: …\tool-results\biatg8u3p.txt
Preview (first 2KB): …
```

The same happens to results later cleared by micro-compaction. `recover` finds
every pointer in a session, copies the full outputs into
`.amnesia/recovered/<session>/`, and writes a `MANIFEST.md` mapping each output
to its tool call — with a paste-line so your agent can read them again.
Outputs whose files were pruned from disk are listed as unrecoverable.

### codex

Codex CLI keeps its own session journal (`~/.codex/sessions/**/rollout-*.jsonl`)
with a different compaction model: every compaction is journaled as a
`compacted` event containing the replacement context, the pre-compaction token
usage, and a window chain (`window_number`). `amnesia codex` scans those
sessions and renders the same kind of receipt:

```
  event 1/4 2026-10-08 00:55 · window 1

   context     237,614 → 38,816 tokens (window 258,400)   (83.7% dropped)
   dead time   1m 35s
   replaced    112 messages → 9 retained
```

`amnesia codex` lists every Codex session with compaction; `amnesia codex
<session-id>` shows the per-event receipts. Synthetic injections (AGENTS.md
blocks, app messages) are excluded from drop counts.

### card

`amnesia card` writes a screenshot-ready receipt (self-contained HTML) for the
latest compaction in a session: the token drop, the freeze time, and the first
dropped prompts. Open it in a browser, screenshot it, post it — the receipt is
the point.

### install (automatic mode — recommended)

`amnesia install` wires amnesia into Claude Code's own hook system:

- **PreCompact** — before the agent forgets anything, the full session is
  archived to `.amnesia/snapshots/<session>-precompact.md`, including a
  "Constraints in this session" section. This happens even if you never
  think about it again.
- **PostCompact** — after compaction fires, a breadcrumb is emitted pointing
  at the snapshot, so you (or the agent) know where the missing context went.

Your `settings.json` is backed up before any change, only the amnesia hook
entries are touched, and `amnesia uninstall` removes them cleanly.

## How it works

Claude Code stores every session as JSONL at `~/.claude/projects/`. Compaction
events are recorded inline (`compact_boundary` system events) with token counts,
duration, and the set of messages kept verbatim. amnesia computes what was
replaced, reads the summary that took its place, and can recover the dropped
messages. Resumed sessions that start post-compaction are followed back to the
originating session file where the history lives.

Full decoded map of all five forgetting mechanisms, the boundary schema,
persisted-output format, and hook events: **[docs/MECHANISMS.md](docs/MECHANISMS.md)**.

- Also reads Codex CLI session journals (`amnesia codex`).
- Reads only your local files. Nothing leaves your machine. No network, no deps.
- Requires Node 18+.
- Verified against Claude Code 2.1.x session formats (CLI and desktop app)
  and Codex CLI rollout journals (Oct 2026).

## Roadmap

- [x] Codex CLI session support (scan + receipts)
- [ ] Gemini CLI / opencode session support
- [x] PreCompact hook: auto-archive before every compaction fires
- [x] Recovery of persisted tool outputs (oversized and cleared results)
- [x] Shareable receipt cards (`amnesia card`, HTML)
- [ ] Cost view (cache read/write tax per compaction)

## License

MIT
