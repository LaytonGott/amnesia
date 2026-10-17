# amnesia plugin (experimental)

A Claude Code hooks-module plugin that wraps compaction instead of replacing
it: it lets Claude Code write its normal summary, then appends one message
right after it listing the exact strings the summary dropped (paths, commit
hashes, versions, env vars, identifiers), each with a few words of context.

Design, platform facts, and what the prototype verified:
[docs/DESIGN-compact-hook.md](../docs/DESIGN-compact-hook.md).

## Status

Prototype. Verified on Claude Code 2.1.302 with two real `/compact` runs and
the plugin test kit. Not published to a marketplace yet. Known weak spot:
ranking. On large real sessions, code field names crowd out commits and
paths (see the design doc).

Limits:

- Needs a Claude Code build with hooks modules and the `session.compact`
  event. Both are in 2.1.299+; the first version that has them is unknown.
- Does not run where an organization manages Claude Code, unless the
  organization lists the plugin in managed settings.
- Skips `precompute` dispatches and subagent compactions.

## Try it in one session (installs nothing)

```bash
claude --plugin-dir ./plugin
```

## Check it

```bash
npm run test:plugin
```

That runs `claude plugin validate plugin` and `claude plugin test plugin`.
`npm test` runs only the CLI's tests.

To see what it would add on your own history (Node 22.18+ or 24), run this.
It prints timings and the block for the newest compaction in that session:

```bash
node bench/specifics-real.mts ~/.claude/projects/<project>/<session>.jsonl
```
