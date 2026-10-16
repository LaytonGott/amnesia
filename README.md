# amnesia

**Your AI coding agent forgets. See exactly what.**

When a Claude Code session runs long, the agent quietly replaces your history
with a summary — hundreds of messages, hundreds of thousands of tokens, gone
from context. No notice, no receipt. `amnesia` reads your local session files
and prints the receipt.

```
  amnesia · compaction receipt for claude-code
  my-project/5fdbd371
  ────────────────────────────────────────────────────────────────
  event 1/1 2026-08-18 20:23 · trigger auto

   context     998,312 → 31,348 tokens   (96.9% dropped)
   dead time   1m 56s
   replaced    ~312 messages (268 prompts, 44 replies, 190 tool batches)
   preserved   47 message(s) kept verbatim
   cumulative  1,234,567 tokens forgotten this session

   what your agent now believes:
   │ This session is being continued from a previous conversation…

   what it dropped (oldest first):
   14:02  user  fix the parser bug in webhook.rs that…
   14:07  user  no wait — use the other approach, the…
   … 261 more prompts not shown
```

## Usage

```
npx amnesia-cli                     scan all sessions for compaction events
npx amnesia-cli <session-id>        full receipt for one session
npx amnesia-cli <path.jsonl>        receipt for a specific file
npx amnesia-cli --json              machine-readable output
```

## How it works

Claude Code stores every session as JSONL at `~/.claude/projects/`. Compaction
events are recorded inline (`compact_boundary` system events) with token counts,
duration, and the set of messages kept verbatim. `amnesia` computes what was
replaced, reads the summary that took its place, and shows the dropped messages.

- Reads only your local files. Nothing leaves your machine. No network, no deps.
- Requires Node 18+.
- Verified against Claude Code 2.1.x session formats.

## Roadmap

- [ ] Codex CLI / Gemini CLI / opencode session support
- [ ] Recovery of tool output cleared by micro-compaction
- [ ] Shareable receipt cards
- [ ] Cost view (cache read/write tax per compaction)

## License

MIT
