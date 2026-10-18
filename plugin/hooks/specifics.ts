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
  | 'setting' | 'url' | 'hash' | 'version' | 'code' | 'handle' | 'path' | 'env' | 'branch' | 'file' | 'quoted' | 'flag' | 'dotted' | 'ident';

// what a string is decides most of its rank: a value bound to its key, a
// commit or a URL cannot be re-derived; a camelCase field name usually can
// be re-read from the code
const TIER: Record<Kind, number> = {
  setting: 5, url: 5, hash: 5, version: 4, code: 4, handle: 4, path: 4, env: 4, branch: 3, file: 3, quoted: 3, flag: 2, dotted: 2, ident: 1,
};
// "For acme-billing, the staging port is 29860" -> owner "For acme-billing"
const OWNER = /^((?:For|In|On|At) [^,;:]{2,50}),\s+(.+)$/;
const PRONOUN =/^(?:it|this|that|there|these|those|which|what|who|he|she|they|we|i|you|here|one|each|all|both|total|count|number)$/i;

// never from inside a word: github:owner/repo has no drive b:
const PATH = /(?<![\w.@-])(?:[A-Za-z]:)?(?:[\\/]?[\w.@-]+[\\/])+[\w.@-]+/g;
// a slash between words ("deploy/infra") is prose, not a path
const looksLikePath = (s: string) =>
  /^(?:[A-Za-z]:|[\\/~]|\.{1,2}[\\/])/.test(s) || /\.[A-Za-z0-9]{1,8}$/.test(s);

type Item = { s: string; probe?: string[]; kind?: Kind };
type Pattern = {
  kind: Kind;
  re: RegExp;
  // only in what the person or the agent wrote, never in tool traffic
  own?: boolean;
  // sources it is never read from
  not?: readonly Source[];
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
// code and shell, not values: GENERIC = new ..., NODE = $1, DIST = $(cd ...)
const CODE_VALUE = /^(?:new|await|this|self|return|function|class|const|let|var|import|from|require|async|typeof|lambda|def)$|^\\?[$(]/;
// markdown emphasis (Biggest DROPPED: **f3d9f2e5**) means a label in prose, not a key
const valueOk = (v: string) =>
  /[A-Za-z0-9]/.test(v) && !TRIVIAL.test(v) && !CODE_VALUE.test(v) && !v.startsWith('//') && !/^[*_]/.test(v);
// actions.mjs:261 is a file and a line, not a key and a value
const FILE_KEY = /\.[A-Za-z]{1,6}$/;
// `—`, `\x1b`: an escape sequence, not a value
const ESCAPE = /^\\(?:u\{?[0-9A-Fa-f]{2,6}\}?|x[0-9A-Fa-f]{2}|[nrtbfv0])$/;

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
  // "For cobalt-payouts, the staging port is 17448": in prose the clause is
  // what binds a value to its owner, so the clause itself is the item
  {
    kind: 'setting',
    own: true,
    // also "Our deploy region is …", "On-call owner is @…", "Staging API listens on port 18443"
    re: /[^.;!?\n`]{0,60}?\b(?:(?:the|our|its|their|my|your)\s+)?([A-Za-z][\w -]{1,40}?)\s+(?:is|was|are|were|=|listens on(?: port)?|runs on(?: port)?|lives at|pinned to|set to)\s+`?(@[\w.-]+|[^\s`,;()]*\d[^\s`,;()]*?)`?(?=[.,;!?)]?(?:\s|$))/gi,
    item: (m) => {
      const v = clean(m[2] ?? '');
      const subject = (m[1] ?? '').trim();
      if (!subject || !v || !valueOk(v)) return null;
      // "there are 12", "it was 3": no owner, and a small bare count is not a detail
      if (PRONOUN.test(subject) || /^\d{1,2}$/.test(v)) return null;
      // markdown, tables, arrows and quotes mean a fragment, not a sentence;
      // "~15" is an estimate, not an exact value
      if (/\*\*|\||→|"/.test(m[0]) || /^[~*≈]/.test(v)) return null;
      const s = clean(m[0].replace(/`/g, '').replace(/\s+/g, ' ').trim());
      return { s, probe: v.length >= 5 ? [v] : [subject, v] };
    },
  },
  // key: value, key = value, KEY=value, "key": "value" anywhere
  {
    kind: 'setting',
    toolKind: 'dotted',
    re: new RegExp(String.raw`(?<![\w.-])${KEY}"?\s*(?:=|:)\s*"?([^\s,;\x60'"#]{1,80})`, 'g'),
    item: (m) => {
      const k = m[1];
      const v = clean(m[2] ?? '');
      if (!k || !v || !keyOk(k) || !valueOk(v)) return null;
      if (FILE_KEY.test(k) && /^\d+(?::\d+)?$/.test(v)) return { s: `${k}:${v}`, kind: 'file' };
      return { s: `${k} = ${v}`, probe: [k, v] };
    },
  },
  { kind: 'quoted', own: true, min: 3, re: /`([^`\n]{3,100})`/g, item: (m) => {
    const s = clean((m[1] ?? '').trim());
    if (s.length < 3 || !detailish(s) || ESCAPE.test(s)) return null;
    return { s, kind: shapeOf(s) ?? (bareName(s) ? 'ident' : 'quoted') };
  } },
  { kind: 'url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>"'`\]]+/g },
  { kind: 'path', re: PATH },
  { kind: 'file', re: /\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|py|rs|go|java|json|md|yml|yaml|toml|sql|sh|ps1|css|html|txt|lock|ini|env|jsonl)\b/g },
  // not a method call (out.push(x), $.ui.status?.()): that is code, read again from the file;
  // nor a field of a one- or two-letter variable (r.stderr, e.message, opts is kept)
  { kind: 'dotted', re: /\b(?![A-Za-z_]\w?\.)[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b(?!\??\.?\()/g },
  { kind: 'version', re: /\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g },
  // hex runs inside a UUID (8-4-4-4-12) are ids, not commits
  // nor a path segment (bundled-skills/2.1.299/1c0faf7d.../plugin-authoring)
  { kind: 'hash', re: /(?<![\w\\/-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w\\/-])/g },
  // serials and fingerprints: 6A:3F:91:0C:5D
  { kind: 'hash', re: /(?<![\w:])[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){3,}(?![\w:])/g },
  // tickets and error codes: OPS-77412, E-LEDGER-4471
  // (not a range in a regex character class: [A-Z0-9-])
  { kind: 'code', re: /(?<![[\w-])(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b(?![\]\w-])/g },
  // branches: feat/compact-plugin, fix/audit-bugs (a prefix, then a hyphenated name)
  { kind: 'branch', re: /(?<![\w.\\/-])[a-z][a-z0-9]*\/[a-z0-9]+(?:-[a-z0-9]+)+(?![\w.\\/-])/g },
  // people and teams: @mkovacs-ledger (not emails, not decorators in code)
  { kind: 'handle', own: true, re: /(?<![\w.@])@[A-Za-z][\w.-]{2,38}(?<![.-])/g },
  { kind: 'flag', re: /(?<![\w-])--[a-z][\w-]{2,}/g },
  { kind: 'env', re: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g },
  { kind: 'ident', re: /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g },
  { kind: 'ident', re: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g },
  // hyphenated words: the agent's prose is full of them (real-data, read-only), so only the
  // person's count, and never a piece of a path or a branch
  { kind: 'ident', not: ['assistant'], re: /(?<![\w.\\/-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![\w.\\/-])/g },
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

// the words that say what a value belongs to come before it ("For
// brisk-payouts, the pinned SDK version is 5.13.1"), so the snippet leans
// left and runs from the start of the value's sentence to its end
function contextOf(text: string, at: number, len: number): string {
  let a = Math.max(0, at - 70);
  let b = Math.min(text.length, at + len + 20);
  const left = text.slice(a, at);
  const cut = Math.max(left.lastIndexOf('. '), left.lastIndexOf('\n'), left.lastIndexOf('; '));
  if (cut >= 0) a += cut + 1;
  const right = text.slice(at + len, b);
  const end = right.search(/[.;]\s|\n/);
  if (end >= 0) b = at + len + end + 1;
  return text.slice(a, b).replace(/\s+/g, ' ').trim();
}

const clean = (s: string) => s.replace(/[.,:;?)\]}'"`*]+$/, '');

// short appears in long as a whole token: config.ts in src/runtime/config.ts, but not --out in --output-format
function within(short: string, long: string): boolean {
  for (let i = long.indexOf(short); i >= 0; i = long.indexOf(short, i + 1)) {
    const before = long[i - 1] ?? ' ';
    const after = long[i + short.length] ?? ' ';
    if (!/[\w-]/.test(before) && !/[\w-]/.test(after)) return true;
  }
  return false;
}

export function collect(dropped: readonly Msg[]): Map<string, Hit> {
  const hits = new Map<string, Hit>();
  const answered = new Set<string>();
  dropped.forEach((m, i) => {
    for (const { text, from } of sources(m, answered)) {
      if (!text) continue;
      const capped = text.length > 200_000 ? text.slice(-200_000) : text;
      // one occurrence matched by two patterns (report_9.txt: file and dotted) counts once
      const here = new Set<string>();
      const own = OWN.has(from);
      // a URL is one detail: its domain or path pieces (pypi.org, mutator.io) are not more
      const urls = [...capped.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s)>"'`\]]+/g)].map((u) => [u.index ?? 0, (u.index ?? 0) + u[0].length] as const);
      const inUrl = (at: number) => urls.some(([a, b]) => at > a && at < b);
      for (const pat of PATTERNS) {
        if (pat.own && !own) continue;
        if (pat.not?.includes(from)) continue;
        // a value the agent looked up and reported is as settled as one the person typed
        const w = pat.own && pat.kind === 'setting' ? WEIGHT.user : WEIGHT[from];
        const { re } = pat;
        re.lastIndex = 0;
        for (const match of capped.matchAll(re)) {
          const it: Item | null = pat.item ? pat.item(match) : { s: clean(match[0]) };
          if (!it) continue;
          const { s, probe } = it;
          const kind = it.kind ?? (own ? undefined : pat.toolKind) ?? pat.kind;
          if (s.length < (pat.min ?? 4) || s.length > 200) continue;
          if (re === PATH && !looksLikePath(s)) continue;
          if (pat.kind !== 'url' && urls.length && inUrl(match.index ?? 0)) continue;
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
            h.context = contextOf(capped, match.index ?? 0, match[0].length);
          }
        }
      }
    }
  });
  return hits;
}

// Learned from 68 real compactions (bench/needed-later.mts): log-odds, per
// feature, that a dropped detail is one the person later had to say again.
// Settings, the person's own words, things said often and said late come
// back; long strings, paths, files and things only tools printed do not.
const LEARNED: Record<string, number> = {
  'best:0': -0.46, 'best:1': -0.38, 'best:2': -0.03, 'best:3': 0.21, 'best:4': 1.87,
  'cnt:0': 0.02, 'cnt:1': -0.16, 'cnt:2': -0.15, 'cnt:3': 0.46,
  'kind:branch': -0.8, 'kind:code': -0.27, 'kind:dotted': 0.64, 'kind:env': -1.15, 'kind:file': -1.51,
  'kind:flag': -1.13, 'kind:handle': -0.66, 'kind:hash': -2.12, 'kind:ident': -0.45, 'kind:path': -2.04,
  'kind:quoted': 0.16, 'kind:setting': 2.86, 'kind:url': -2.07, 'kind:version': -1.23,
  'len:0': 0.77, 'len:1': -0.75, 'len:2': -1.71,
  'read:false': 0.06, 'read:true': -0.46,
  'rec:0': -0.33, 'rec:1': -0.12, 'rec:2': 0.1, 'rec:3': 0.08, 'rec:4': 0.51,
};
// what cannot be re-derived once lost is rarely repeated but costly when it is:
// it keeps its place (held out, this kept as many such lines as before)
const IRREPLACEABLE = new Set<Kind>(['hash', 'url', 'setting', 'code']);

export function scoreOf(h: Hit, n: number): number {
  const v = h.probe ? h.probe[h.probe.length - 1] ?? h.s : h.s;
  const at = h.last / n;
  const features = [
    `kind:${h.kind}`,
    `best:${h.best}`,
    `rec:${at >= 0.9 ? 4 : at >= 0.75 ? 3 : at >= 0.5 ? 2 : at >= 0.25 ? 1 : 0}`,
    `cnt:${h.count >= 10 ? 3 : h.count >= 4 ? 2 : h.count >= 2 ? 1 : 0}`,
    `len:${v.length >= 30 ? 2 : v.length >= 12 ? 1 : 0}`,
    `read:${h.onlyRead}`,
  ];
  return features.reduce((s, f) => s + (LEARNED[f] ?? 0), 0) + (IRREPLACEABLE.has(h.kind) ? 4 : 0);
}

const kept = (h: Hit, summary: string) => (h.probe ?? [h.s]).every((p) => summary.includes(p));

export function specificsBlock(
  dropped: readonly Msg[],
  summary: string,
  budgetChars: number,
  // the recall tool is registered: the header points the agent at it
  recall = false,
  // name what else was lost when it does not all fit (only useful with recall)
  index = false,
): { text: string; candidates: number; missing: number; included: number; indexed: number } | null {
  const hits = collect(dropped);
  const n = Math.max(1, dropped.length);
  const missing = [...hits.values()]
    .filter((h) => !kept(h, summary))
    // a single mention in tool traffic is usually noise
    .filter((h) => !(h.best <= WEIGHT.output && h.count < 2))
    .map((h) => ({ ...h, score: scoreOf(h, n) }))
    // what only tools ever saw (file dumps, command output) and locations only
    // passed to tools can be found again: it never spends context on its own
    .filter((h) => h.inOwn || !(h.best <= WEIGHT.output || h.kind === 'path' || h.kind === 'file'))
    .sort((a, b) => b.score - a.score)
    .slice(0, 500);
  // a string inside a longer one that ranks at least as high (config.ts in src/runtime/config.ts) adds nothing
  const top = missing.filter(
    (h) => !missing.some((o) => o.score >= h.score && o.s.length > h.s.length && within(h.s, o.s)),
  );

  const head =
    `${MARKER} Exact details the summary above dropped, verbatim from the replaced history. ` +
    'For reference only: newer instructions win, and do not redo actions that were already completed.' +
    (recall ? ' Anything else from before is searchable, verbatim, with the amnesia recall tool.' : '');
  let pick = fill(top, head.length, budgetChars);
  const left = () => top.filter((h) => !pick.chosen.some((c) => within(h.s, c)));
  let indexLine: { text: string; named: number } | null = null;
  // more is missing than fits: part of the budget names what else was lost, so
  // the agent knows what to look up instead of not knowing it lost anything
  if (index && left().length > 0) {
    const full = pick;
    pick = fill(top, head.length, Math.floor(budgetChars * VALUE_SHARE));
    const draft = lossIndex(left(), budgetChars - pick.used - 1);
    // the room the index does not use goes back to verbatim values; the index
    // is then rebuilt over what still did not fit, never longer than before
    if (!draft) pick = full;
    else {
      pick = fill(top, head.length, budgetChars - draft.text.length - 1);
      indexLine = lossIndex(left(), draft.text.length + 1);
    }
  }
  if (pick.lines.length === 0 && !indexLine) return null;
  return {
    text: [head, ...pick.lines.map((l) => l.text), ...(indexLine ? [indexLine.text] : [])].join('\n'),
    candidates: hits.size,
    missing: missing.length,
    included: pick.chosen.length,
    indexed: indexLine?.named ?? 0,
  };
}

// with the index on and more missing than fits, values get this share of the budget
const VALUE_SHARE = 0.6;
export const INDEX_LEAD = 'Also dropped (look up with recall before relying on them): ';

type Ranked = Hit & { score: number };

// no one kind takes over a block: a burst of test-fixture versions or a page of
// source links would otherwise crowd out the commits and settings around them
// 12 lines in a 6,000-char block, one per 500 chars beyond that
const kindCap = (budgetChars: number) => Math.max(12, Math.floor(budgetChars / 500));

function fill(top: readonly Ranked[], start: number, budgetChars: number) {
  const lines: { owner?: string; s?: string; text: string }[] = [];
  const chosen: string[] = [];
  const perKind = new Map<Kind, number>();
  const cap = kindCap(budgetChars);
  let used = start;
  for (const h of top) {
    if (chosen.some((c) => within(h.s, c))) continue;
    if (h.kind !== 'setting' && (perKind.get(h.kind) ?? 0) >= cap) continue;
    // settings that share an owner ("For acme-billing, ...") share one line:
    // each extra one costs only its own words
    const own = h.kind === 'setting' ? h.s.match(OWNER) : null;
    if (own?.[1] && own[2]) {
      const group = lines.find((l) => l.owner === own[1]);
      const add = group ? `; ${own[2]}` : `- ${own[1]}: ${own[2]}`;
      if (used + add.length + (group ? 0 : 1) > budgetChars) continue;
      if (group) group.text += add;
      else lines.push({ owner: own[1], text: add });
      chosen.push(h.s);
      perKind.set(h.kind, (perKind.get(h.kind) ?? 0) + 1);
      used += add.length + (group ? 0 : 1);
      continue;
    }
    // cut from the right: the left end holds the subject
    const ctx = h.context.length > 80 ? h.context.slice(0, 77) + '...' : h.context;
    // key = value already says what the value is; context would only spend budget
    const line = ctx && ctx !== h.s && h.kind !== 'setting' ? `- ${h.s} — "${ctx}"` : `- ${h.s}`;
    // a shorter item already chosen that this one contains (--marketplace in the whole
    // install command) gives its place back
    const inside = lines.filter((l) => l.s !== undefined && within(l.s, h.s));
    const refund = inside.reduce((n, l) => n + l.text.length + 1, 0);
    if (used - refund + line.length + 1 > budgetChars) continue;
    for (const l of inside) {
      lines.splice(lines.indexOf(l), 1);
      chosen.splice(chosen.indexOf(l.s ?? ''), 1);
    }
    lines.push({ s: h.s, text: line });
    chosen.push(h.s);
    perKind.set(h.kind, (perKind.get(h.kind) ?? 0) + 1);
    used += line.length + 1 - refund;
  }
  return { lines, chosen, used };
}

// a name is its own search term; a value is named by what it is
const NAME_KINDS = new Set<Kind>(['path', 'file', 'env', 'flag', 'dotted', 'ident', 'branch']);
const VERB_END = /\s+(?:is|was|are|were|=)\s*$/i;

// what a dropped detail is, without its value: "staging port" (owner acme-billing),
// "settlement_retry_timeout_ms", "release to commit"
export function labelOf(
  h: Pick<Hit, 's' | 'kind' | 'probe' | 'context'>,
  { words = false }: { words?: boolean } = {},
): { owner?: string; what: string } | null {
  const value = h.probe?.[h.probe.length - 1];
  const subject = (clause: string) =>
    (value ? clause.replace(value, '') : clause)
      .replace(/^(?:the|our|its|their|my|your)\s+/i, '')
      .replace(VERB_END, '')
      .replace(/[\s,;:]+$/, '')
      .trim()
      .slice(0, 50);
  if (h.kind === 'setting') {
    const own = h.s.match(OWNER);
    if (own?.[1] && own[2]) return { owner: own[1].replace(/^(?:For|In|On|At) /, ''), what: subject(own[2]) || 'a value' };
    const key = h.s.match(/^(\S+) = /);
    if (key?.[1]) return { what: key[1] };
    const what = subject(h.s);
    return what.length >= 3 ? { what } : null;
  }
  if (NAME_KINDS.has(h.kind)) {
    // a piece of a URL (status.example out of https://status.example-ledger.io/...) names nothing
    if ([...h.context.matchAll(/\S*:\/\/\S+/g)].some((m) => m[0].includes(h.s))) return null;
    return { what: h.s };
  }
  // a bare value (a hash, a URL, a version) has no name of its own. The words
  // before it make a poor label for the loss index ("1 4657", "source": on real
  // sessions 1-8% of such entries were needed again), so only the steering list,
  // which shows them beside the value, asks for them
  if (!words) return null;
  const at = h.context.indexOf(h.s);
  const before = (at >= 0 ? h.context.slice(0, at) : '')
    .replace(/[`"'*()[\]{}=,;:|>#-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(-4)
    .join(' ');
  return before.length >= 3 ? { what: before } : null;
}

// one line naming what else was lost, grouped by owner, until the budget runs out
function lossIndex(hits: readonly Ranked[], budget: number): { text: string; named: number } | null {
  const groups: { owner?: string; whats: string[] }[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const l = labelOf(h);
    if (!l) continue;
    const key = `${l.owner ?? ''}\u0000${l.what.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const g = l.owner ? groups.find((x) => x.owner === l.owner) : undefined;
    if (g) g.whats.push(l.what);
    else groups.push({ owner: l.owner, whats: [l.what] });
  }
  const total = groups.reduce((n, g) => n + g.whats.length, 0);
  const render = (g: { owner?: string; whats: string[] }) => (g.owner ? `${g.owner} (${g.whats.join(', ')})` : g.whats[0] ?? '');
  // ungrouped labels are one entry each
  const entries: { owner?: string; whats: string[] }[] = groups.flatMap((g) => (g.owner ? [g] : g.whats.map((w) => ({ whats: [w] }))));
  const out: string[] = [];
  let named = 0;
  let used = INDEX_LEAD.length + 24;
  for (const e of entries) {
    // an owner whose attribute list does not fit is still named on its own
    const t = [render(e), e.owner].find((x) => x && used + x.length + 3 <= budget);
    if (!t) continue;
    out.push(t);
    named += e.whats.length;
    used += t.length + 3;
  }
  if (out.length === 0) return null;
  const more = total - named;
  return { text: INDEX_LEAD + out.join(' · ') + (more > 0 ? ` · and ${more} more` : '') + '.', named };
}

// ---- steering: what the summarizer is asked to keep ----------------------

export const STEER_LEAD =
  'amnesia: this conversation holds these exact details. Where any still matters for the work, keep it in the summary ' +
  'verbatim, with what it belongs to (they are hard to recover once dropped):';
// what a summarizer can usefully be asked to copy: values, not names it can re-read
const STEER_KINDS = new Set<Kind>(['setting', 'url', 'hash', 'version', 'code', 'handle', 'env']);

// a short must-keep list for the summarizer, from the messages about to be compacted.
// Settings are listed as written; other values with the words that say what they are.
export function steerText(messages: readonly Msg[], budgetChars: number): { text: string; items: number } | null {
  const n = Math.max(1, messages.length);
  const ranked = [...collect(messages).values()]
    .filter((h) => h.inOwn && STEER_KINDS.has(h.kind))
    .map((h) => ({ ...h, score: scoreOf(h, n) }))
    .sort((a, b) => b.score - a.score);
  const lines: string[] = [];
  const chosen: string[] = [];
  let used = STEER_LEAD.length;
  for (const h of ranked) {
    if (chosen.some((c) => within(h.s, c))) continue;
    const what = h.kind === 'setting' ? null : labelOf(h, { words: true })?.what;
    const line = `- ${what ? `${what}: ${h.s}` : h.s}`;
    if (used + line.length + 1 > budgetChars) continue;
    lines.push(line);
    chosen.push(h.s);
    used += line.length + 1;
  }
  return lines.length ? { text: [STEER_LEAD, ...lines].join('\n'), items: lines.length } : null;
}

// the person's own /compact instructions come first and stay whole
export const withSteer = (instructions: string | undefined, steer: string) =>
  instructions && instructions.trim() ? `${instructions.trim()}\n\n${steer}` : steer;
