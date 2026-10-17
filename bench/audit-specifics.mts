// Offline audit of the plugin's block over every real compaction on this
// machine. No model calls. Node 22.18+/24 (runs .ts directly):
//
//   node bench/audit-specifics.mts [projectsRoot]
//   AUDIT_MODULE=/path/to/other/specifics.ts node bench/audit-specifics.mts
//
// Per boundary it rebuilds the messages the compaction replaced the way the
// engine hands them to a session.compact hook (assistant tool uses carry their
// result text), runs specificsBlock against the real summary, and scores the
// block with its own classifiers, independent of the plugin's ranking:
//
//   promptAtoms  exact strings from dropped user prompts (same regex as
//                bench/audit-real.mjs, the EFFICACY.md 29.1% figure):
//                survival in summary alone vs summary + block
//   highValue    hashes, URLs, versions, paths, env vars anywhere in the
//                dropped content and absent from the summary: share the
//                block brings back
//   composition  what the block spends its budget on, and how many items
//                only ever appeared in Read/Grep/Glob output (re-readable
//                from disk)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Msg = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: { tool_use_id?: string; tool: string; input: Record<string, unknown>; text?: string }[];
  toolResults?: { tool_use_id?: string; text?: string }[];
};
type Block = { text: string; candidates: number; missing: number; included: number } | null;

const root = process.argv[2] || join(homedir(), '.claude', 'projects');
const modPath = process.env.AUDIT_MODULE || new URL('../plugin/hooks/specifics.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { specificsBlock } = (await import(pathToFileURL(modPath).href)) as {
  specificsBlock: (d: Msg[], s: string, b: number) => Block;
};
const BUDGET = Number(process.env.AUDIT_BUDGET || 6000);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'LS']);

const COMPOUND_RE = /\b[A-Za-z][A-Za-z0-9]*(?:[._/\\-][A-Za-z0-9]+)+\b/g;

function kindOf(s: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return 'url';
  if (/^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$/.test(s)) return 'hash';
  if (/^v?\d+\.\d+\.\d+/.test(s)) return 'version';
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(s)) return 'env';
  if (/[\\/]/.test(s)) return 'path';
  if (/^[\w-]+\.[A-Za-z0-9]{1,8}$/.test(s)) return 'file';
  return 'other';
}
const HIGH = new Set(['url', 'hash', 'version', 'env', 'path']);
const HV_RE: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>"'`\]]+/g,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g,
  /\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g,
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g,
  /(?:[A-Za-z]:|~|\.{1,2})?[\\/][\w.@-]+(?:[\\/][\w.@-]+)*\.[A-Za-z0-9]{1,8}\b|\b[\w.@-]+(?:[\\/][\w.@-]+)+\.[A-Za-z0-9]{1,8}\b/g,
];
const trimEnd = (s: string) => s.replace(/[.,:;)\]}'"`]+$/, '');

const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
      : '';

function listFiles(): string[] {
  const out: string[] = [];
  for (const p of readdirSync(root, { withFileTypes: true })) {
    if (!p.isDirectory()) continue;
    for (const f of readdirSync(join(root, p.name), { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith('.jsonl')) out.push(join(root, p.name, f.name));
    }
  }
  return out;
}

type Event = {
  key: string;
  dropped: Msg[];
  prompts: string[];
  readOnly: (s: string) => boolean;
  summary: string;
};

function eventsOf(path: string): Event[] {
  const rows: any[] = [];
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    if (!l) continue;
    try {
      rows.push(JSON.parse(l));
    } catch {}
  }
  const bounds = rows.map((o, i) => (o?.subtype === 'compact_boundary' ? i : -1)).filter((i) => i >= 0);
  const out: Event[] = [];
  bounds.forEach((bi, k) => {
    const prev = k > 0 ? bounds[k - 1]! : -1;
    const prevPres = new Set<string>(k > 0 ? rows[prev]?.compactMetadata?.preservedMessages?.uuids ?? [] : []);
    const curPres = new Set<string>(rows[bi]?.compactMetadata?.preservedMessages?.uuids ?? []);
    const summaryRow = rows.slice(bi + 1).find((o) => o?.isCompactSummary);
    if (!summaryRow) return;
    const inRange = rows.filter(
      (o, i) =>
        (o?.type === 'user' || o?.type === 'assistant') &&
        ((i > prev && i < bi) || (o.uuid && prevPres.has(o.uuid))) &&
        !(o.uuid && curPres.has(o.uuid)),
    );
    if (inRange.length === 0) return;
    const results = new Map<string, string>();
    for (const o of inRange) {
      if (o.type !== 'user' || !Array.isArray(o.message?.content)) continue;
      for (const b of o.message.content) {
        if (b?.type === 'tool_result') results.set(b.tool_use_id, textOf(b.content));
      }
    }
    const dropped: Msg[] = [];
    const prompts: string[] = [];
    const readTexts: string[] = [];
    const otherTexts: string[] = [];
    for (const o of inRange) {
      const c = o.message?.content;
      if (o.type === 'assistant') {
        const toolUses = Array.isArray(c)
          ? c
              .filter((b: any) => b?.type === 'tool_use')
              .map((b: any) => ({ tool_use_id: b.id, tool: b.name, input: b.input ?? {}, text: results.get(b.id) }))
          : [];
        dropped.push({ role: 'assistant', text: textOf(c), toolUses });
        otherTexts.push(textOf(c));
        for (const u of toolUses) {
          otherTexts.push(JSON.stringify(u.input));
          (READ_TOOLS.has(u.tool) ? readTexts : otherTexts).push(u.text ?? '');
        }
      } else {
        const toolResults = Array.isArray(c)
          ? c.filter((b: any) => b?.type === 'tool_result').map((b: any) => ({ tool_use_id: b.tool_use_id, text: textOf(b.content) }))
          : [];
        const text = textOf(c);
        dropped.push({ role: 'user', text, toolUses: [], toolResults });
        if (!toolResults.length && !o.isMeta && !o.isCompactSummary && text.trim()) {
          prompts.push(text);
          otherTexts.push(text);
        } else if (!toolResults.length) {
          otherTexts.push(text);
        }
      }
    }
    const other = otherTexts.join('\n');
    const read = readTexts.join('\n');
    const md = rows[bi].compactMetadata ?? {};
    out.push({
      key: `${rows[bi].timestamp}|${md.preTokens}|${md.postTokens}`,
      dropped,
      prompts,
      readOnly: (s) => read.includes(s) && !other.includes(s),
      summary: textOf(summaryRow.message?.content),
    });
  });
  return out;
}

const best = new Map<string, Event>();
let files = 0;
for (const f of listFiles()) {
  if (statSync(f).size < 1000) continue;
  files++;
  for (const e of eventsOf(f)) {
    const cur = best.get(e.key);
    if (!cur || e.dropped.length > cur.dropped.length) best.set(e.key, e);
  }
}

const t = {
  events: 0,
  promptAtoms: 0,
  atomsInSummary: 0,
  atomsInSummaryOrBlock: 0,
  hvMissing: 0,
  hvRecovered: 0,
  items: 0,
  itemsReadOnly: 0,
  blockChars: 0,
  maxMs: 0,
  byKind: {} as Record<string, number>,
  hvMissingByKind: {} as Record<string, number>,
  hvRecoveredByKind: {} as Record<string, number>,
};
for (const e of best.values()) {
  const t0 = performance.now();
  const block = specificsBlock(e.dropped, e.summary, BUDGET);
  t.maxMs = Math.max(t.maxMs, performance.now() - t0);
  t.events++;
  const b = block?.text ?? '';
  const sumL = e.summary.toLowerCase();
  const bothL = (e.summary + '\n' + b).toLowerCase();
  const atoms = new Set<string>();
  for (const p of e.prompts) for (const m of p.matchAll(COMPOUND_RE)) if (m[0].length >= 5) atoms.add(m[0].toLowerCase());
  for (const a of atoms) {
    t.promptAtoms++;
    if (sumL.includes(a)) t.atomsInSummary++;
    if (bothL.includes(a)) t.atomsInSummaryOrBlock++;
  }
  const hv = new Set<string>();
  const all = e.dropped.map((m) => [m.text, ...m.toolUses.map((u) => JSON.stringify(u.input) + '\n' + (u.text ?? ''))].join('\n')).join('\n');
  for (const re of HV_RE) for (const m of all.matchAll(re)) {
    const s = trimEnd(m[0]);
    if (s.length >= 4 && s.length <= 200 && HIGH.has(kindOf(s))) hv.add(s);
  }
  for (const s of hv) {
    if (e.summary.includes(s)) continue;
    const k = kindOf(s);
    t.hvMissing++;
    t.hvMissingByKind[k] = (t.hvMissingByKind[k] ?? 0) + 1;
    if (b.includes(s)) {
      t.hvRecovered++;
      t.hvRecoveredByKind[k] = (t.hvRecoveredByKind[k] ?? 0) + 1;
    }
  }
  for (const line of b.split('\n').slice(1)) {
    const item = line.replace(/^- /, '').split(' — "')[0] ?? '';
    if (!item) continue;
    t.items++;
    t.byKind[kindOf(item)] = (t.byKind[kindOf(item)] ?? 0) + 1;
    if (e.readOnly(item)) t.itemsReadOnly++;
  }
  t.blockChars += b.length;
}

const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
console.log(`module ${modPath}`);
console.log(`${files} session files, ${t.events} distinct compactions, budget ${BUDGET} chars`);
console.log(`promptAtoms   ${t.promptAtoms} exact strings from dropped prompts`);
console.log(`  in summary            ${pct(t.atomsInSummary, t.promptAtoms)}`);
console.log(`  in summary + block    ${pct(t.atomsInSummaryOrBlock, t.promptAtoms)}`);
console.log(`highValue     ${t.hvMissing} missing from summary; block brings back ${pct(t.hvRecovered, t.hvMissing)}`);
for (const k of Object.keys(t.hvMissingByKind).sort()) {
  console.log(`  ${k.padEnd(8)} ${pct(t.hvRecoveredByKind[k] ?? 0, t.hvMissingByKind[k]!)} of ${t.hvMissingByKind[k]}`);
}
console.log(`composition   ${t.items} items, avg block ${(t.blockChars / Math.max(1, t.events)).toFixed(0)} chars, slowest ${t.maxMs.toFixed(0)} ms`);
for (const k of Object.keys(t.byKind).sort((a, b) => t.byKind[b]! - t.byKind[a]!)) {
  console.log(`  ${k.padEnd(8)} ${pct(t.byKind[k]!, t.items)}`);
}
console.log(`  only in Read/Grep/Glob output: ${pct(t.itemsReadOnly, t.items)}`);
