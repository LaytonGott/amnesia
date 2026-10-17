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
//   highValue    hashes, serials, URLs, versions, codes, paths, env vars
//                anywhere in the dropped content and absent from the
//                summary: share the block brings back (also for the subset
//                the person or the agent actually wrote)
//   settings     named values stated in prose (`key` is 7350, key_x = 41)
//                missing from the summary: share the block brings back
//                with key and value on one line
//   composition  what the block spends its budget on, and how many items
//                only ever appeared in Read/Grep/Glob output (re-readable
//                from disk)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eventsOf, type Event, type Msg } from './events.mts';

type Block = { text: string; candidates: number; missing: number; included: number } | null;

const root = process.argv[2] || join(homedir(), '.claude', 'projects');
const modPath = process.env.AUDIT_MODULE || new URL('../plugin/hooks/specifics.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { specificsBlock } = (await import(pathToFileURL(modPath).href)) as {
  specificsBlock: (d: Msg[], s: string, b: number) => Block;
};
const BUDGET = Number(process.env.AUDIT_BUDGET || 6000);

const COMPOUND_RE = /\b[A-Za-z][A-Za-z0-9]*(?:[._/\\-][A-Za-z0-9]+)+\b/g;

function kindOf(s: string): string {
  if (/ = /.test(s)) return 'setting';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return 'url';
  if (/^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$/.test(s)) return 'hash';
  if (/^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){3,}$/.test(s)) return 'serial';
  if (/^v?\d+\.\d+\.\d+/.test(s)) return 'version';
  if (/^(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(s)) return 'code';
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(s)) return 'env';
  if (/[\\/]/.test(s)) return 'path';
  if (/^[\w-]+\.[A-Za-z0-9]{1,8}$/.test(s)) return 'file';
  return 'other';
}
const HIGH = new Set(['url', 'hash', 'serial', 'version', 'code', 'env', 'path']);
const HV_RE: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>"'`\]]+/g,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g,
  /(?<![\w:])[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){3,}(?![\w:])/g,
  /\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g,
  /\b(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g,
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g,
  /(?:[A-Za-z]:|~|\.{1,2})?[\\/][\w.@-]+(?:[\\/][\w.@-]+)*\.[A-Za-z0-9]{1,8}\b|\b[\w.@-]+(?:[\\/][\w.@-]+)+\.[A-Za-z0-9]{1,8}\b/g,
];
// a named value someone stated in prose: `key` is 7350, key_name = 41, KEY: 9
// (value with a digit, so it is a concrete setting, not a type or a word)
const SETTING_RE = /`?\b([A-Za-z_][\w.-]*[_.][\w.-]*|[A-Z][A-Z0-9_]{3,})`?\s*(?:is|=|:)\s*`?([^\s`,;()]*\d[^\s`,;()]*)/g;
const trimEnd = (s: string) => s.replace(/[.,:;)\]}'"`]+$/, '');

// synthetic sessions from this repo's own benches are not real data
const SYNTHETIC = /bench-results|scratchpad-compact-proj/;

function listFiles(): string[] {
  const out: string[] = [];
  for (const p of readdirSync(root, { withFileTypes: true })) {
    if (!p.isDirectory() || SYNTHETIC.test(p.name)) continue;
    for (const f of readdirSync(join(root, p.name), { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith('.jsonl')) out.push(join(root, p.name, f.name));
    }
  }
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
  hvOwnMissing: 0,
  hvOwnRecovered: 0,
  setMissing: 0,
  setRecovered: 0,
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
  const own = [...e.prompts, ...e.dropped.filter((m) => m.role === 'assistant').map((m) => m.text)].join('\n');
  for (const s of hv) {
    if (e.summary.includes(s)) continue;
    const k = kindOf(s);
    t.hvMissing++;
    t.hvMissingByKind[k] = (t.hvMissingByKind[k] ?? 0) + 1;
    const said = own.includes(s);
    if (said) t.hvOwnMissing++;
    if (b.includes(s)) {
      t.hvRecovered++;
      t.hvRecoveredByKind[k] = (t.hvRecoveredByKind[k] ?? 0) + 1;
      if (said) t.hvOwnRecovered++;
    }
  }
  const blockLines = b.split('\n');
  const settings = new Map<string, string>();
  for (const m of own.matchAll(SETTING_RE)) {
    const v = trimEnd(m[2] ?? '');
    if (m[1] && v) settings.set(`${m[1]}\u0000${v}`, m[1]);
  }
  for (const [kv, k] of settings) {
    const v = kv.split('\u0000')[1]!;
    if (e.summary.includes(k) && e.summary.includes(v)) continue;
    t.setMissing++;
    if (blockLines.some((l) => l.includes(k) && l.includes(v))) t.setRecovered++;
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
console.log(`  said by the person or the agent: ${pct(t.hvOwnRecovered, t.hvOwnMissing)} of ${t.hvOwnMissing}`);
console.log(`settings      ${t.setMissing} named values stated in prose and missing from summary; block brings back ${pct(t.setRecovered, t.setMissing)}`);
console.log(`composition   ${t.items} items, avg block ${(t.blockChars / Math.max(1, t.events)).toFixed(0)} chars, slowest ${t.maxMs.toFixed(0)} ms`);
for (const k of Object.keys(t.byKind).sort((a, b) => t.byKind[b]! - t.byKind[a]!)) {
  console.log(`  ${k.padEnd(8)} ${pct(t.byKind[k]!, t.items)}`);
}
console.log(`  only in Read/Grep/Glob output: ${pct(t.itemsReadOnly, t.items)}`);
