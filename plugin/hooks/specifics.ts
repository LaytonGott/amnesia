// Pure string code: no Node, no $. Shared shape with SessionMessage.
export type Msg = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: readonly { tool: string; input: Record<string, unknown>; text?: string }[];
  toolResults?: readonly { text?: string }[];
  handle?: string;
};

export const MARKER = '[amnesia]';

const PATH = /(?:[A-Za-z]:)?(?:[\\/]?[\w.@-]+[\\/])+[\w.@-]+/g;
// a slash between words ("deploy/infra") is prose, not a path
const looksLikePath = (s: string) =>
  /^(?:[A-Za-z]:|[\\/~]|\.{1,2}[\\/])/.test(s) || /\.[A-Za-z0-9]{1,8}$/.test(s);

const PATTERNS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>"'`\]]+/g,
  PATH,
  /\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|py|rs|go|java|json|md|yml|yaml|toml|sql|sh|ps1|css|html|txt|lock|ini|env|jsonl)\b/g,
  /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g,
  /\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g,
  /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g,
  /(?<![\w-])--[a-z][\w-]{2,}/g,
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g,
  /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g,
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,
];

// user words outrank the agent's, which outrank tool traffic
const WEIGHT = { user: 4, assistant: 3, toolInput: 2, toolOutput: 1 } as const;

type Hit = { s: string; count: number; weight: number; last: number; context: string };

function sources(m: Msg): { text: string; weight: number }[] {
  if (m.text.startsWith(MARKER)) {
    // an earlier block: carry its items forward; they rank as old, so newer details win the budget
    const items = [...m.text.matchAll(/^- (.+?)(?: — ".*")?$/gm)].map((x) => x[1] ?? '');
    return [{ text: items.join('\n'), weight: WEIGHT.assistant }];
  }
  const out: { text: string; weight: number }[] = [
    { text: m.text, weight: m.role === 'user' ? WEIGHT.user : WEIGHT.assistant },
  ];
  for (const u of m.toolUses) {
    for (const v of Object.values(u.input ?? {})) {
      if (typeof v === 'string') out.push({ text: v, weight: WEIGHT.toolInput });
    }
    if (u.text) out.push({ text: u.text, weight: WEIGHT.toolOutput });
  }
  for (const r of m.toolResults ?? []) {
    if (r.text) out.push({ text: r.text, weight: WEIGHT.toolOutput });
  }
  return out;
}

function contextOf(text: string, at: number, len: number): string {
  const a = Math.max(0, at - 40);
  const b = Math.min(text.length, at + len + 40);
  return text.slice(a, b).replace(/\s+/g, ' ').trim();
}

const clean = (s: string) => s.replace(/[.,:;)\]}'"`]+$/, '');

export function collect(dropped: readonly Msg[]): Map<string, Hit> {
  const hits = new Map<string, Hit>();
  dropped.forEach((m, i) => {
    for (const { text, weight } of sources(m)) {
      if (!text) continue;
      const capped = text.length > 200_000 ? text.slice(-200_000) : text;
      for (const re of PATTERNS) {
        re.lastIndex = 0;
        for (const match of capped.matchAll(re)) {
          const s = clean(match[0]);
          if (s.length < 4 || s.length > 200) continue;
          if (re === PATH && !looksLikePath(s)) continue;
          const h = hits.get(s);
          const ctx = contextOf(capped, match.index ?? 0, s.length);
          if (h) {
            h.count++;
            h.weight = Math.max(h.weight, weight);
            h.last = i;
            h.context = ctx;
          } else {
            hits.set(s, { s, count: 1, weight, last: i, context: ctx });
          }
        }
      }
    }
  });
  return hits;
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
    .filter((h) => !(h.weight === WEIGHT.toolOutput && h.count < 2))
    .map((h) => ({ ...h, score: h.weight * 2 + Math.log2(1 + h.count) + (3 * h.last) / n }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 500);
  // a string inside a longer candidate (config.ts in src/runtime/config.ts) adds nothing
  const top = missing.filter((h) => !missing.some((o) => o.s.length > h.s.length && o.s.includes(h.s)));

  const head =
    `${MARKER} Exact details the summary above dropped, verbatim from the replaced history. ` +
    'For reference only: newer instructions win, and do not redo actions that were already completed.';
  const lines: string[] = [];
  const chosen: string[] = [];
  let used = head.length;
  for (const h of top) {
    if (chosen.some((c) => c.includes(h.s))) continue;
    const ctx = h.context.length > 120 ? h.context.slice(0, 117) + '...' : h.context;
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
