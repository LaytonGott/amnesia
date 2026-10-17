// Pure string code: no Node, no $. Shared shape with SessionMessage.
export type Msg = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: readonly { tool_use_id?: string; tool: string; input: Record<string, unknown>; text?: string }[];
  toolResults?: readonly { tool_use_id?: string; text?: string }[];
  handle?: string;
};

export const MARKER = '[amnesia]';

export type Kind =
  | 'setting' | 'url' | 'hash' | 'version' | 'code' | 'path' | 'env' | 'file' | 'quoted' | 'flag' | 'dotted' | 'ident';

// what a string is decides most of its rank: a value bound to its key, a
// commit or a URL cannot be re-derived; a camelCase field name usually can
// be re-read from the code
const TIER: Record<Kind, number> = {
  setting: 5, url: 5, hash: 5, version: 4, code: 4, path: 4, env: 4, file: 3, quoted: 3, flag: 2, dotted: 2, ident: 1,
};

const PATH = /(?:[A-Za-z]:)?(?:[\\/]?[\w.@-]+[\\/])+[\w.@-]+/g;
// a slash between words ("deploy/infra") is prose, not a path
const looksLikePath = (s: string) =>
  /^(?:[A-Za-z]:|[\\/~]|\.{1,2}[\\/])/.test(s) || /\.[A-Za-z0-9]{1,8}$/.test(s);

type Item = { s: string; probe?: string[]; kind?: Kind };
type Pattern = {
  kind: Kind;
  re: RegExp;
  // only in what the person or the agent wrote, never in tool traffic
  own?: boolean;
  // kind when found in tool traffic instead (a config dump's key = value is not a decision)
  toolKind?: Kind;
  min?: number;
  item?: (m: RegExpMatchArray) => Item | null;
};

const SHAPES: [Kind, RegExp][] = [
  ['url', /^[a-z][a-z0-9+.-]*:\/\/\S+$/],
  ['hash', /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$/],
  ['hash', /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){3,}$/],
  ['version', /^v?\d+\.\d+\.\d+\S*$/],
  ['code', /^(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/],
  ['env', /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/],
  ['path', /^(?:[A-Za-z]:|[\\/~]|\.{1,2}[\\/])\S*$|^[\w.@-]+(?:[\\/][\w.@-]+)+\.[A-Za-z0-9]{1,8}$/],
];
const shapeOf = (s: string): Kind | null => SHAPES.find(([, re]) => re.test(s))?.[0] ?? null;
// a backticked span is a detail when it looks like one: a digit, a symbol, or
// mixed case; a plain lowercase word (`true`, `config`) is not
const detailish = (s: string) => /\d|[._/:@=-]|[a-z][A-Z]/.test(s) && (s.match(/\s/g)?.length ?? 0) <= 4;
// a single name with no digit (`created_at`, `itemKey`) ranks as the identifier it is
const bareName = (s: string) => /^[A-Za-z_][\w-]*$/.test(s) && !/\d/.test(s);
const KEY = String.raw`([A-Za-z_][\w.-]*[_.][\w.-]*|[A-Z][A-Z0-9_]{2,})`;
const keyOk = (k: string) => k.length >= 4 && /[A-Za-z]{2}/.test(k);
// code defaults and type hints say nothing a summary needs (= None, = bool, = 0.0)
const TRIVIAL = /^(?:none|null|nil|undefined|true|false|yes|no|bool|str|int|float|string|number|any|object|0|0\.0|1|\[\]|\{\}|""|'')$|\[/i;
const valueOk = (v: string) => /[A-Za-z0-9]/.test(v) && !TRIVIAL.test(v) && !v.startsWith('//');

const PATTERNS: Pattern[] = [
  // `key` is `value` (or a bare value with a digit or symbol: `key` is 7350)
  // in what someone wrote: the value keeps its key
  {
    kind: 'setting',
    own: true,
    re: /`([A-Za-z_][\w.-]{2,80})`\s*(?:is|was|=|:|->|→|set to|equals|has)\s*(?:`([^`\n]{1,80})`|([^\s,;()`]{1,80}))/g,
    item: (m) => {
      const k = m[1];
      const v = m[2] !== undefined ? m[2].trim() : clean(m[3] ?? '');
      if (!k || !v || !keyOk(k) || !valueOk(v)) return null;
      if (m[2] === undefined && !/\d|[._/:@-]/.test(v)) return null;
      return { s: `${k} = ${v}`, probe: [k, v] };
    },
  },
  // key: value, key = value, KEY=value, "key": "value" anywhere
  {
    kind: 'setting',
    toolKind: 'dotted',
    re: new RegExp(String.raw`(?<![\w.-])${KEY}"?\s*(?:=|:)\s*"?([^\s,;\x60'"#]{1,80})`, 'g'),
    item: (m) =>
      m[1] && m[2] && keyOk(m[1]) && valueOk(clean(m[2]))
        ? { s: `${m[1]} = ${clean(m[2])}`, probe: [m[1], clean(m[2])] }
        : null,
  },
  { kind: 'quoted', own: true, min: 3, re: /`([^`\n]{3,100})`/g, item: (m) => {
    const s = clean((m[1] ?? '').trim());
    if (s.length < 3 || !detailish(s)) return null;
    return { s, kind: shapeOf(s) ?? (bareName(s) ? 'ident' : 'quoted') };
  } },
  { kind: 'url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>"'`\]]+/g },
  { kind: 'path', re: PATH },
  { kind: 'file', re: /\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|py|rs|go|java|json|md|yml|yaml|toml|sql|sh|ps1|css|html|txt|lock|ini|env|jsonl)\b/g },
  { kind: 'dotted', re: /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g },
  { kind: 'version', re: /\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g },
  // hex runs inside a UUID (8-4-4-4-12) are ids, not commits
  { kind: 'hash', re: /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/g },
  // serials and fingerprints: 6A:3F:91:0C:5D
  { kind: 'hash', re: /(?<![\w:])[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){3,}(?![\w:])/g },
  // tickets and error codes: OPS-77412, E-LEDGER-4471
  { kind: 'code', re: /\b(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g },
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
  // substrings that must all be in the summary for it to count as kept
  probe?: string[];
  count: number;
  best: number;
  onlyRead: boolean;
  // seen in what the person or the agent wrote, not only in tool traffic
  inOwn: boolean;
  last: number;
  context: string;
};

const OWN = new Set<Source>(['user', 'assistant', 'carried']);

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

const clean = (s: string) => s.replace(/[.,:;)\]}'"`*]+$/, '');

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
      const own = OWN.has(from);
      for (const pat of PATTERNS) {
        if (pat.own && !own) continue;
        const { re } = pat;
        re.lastIndex = 0;
        for (const match of capped.matchAll(re)) {
          const it: Item | null = pat.item ? pat.item(match) : { s: clean(match[0]) };
          if (!it) continue;
          const { s, probe } = it;
          const kind = it.kind ?? (own ? undefined : pat.toolKind) ?? pat.kind;
          if (s.length < (pat.min ?? 4) || s.length > 200) continue;
          if (re === PATH && !looksLikePath(s)) continue;
          const h = hits.get(s);
          const at = `${match.index}|${s}`;
          if (h && here.has(at)) {
            if (TIER[kind] > TIER[h.kind]) h.kind = kind;
            continue;
          }
          here.add(at);
          if (!h) {
            const context = contextOf(capped, match.index ?? 0, match[0].length);
            hits.set(s, { s, kind, probe, count: 1, best: w, onlyRead: from === 'readout', inOwn: own, last: i, context });
            continue;
          }
          h.count++;
          h.last = i;
          if (TIER[kind] > TIER[h.kind]) h.kind = kind;
          if (from !== 'readout') h.onlyRead = false;
          if (own) h.inOwn = true;
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
    (h.best <= WEIGHT.output ? 3 : 0) -
    // a file path only ever passed to or printed by a tool can be found again
    (h.kind === 'path' && !h.inOwn ? 12 : 0)
  );
}

const kept = (h: Hit, summary: string) => (h.probe ?? [h.s]).every((p) => summary.includes(p));

export function specificsBlock(
  dropped: readonly Msg[],
  summary: string,
  budgetChars: number,
): { text: string; candidates: number; missing: number; included: number } | null {
  const hits = collect(dropped);
  const n = Math.max(1, dropped.length);
  const missing = [...hits.values()]
    .filter((h) => !kept(h, summary))
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
    // key = value already says what the value is; context would only spend budget
    const line = ctx && ctx !== h.s && h.kind !== 'setting' ? `- ${h.s} — "${ctx}"` : `- ${h.s}`;
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
