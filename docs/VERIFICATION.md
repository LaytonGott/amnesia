# Verifying amnesia against your own journals

amnesia parses formats amnesia doesn't own — Claude Code's session JSONL and
Codex's rollout journals. The honest way to trust a parser of someone else's
format is to check it against ground truth produced by that very tool. Two
built-in defenses help, and this document shows how to go further.

## Built-in defenses

- **Unknown-surface reporting.** Every `amnesia codex` scan and receipt counts
  journal entries whose type it doesn't recognize and prints a `note:` line.
  If an upstream release adds a new event type, you'll see it instead of
  silently missing data.
- **Golden corpus in CI.** The test suite includes a synthetic rollout
  reproducing known journal quirks (multiple windows, zero-token reports,
  synthetic injections, string-typed numbers, corrupt lines). Every release
  runs against it on Windows and Linux.

## Verify with Codex

Paste this into a Codex session (read-only; it only reads files):

```
Verify a read-only CLI that parses Codex rollout journals, then check it
against ground truth. Use Node or Python; request approval if sandboxing
blocks file access.

1. Run: node <PATH-TO-AMNESIA>/bin/amnesia.mjs codex
   Paste the output verbatim.

2. Run the receipt for a session shown with compaction:
   node <PATH-TO-AMNESIA>/bin/amnesia.mjs codex <SESSION-ID>
   Paste the output verbatim.

3. Independently parse the rollout JSONL for that session
   (C:\Users\<you>\.codex\sessions\<...>\rollout-*-<full-session-id>.jsonl).
   For each line with "type":"compacted", extract:
   - window_number
   - latest_token_usage_record.usage.input_tokens (tool's "pre")
   - length of replacement_history (tool's "retained")
   - the first token_count event after the line with positive
     info.last_token_usage.input_tokens (tool's "post"; the tool skips zero
     reports — confirm that's justified for the first one)
   - started_at_ms / completed_at_ms of the following ContextCompaction
     item_completed (tool's "dead time")
   - count of response_item entries with payload.type == "message" before the
     line (tool's "N messages" in "replaced")
   - count of tool-output response_items before the line
     (tool's "N tool outputs")
   Compare each value with the tool's output in a table:
   field | tool said | file says | match?

4. Negative check: run the receipt for a session without compaction and
   confirm "no compaction events found".

Report every mismatch side by side, or confirm all matched. Also report any
"note: unrecognized journal entries" lines the tool printed.
```

## Verify with Claude Code

```
Verify a read-only CLI that summarizes compaction events from Claude Code
session files, then check it against ground truth.

1. Run: node <PATH-TO-AMNESIA>/bin/amnesia.mjs <SESSION-ID>
   Paste the output verbatim.

2. Independently parse the session file
   (C:\Users\<you>\.claude\projects\<encoded-cwd>\<session-id>.jsonl).
   For each line with "subtype":"compact_boundary", extract from
   compactMetadata: preTokens, postTokens, durationMs, and
   preservedMessages.uuids length. Count "user" lines before the boundary
   that are not tool results and not isCompactSummary (the tool's "prompts").
   Compare with the tool's receipt:
   field | tool said | file says | match?

3. Report mismatches side by side, or confirm all matched.
```

## What "matched" means

- Token counts must match exactly (they are recorded, not estimated).
- Dead time may differ by rounding (±0.5s display).
- Message counts follow documented conventions: tool outputs are counted
  separately from messages; synthetic injections (AGENTS.md headers, app
  messages, environment context) are excluded from "human prompts dropped".
- `"post"` tokens are the first *positive* usage report after the boundary —
  zero reports are skipped on purpose (verify against the file).

## What it doesn't prove

- It doesn't prove Claude Code or Codex behave as documented — only that
  amnesia reads their output correctly.
- It doesn't prove injected instructions survive compaction — that's a
  question for the agents themselves.
- One session verified is one session; run it again when the agent updates.

If you find a mismatch, please open an issue with both outputs verbatim:
https://github.com/LaytonGott/amnesia/issues
