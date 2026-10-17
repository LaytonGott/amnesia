// Pure string code: no Node, no $. Shared shape with SessionMessage.
export type Msg = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: readonly { tool_use_id?: string; tool: string; input: Record<string, unknown>; text?: string }[];
  toolResults?: readonly { tool_use_id?: string; text?: string }[];
  handle?: string;
};

export const MARKER = '[amnesia]';

export type Kind = 'url' | 'hash' | 'version' | 'path' | 'env' | 'file' | 'flag' | 'dotted' | 'ident';

// what a string is decides most of its rank: a commit or a URL cannot be
// re-derived, a camelCase field name usually can be re-read from the code
const TIER: Record<Kind, number> = {
  url: 5, hash: 5, version: 4, path: 4, env: 4, file: 3, flag: 2, dotted: 2, ident: 1,
};

const PATH = /(?:[A-Za-z]:)?(?:[\\/]?[\w.@-]+[\\/])+[\w.@-]+/g;
// a slash between words ("deploy/infra") is prose, not a path
const looksLikePath = (s: string) =>
  /^(?:[A-Za-z]:|[\\/~]|\.{1,2}[\\/])/.test(s) || /\.[A-Za-z0-9]{1,8}$/.test(s);

const PATTERNS: { kind: Kind; re: RegExp }[] = [
  { kind: 'url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>"'`\]]+/g },
  { kind: 'path', re: PATH },
  { kind: 'file', re: /\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|py|rs|go|java|json|md|yml|yaml|toml|sql|sh|ps1|css|html|txt|lock|ini|env|jsonl)\b/g },
  { kind: 'dotted', re: /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g },
  { kind: 'version', re: /\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g },
  // hex runs inside a UUID (8-4-4-4-12) are ids, not commits
  { kind: 'hash', re: /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/g },
  { kind: 'flag', re: /(?<![\w-])--[a-z][\w-]{2,}/g },
  { kind: 'env', re: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g },
  { kind: 'ident', re: /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g },
  { kind: 'ident', re: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g },
  { kind: 'ident', re: /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g },
];

// where a string was seen: the person's own words first, tool traffic last,
// and output of tools that only read files lowest (it can be read again)
type Source = 'user' | 'assistant' | 'carried' | 'input' | 'summary' | 'output' | 'meta' | 'readout';
const WEIGHT: Record<Source, number> = {
  user: 4, assistant: 3, carried: 3, input: 2, summary: 2, output: 1, meta: 1, readout: 0,
};
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'LS']);

// rows a hook sees as role 'user' that the person did not type
const PRIOR_SUMMARY = /^This session is being continued from a previous conversation/;
const HARNESS = /^\s*(?:<[a-z][\w-]*[\s>]|Base directory for this skill)/;

type Hit = {
  s: string;
  kind: Kind;
  count: number;
  best: number;
  onlyRead: boolean;
  last: number;
  context: string;
};

function sources(m: Msg, answered: Set<string>): { text: string; from: Source }[] {
  if (m.text.startsWith(MARKER)) {
    // an earlier block: carry its items forward; they rank as old, so newer details win the budget
    const items = [...m.text.matchAll(/^- (.+?)(?: — ".*")?$/gm)].map((x) => x[1] ?? '');
    return [{ text: items.join('\n'), from: 'carried' }];
  }
  const own: Source =
    m.role === 'assistant' ? 'assistant'
    : PRIOR_SUMMARY.test(m.text) ? 'summary'
    : HARNESS.test(m.text) ? 'meta'
    : 'user';
  const out: { text: string; from: Source }[] = [{ text: m.text, from: own }];
  for (const u of m.toolUses) {
    for (const v of Object.values(u.input ?? {})) {
      if (typeof v === 'string') out.push({ text: v, from: 'input' });
    }
    if (u.text) {
      out.push({ text: u.text, from: READ_TOOLS.has(u.tool) ? 'readout' : 'output' });
      if (u.tool_use_id) answered.add(u.tool_use_id);
    }
  }
  // a tool_result mirrors its tool use's text: count it once
  for (const r of m.toolResults ?? []) {
    if (r.text && !(r.tool_use_id && answered.has(r.tool_use_id))) out.push({ text: r.text, from: 'output' });
  }
  return out;
}

function contextOf(text: string, at: number, len: number): string {
  const a = Math.max(0, at - 35);
  const b = Math.min(text.length, at + len + 35);
  return text.slice(a, b).replace(/\s+/g, ' ').trim();
}

const clean = (s: string) => s.replace(/[.,:;)\]}'"`]+$/, '');

export function collect(dropped: readonly Msg[]): Map<string, Hit> {
  const hits = new Map<string, Hit>();
  const answered = new Set<string>();
  dropped.forEach((m, i) => {
    for (const { text, from } of sources(m, answered)) {
      if (!text) continue;
      const w = WEIGHT[from];
      const capped = text.length > 200_000 ? text.slice(-200_000) : text;
      // one occurrence matched by two patterns (report_9.txt: file and dotted) counts once
      const here = new Set<string>();
      for (const { kind, re } of PATTERNS) {
        re.lastIndex = 0;
        for (const match of capped.matchAll(re)) {
          const s = clean(match[0]);
          if (s.length < 4 || s.length > 200) continue;
          if (re === PATH && !looksLikePath(s)) continue;
          const h = hits.get(s);
          const at = `${match.index}|${s}`;
          if (h && here.has(at)) {
            if (TIER[kind] > TIER[h.kind]) h.kind = kind;
            continue;
          }
          here.add(at);
          if (!h) {
            const context = contextOf(capped, match.index ?? 0, s.length);
            hits.set(s, { s, kind, count: 1, best: w, onlyRead: from === 'readout', last: i, context });
            continue;
          }
          h.count++;
          h.last = i;
          if (TIER[kind] > TIER[h.kind]) h.kind = kind;
          if (from !== 'readout') h.onlyRead = false;
          // keep the context from the best source seen: the person's sentence beats a file dump
          if (w >= h.best) {
            h.best = w;
            h.context = contextOf(capped, match.index ?? 0, s.length);
          }
        }
      }
    }
  });
  return hits;
}

export function scoreOf(h: Hit, n: number): number {
  return (
    4 * h.best +
    2 * TIER[h.kind] +
    Math.log2(1 + h.count) +
    (3 * h.last) / n -
    (h.onlyRead ? 8 : 0) -
    (h.best <= WEIGHT.output ? 3 : 0)
  );
}

export function specificsBlock(
  dropped: readonly Msg[],
  summary: string,
  budgetChars: number,
): { text: string; candidates: number; missing: number; included: number } | null {
  const hits = collect(dropped);
  const n = Math.max(1, dropped.length);
  const missing = [...hits.values()]
    .filter((h) => !summary.includes(h.s))
    // a single mention in tool traffic is usually noise
    .filter((h) => !(h.best <= WEIGHT.output && h.count < 2))
    .map((h) => ({ ...h, score: scoreOf(h, n) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 500);
  // a string inside a longer one that ranks at least as high (config.ts in src/runtime/config.ts) adds nothing
  const top = missing.filter(
    (h) => !missing.some((o) => o.score >= h.score && o.s.length > h.s.length && o.s.includes(h.s)),
  );

  const head =
    `${MARKER} Exact details the summary above dropped, verbatim from the replaced history. ` +
    'For reference only: newer instructions win, and do not redo actions that were already completed.';
  const lines: string[] = [];
  const chosen: string[] = [];
  let used = head.length;
  for (const h of top) {
    if (chosen.some((c) => c.includes(h.s))) continue;
    const ctx = h.context.length > 60 ? h.context.slice(0, 57) + '...' : h.context;
    const line = ctx && ctx !== h.s ? `- ${h.s} — "${ctx}"` : `- ${h.s}`;
    if (used + line.length + 1 > budgetChars) continue;
    lines.push(line);
    chosen.push(h.s);
    used += line.length + 1;
  }
  if (lines.length === 0) return null;
  return {
    text: [head, ...lines].join('\n'),
    candidates: hits.size,
    missing: missing.length,
    included: lines.length,
  };
}
