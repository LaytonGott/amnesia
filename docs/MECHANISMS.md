# How Claude Code forgets — decoded

amnesia exists because Claude Code forgets in ways it doesn't tell you. This
document publishes what we learned by statically analyzing the shipped CLI
(v2.1.169) and cross-checking every claim against real session transcripts on
disk. It describes observed behavior and file formats; no proprietary source
code or prompt text is reproduced.

## The five mechanisms

| # | Mechanism | Trigger | What it removes | Recorded as |
|---|-----------|---------|-----------------|-------------|
| 1 | **Auto-compact** | Context near a threshold (default window configurable, 100k–1M tokens) | Everything before the boundary, replaced by an LLM summary | `compact_boundary` (`trigger: "auto"`) |
| 2 | **Manual / partial compact** | `/compact`, or "summarize from here" with focus text | Same, but you asked for it | `compact_boundary` (`trigger: "manual"`, optional `userContext`) |
| 3 | **Reactive compact** | A request hits prompt-too-long mid-turn | Re-summarizes with fewer message groups; steps down until it fits; can strip media | `compact_boundary` (`trigger: "auto"`) |
| 4 | **Precomputed compact** | Summary generated *in the background* at the auto threshold, swapped in when needed | Same as auto, but the wait is hidden — you only pay the swap | `compact_boundary` (`precomputed: true`) |
| 5 | **Micro-compact** | Time-based, no LLM call | Old **tool results** only, replaced with `[Old tool result content cleared]`; content persisted to disk first | `microcompact_boundary` + persisted file |

Related, not a compaction: **oversized tool output persistence.** When a single
tool result is too large, the full output is saved to disk and the conversation
keeps only a pointer plus a preview (see below). The model never sees the full
output; you still can.

## The on-disk record

Everything above is written into your local session transcript
(`~/.claude/projects/<encoded-cwd>/<session>.jsonl`). A boundary looks like this
(real fields, from live transcripts):

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "compactMetadata": {
    "trigger": "auto",
    "preTokens": 998312,
    "postTokens": 31348,
    "durationMs": 115613,
    "preservedSegment": {
      "headUuid": "…", "anchorUuid": "…", "tailUuid": "…"
    },
    "preservedMessages": { "anchorUuid": "…", "uuids": ["…"] },
    "cumulativeDroppedTokens": 966964
  },
  "timestamp": "2026-08-18T20:23:48.207Z"
}
```

- `preTokens → postTokens` is exactly how much was in context before, and how
  little remained after.
- `durationMs` is how long you waited while it happened. Precomputed
  compactions (background-built summaries) show swap time only — often a few
  milliseconds.
- `preservedMessages.uuids` is the exact set of messages kept **verbatim**
  through that compaction — the rest of the context it covered was replaced by
  the summary. (The file keeps everything; this list tells you what survived
  *in context*. In multi-compaction sessions, what a given compaction actually
  replaced is the previous retained set plus the messages since the previous
  boundary, minus what it preserved.)
- `cumulativeDroppedTokens` accumulates across a session (present in newer
  builds; older sessions may omit it).

Immediately after the boundary comes a synthetic user message marked
`isCompactSummary: true` containing the summary — that is what the model
continues with. The full pre-compaction history stays in the file; it just
stops being loaded into context.

## What the summary is asked to keep

The summarization prompt is a structured spec. It requires a private
`<analysis>` pass, then a `<summary>` with nine sections — in order:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages (with a verbatim-preservation requirement for
   security-relevant constraints)
7. Pending Tasks
8. Work Completed / Current Work
9. Context for Continuing Work / Optional Next Step

A post-processor strips the analysis and reduces the summary block. A second
prompt variant exists for *partial* compacts ("summarize the recent portion
only"). Custom `/compact` instructions are appended as an "Additional
Instructions" section.

## What the next context contains

After compaction the model resumes with a continuation message. Its header
sentence is public — it appears in every compacted transcript:

> This session is being continued from a previous conversation that ran out of context.

The continuation also conditionally includes: the path of the full transcript
(so the model can re-read what it lost), a note that recent messages were kept
verbatim, a warning if REPL VM state was cleared, and a resume-directly
instruction. The path pointer is why `amnesia restore` exists — the information
is always one file-read away; amnesia makes that read unnecessary.

## Micro-compact (the silent one)

Micro-compact needs no summarization call. On a time-based trigger it:

- targets old tool results (file reads, command output) rather than messages,
- **persists the content to disk first**, then replaces it in context with the
  literal placeholder `[Old tool result content cleared]`,
- writes a `microcompact_boundary` system event,
- is governed by a keep-recent setting (internally `compact_micro_keep_recent`).

Because the content is persisted before clearing, micro-compact is usually
*recoverable* — that is what `amnesia recover` is for. In our test corpus this
mechanism never fired (older sessions predate it or never idled long enough),
so its on-disk footprint here comes from the shipped code, not observed data.

## The persisted-output format

Oversized results are saved under the session directory:

```
~/.claude/projects/<encoded-cwd>/<session-uuid>/tool-results/<name>.txt
```

and replaced in the conversation with a wrapper like:

```
<persisted-output>
Output too large (46.8KB). Full output saved to: …\tool-results\biatg8u3p.txt
Preview (first 2KB): …
</persisted-output>
```

`amnesia recover` parses these pointers, restores the full outputs, and writes a
manifest. Note: Claude Code prunes old `tool-results/` directories over time —
recent sessions recover fully, old ones are honestly reported as missing.

## Hooks: the official interception points

Claude Code exposes `PreCompact` and `PostCompact` hook events — the clean way
to act on forgetting without patching anything:

- **PreCompact** receives `{ trigger: "manual" | "auto", custom_instructions }`
  and can *block* the compaction. `amnesia install` uses it to snapshot the
  session before anything is dropped.
- **PostCompact** receives `{ trigger, compact_summary }` — it sees the summary
  itself. `amnesia install` uses it to announce the snapshot afterwards.

## How amnesia maps to all of this

| Mechanism | Observable | amnesia |
|-----------|------------|---------|
| Auto / manual / reactive / precomputed | `compact_boundary` | `amnesia` scan + receipt; `restore` recovers the dropped messages |
| Summary spec | `isCompactSummary` message | Receipt shows what the agent now believes; `restore` diffs it against what was dropped |
| Micro-compact | `microcompact_boundary`, cleared placeholders | `recover` restores persisted content; receipt reports unrecoverable clears |
| Oversized outputs | `<persisted-output>` wrapper | `recover` restores the full files + manifest |
| Rules dropped by any of the above | constraint-like sentences among dropped prompts | `protect` writes them into `CLAUDE.md`, which survives compaction |
| Future compactions | `PreCompact` / `PostCompact` hooks | `install` snapshots before and announces after, automatically |

## Verification and limitations

- Verified against **Claude Code 2.1.169** (June 2026) by static analysis of the
  shipped CLI, cross-checked against real transcripts (token counts, boundary
  fields, persisted-output wrappers, folder layout).
- These formats are internal to Claude Code and change between releases.
  Re-verify before acting on version-specific numbers.
- We describe mechanisms and schemas only. Prompt *text* is summarized, never
  reproduced.
- Micro-compact's observed behavior is code-derived; the remaining mechanisms
  were all observed in live transcripts.
