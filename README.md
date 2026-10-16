# amnesia

**Your AI coding agent forgets. Get it back.**

When a Claude Code session runs long, the agent quietly replaces your history
with a summary — hundreds of messages, hundreds of thousands of tokens, gone
from context. No notice, no receipt. amnesia gives you all three:

1. **The receipt** — see exactly what was forgotten, when, and what it cost you
2. **`restore`** — recover the dropped messages into a readable file your agent can re-read
3. **`protect`** — move your dropped rules into `CLAUDE.md` so they survive every future compaction

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

## How it works

Claude Code stores every session as JSONL at `~/.claude/projects/`. Compaction
events are recorded inline (`compact_boundary` system events) with token counts,
duration, and the set of messages kept verbatim. amnesia computes what was
replaced, reads the summary that took its place, and can recover the dropped
messages. Resumed sessions that start post-compaction are followed back to the
originating session file where the history lives.

- Reads only your local files. Nothing leaves your machine. No network, no deps.
- Requires Node 18+.
- Verified against Claude Code 2.1.x session formats.

## Roadmap

- [ ] Codex CLI / Gemini CLI / opencode session support
- [ ] PreCompact hook: auto-archive before every compaction fires
- [ ] Recovery of tool output cleared by micro-compaction
- [ ] Shareable receipt cards
- [ ] Cost view (cache read/write tax per compaction)

## License

MIT
