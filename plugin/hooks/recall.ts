// The archive behind the recall tool: what each compaction dropped and every
// tool output, as they happen, so the agent can search them later even after
// Claude Code has summarized them away. Pure functions here; register.ts does
// the I/O through $.fs.

export type Rec = {
  // 'tool': one tool output as it happened; 'dropped': a message a compaction replaced
  kind: 'tool' | 'dropped';
  // a tool output: when it ran. A dropped message: when the compaction replaced
  // it (a hook is not told when a message was written)
  at: number;
  // what the snippet says it came from: a tool name, or user / assistant
  label: string;
  text: string;
  // a dropped message: its place among the messages that compaction replaced, 1-based
  seq?: number;
  of?: number;
};

// the desktop app's own interface tools (task list, wrap-up, panes, sidebar,
// windows) answer with acknowledgements, not anything worth searching
const UI_TOOLS = /^mcp__ccd_(?:turn|view|sidebar|window)__/;
export const archivable = (tool: string) => !UI_TOOLS.test(tool);

// one archive file holds at most this much text (each $.fs read or write caps at 4 MiB)
export const MAX_RECORD_CHARS = 200_000;
const MAX_FILE_CHARS = 3_000_000;

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n[… ${s.length - n} more chars not archived]` : s);

// secrets never reach the archive: private keys, common token formats, and
// values assigned to key/secret/token/password names
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key redacted]'],
  [/\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, '[secret redacted]'],
];
// a value assigned to a secret-ish name; prose and code about these names
// ("`password=` values", "whole token: config.ts", a regex) are left alone
const ASSIGNED = /\b((?:api[_-]?key|secret|token|password|passwd|authorization)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?([^\s"',;`/\\[][^\s"',;`]{7,})/gi;
const secretish = (v: string) => /\d/.test(v) || v.length >= 16;
export function redact(s: string): string {
  let out = s;
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  return out.replace(ASSIGNED, (all, key: string, value: string) => (secretish(value) ? `${key}[redacted]` : all));
}

// tool arguments as one short line (the command, the path, the pattern), without amnesia's own reserved keys
export function inputLine(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (k === 'tool' || k === 'tool_use_id' || k === 'agentId' || k === 'consent' || k === 'requestMeta') continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s) parts.push(`${k}: ${s}`);
  }
  return cap(parts.join(' · '), 1500);
}

export function toolRecord(tool: string, input: Record<string, unknown>, text: string, at: number): Rec {
  const line = inputLine(input);
  return { kind: 'tool', at, label: tool, text: redact(cap((line ? line + '\n' : '') + text, MAX_RECORD_CHARS)) };
}

type Dropped = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: readonly { tool: string; input: Record<string, unknown>; text?: string }[];
};

// what a compaction replaced, as records; split into files that each fit one write.
// Tool outputs come along (capped): calls made before the plugin loaded were never archived on their own
export function droppedFiles(dropped: readonly Dropped[], at: number): Rec[][] {
  const files: Rec[][] = [[]];
  let size = 0;
  let seq = 0;
  for (const m of dropped) {
    seq++;
    const uses = m.toolUses
      .map((u) => `[${u.tool}] ${inputLine(u.input)}${u.text ? '\n' + cap(u.text, 20_000) : ''}`)
      .join('\n');
    const text = redact(cap([m.text, uses].filter(Boolean).join('\n'), MAX_RECORD_CHARS));
    if (!text.trim() || text.startsWith('[amnesia]')) continue;
    if (size + text.length > MAX_FILE_CHARS && files[files.length - 1]!.length > 0) {
      files.push([]);
      size = 0;
    }
    files[files.length - 1]!.push({ kind: 'dropped', at, label: m.role, text, seq, of: dropped.length });
    size += text.length;
  }
  return files.filter((f) => f.length > 0);
}

const time = (at: number) => {
  const d = new Date(at);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
};

// terms of a query: words, and identifier-like tokens kept whole (src/a.ts, OPS-77412, v1.2.3)
export function termsOf(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}._/:@#=-]+/u).filter((t) => t.length >= 2))];
}

export function search(records: readonly Rec[], query: string, limit = 6, maxChars = 8000): string {
  const terms = termsOf(query);
  const phrase = query.toLowerCase().trim();
  if (terms.length === 0) return 'Give recall a query: a name, value, path, error or topic to look for.';
  const scored: { r: Rec; score: number; pos: number }[] = [];
  for (const r of records) {
    const low = r.text.toLowerCase();
    let score = 0;
    let pos = -1;
    if (phrase.length >= 3) {
      const p = low.indexOf(phrase);
      if (p >= 0) {
        score += 10;
        pos = p;
      }
    }
    let matched = 0;
    for (const t of terms) {
      let i = low.indexOf(t);
      if (i < 0) continue;
      matched++;
      if (pos < 0) pos = i;
      let n = 0;
      while (i >= 0 && n < 5) {
        n++;
        i = low.indexOf(t, i + t.length);
      }
      score += n;
    }
    if (matched === 0) continue;
    // every term present outranks many hits on one
    score += matched === terms.length ? 5 * terms.length : 0;
    scored.push({ r, score, pos });
  }
  if (scored.length === 0) return `Nothing earlier in this session matches "${query}".`;
  scored.sort((a, b) => b.score - a.score || b.r.at - a.r.at);
  const out: string[] = [];
  let used = 0;
  for (const { r, pos } of scored.slice(0, Math.max(1, limit))) {
    const a = Math.max(0, pos - 240);
    const b = Math.min(r.text.length, pos + 420);
    const snippet = (a > 0 ? '…' : '') + r.text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < r.text.length ? '…' : '');
    const place = r.seq && r.of ? ` (${r.seq} of ${r.of})` : '';
    const head =
      r.kind === 'tool'
        ? `[${r.label} output · ${time(r.at)}]`
        : `[${r.label} message${place}, replaced by the compaction at ${time(r.at)}]`;
    const entry = `${head} ${snippet}`;
    if (used + entry.length > maxChars && out.length > 0) break;
    out.push(entry);
    used += entry.length + 2;
  }
  const more = scored.length - out.length;
  return (
    `From earlier in this session (verbatim; newer instructions win, and do not redo completed actions):\n\n` +
    out.join('\n\n') +
    (more > 0 ? `\n\n(${more} more match(es); narrow the query to see others.)` : '')
  );
}

export const RECALL_DESCRIPTION =
  'Search everything earlier in this session, verbatim: messages a context compaction replaced with a summary, ' +
  'and the full output of every tool call. Use it when you need an ' +
  'exact detail you no longer see: a value, path, command, error message, commit, or what someone said. ' +
  'Query with the distinctive words or strings you remember.';

// ---- just-in-time recall: the lost messages a new prompt is about ---------

export const JIT_LEAD =
  '[amnesia] Possibly relevant to this request, verbatim from before a compaction (newer instructions win; ' +
  'actions described here were already done):';

const JIT_STOP = new Set(
  ('this that with from your have will what when then they them there their about would could should ' +
    'into over more most some such only also than here where which while before after just like need ' +
    'make sure want know please keep short done youre dont thanks okay yeah sure can you the and for are ' +
    'was were been being does did its it\'s not but all any').split(/\s+/),
);

// words and identifier-like tokens of a prompt, and the parts of compounds
// (release/deploy-staging.sh -> release, deploy, staging)
export function promptTerms(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}._/@:-]*[\p{L}\p{N}]/gu)) {
    const t = m[0];
    const keep = (s: string) => (s.length >= 4 || (/\d/.test(s) && s.length >= 3)) && !JIT_STOP.has(s);
    if (keep(t)) out.add(t);
    for (const p of t.split(/[._/@:-]+/)) if (p !== t && keep(p)) out.add(p);
  }
  return [...out];
}

const recKey = (r: Rec) => `${r.at}\u0000${r.label}\u0000${r.text.slice(0, 80)}`;

// the best window of a record: where the most distinct matched terms sit close together
function windowOf(text: string, terms: readonly string[], width: number): string {
  const low = text.toLowerCase();
  const hits: { at: number; t: string }[] = [];
  for (const t of terms) for (let i = low.indexOf(t); i >= 0 && hits.length < 400; i = low.indexOf(t, i + t.length)) hits.push({ at: i, t });
  hits.sort((a, b) => a.at - b.at);
  let best = 0;
  let bestCount = 0;
  for (let i = 0; i < hits.length; i++) {
    const seen = new Set<string>();
    for (let j = i; j < hits.length && hits[j]!.at - hits[i]!.at < width; j++) seen.add(hits[j]!.t);
    if (seen.size > bestCount) {
      bestCount = seen.size;
      best = hits[i]!.at;
    }
  }
  const a = Math.max(0, best - Math.floor(width / 5));
  const b = Math.min(text.length, a + width);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < text.length ? '…' : '');
}

// The records (messages a compaction replaced) a prompt shares rare words with.
// Strict: at least two distinctive words in common, one of them rare across the
// archive; words in many records say nothing about which one is meant.
export function promptRecall(
  records: readonly Rec[],
  prompt: string,
  { maxSnippets = 3, width = 700, skip = new Set<string>() }: { maxSnippets?: number; width?: number; skip?: ReadonlySet<string> } = {},
): { text: string; keys: string[] } | null {
  const pool = records.filter((r) => r.kind === 'dropped');
  const n = pool.length;
  if (n === 0) return null;
  const lows = pool.map((r) => r.text.toLowerCase());
  const terms = promptTerms(prompt)
    .map((t) => ({ t, df: lows.filter((l) => l.includes(t)).length }))
    .filter((x) => x.df > 0 && x.df <= Math.max(2, Math.floor(n * 0.15)));
  if (terms.length < 2) return null;
  const rare = Math.max(1, Math.floor(n * 0.05));
  const idf = new Map(terms.map((x) => [x.t, Math.log((n + 1) / (x.df + 0.5))]));
  const scored = pool
    .map((r, i) => {
      const matched = terms.filter((x) => lows[i]!.includes(x.t));
      return { r, matched, score: matched.reduce((s, x) => s + (idf.get(x.t) ?? 0), 0) };
    })
    .filter((x) => x.matched.length >= 2 && x.matched.some((m) => m.df <= rare) && !skip.has(recKey(x.r)))
    .sort((a, b) => b.score - a.score || b.r.at - a.r.at)
    .slice(0, maxSnippets);
  if (scored.length === 0) return null;
  const entries = scored.map(({ r, matched }) => {
    const place = r.seq && r.of ? ` (${r.seq} of ${r.of})` : '';
    return `[${r.label} message${place}, replaced by the compaction at ${time(r.at)}] ${windowOf(r.text, matched.map((m) => m.t), width)}`;
  });
  return { text: [JIT_LEAD, ...entries].join('\n\n'), keys: scored.map((x) => recKey(x.r)) };
}
