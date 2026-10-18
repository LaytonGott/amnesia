# amnesia plugin

A Claude Code hooks-module plugin that wraps compaction instead of replacing
it. It lets Claude Code write its normal summary, then appends one message
right after it with the exact details that summary dropped: settings, paths,
URLs, hashes, versions, tickets, env vars and @handles, each with the words
that say what it belongs to.

It also archives every tool output as it happens, and every message a
compaction replaces, with secrets redacted, under
`~/.claude/amnesia/archive/<session id>/`. It gives the agent a tool,
`mcp__amnesia__recall`, that searches that archive word for word. Turn it
off with the `recall` setting.

## Install

In Claude Code (one-step install needs 2.1.275 or later; verified on
2.1.299+):

```
/plugin install amnesia --marketplace LaytonGott/amnesia
```

- **From a shell:** `claude plugin install amnesia --marketplace LaytonGott/amnesia`.
- **In the desktop app:** click + next to the prompt box, then Plugins, Add
  marketplace with `LaytonGott/amnesia`, then add the plugin.

## Limits

- **Org-managed installs:** where an organization manages Claude Code, the
  `session.compact` hook runs only in plugins the organization lists in
  managed settings.
- **Skipped compactions:** a `precompute` dispatch gets no block (its result
  is kept for the next compaction), only the steering list when `steer` is
  on; subagent compactions pass through untouched.
- **Budget:** the block is capped at 12,000 chars by default (about 3k
  tokens of context after each compaction). Change it with the
  `budgetChars` setting (1,000–40,000): `claude plugin configure amnesia`.
- **Recall:**
  - The archive is kept per session id, so a forked session starts an
    empty one.
  - A search reads the newest 3,000 archive files.
  - Archives are not pruned yet.
  - Headless runs need the tool allowed (`--allowedTools
    mcp__amnesia__recall`); `--tools ""` removes plugin tools too.

Measurements, design and platform facts:
[docs/DESIGN-compact-hook.md](../docs/DESIGN-compact-hook.md) and
[docs/EFFICACY.md](../docs/EFFICACY.md).

## Develop

Run it in one session without installing:

```bash
claude --plugin-dir ./plugin
```

Check it:

```bash
npm run test:plugin
```

That runs `claude plugin validate plugin` and `claude plugin test plugin`;
`npm test` runs only the CLI's tests.

Offline benches (Node 22.18+ or 24, no model calls):

```bash
node bench/specifics-real.mts ~/.claude/projects/<project>/<session>.jsonl
node bench/audit-specifics.mts
node bench/replay-ab.mts bench/results/ab-100 runs-v8stress.json
```

- `specifics-real.mts`: timings, plus the block for the newest compaction in
  one session.
- `audit-specifics.mts`: scores the block on every real compaction on your
  machine.
- `replay-ab.mts`: replays a behavioral A/B run's compactions with the
  current extractor.
