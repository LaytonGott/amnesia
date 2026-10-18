// Ground truth from real sessions (no model calls): of the exact details each
// compaction dropped (missing from summary and kept messages), which did the
// person or the agent use again afterwards (a prompt, the agent's text, a tool
// call's input; not tool output, since re-reading a file is not memory)? Scores
// what share of those each extractor module's block carried.
//
//   BUDGET=12000 STRICT=3 node bench/needed-later.mts plugin/hooks/specifics.ts [other-module.ts ...]
import { eventsOf } from './events.mts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const mods = process.argv.slice(2);
const root = join(homedir(), '.claude', 'projects');
const textOf = (c: any) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '');
type Case = { key: string; dropped: any[]; present: string; after: string };
const cases: Case[] = [];
for (const d of readdirSync(root)) {
  if (/ab-100|amnesia-bench|scratchpad/i.test(d)) continue;
  for (const f of readdirSync(join(root, d))) {
    if (!f.endsWith('.jsonl') || statSync(join(root, d, f)).size < 50_000) continue;
    let evs; try { evs = eventsOf(join(root, d, f)); } catch { continue; }
    if (!evs.length) continue;
    const rows = readFileSync(join(root, d, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const bounds = rows.map((o, i) => (o?.subtype === 'compact_boundary' ? i : -1)).filter((i) => i >= 0);
    for (const ev of evs) {
      const ts = ev.key.split('|')[0];
      const bi = bounds.find((i) => rows[i].timestamp === ts);
      if (bi === undefined) continue;
      const end = bounds.find((i) => i > bi) ?? rows.length;
      // what was used again: the person's prompts, the agent's text and its tool inputs (not tool output: re-reading a file is not memory)
      const after: string[] = [];
      for (const o of rows.slice(bi + 1, end)) {
        if (o.isCompactSummary || o.isMeta) continue;
        const c = o.message?.content;
        if (o.type === 'user' && !(Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result'))) { const t = textOf(c); if (!t.startsWith('[amnesia]')) after.push(t); }
        if (o.type === 'assistant' && Array.isArray(c)) for (const b of c) { if (b?.type === 'text') after.push(b.text); if (b?.type === 'tool_use') after.push(JSON.stringify(b.input ?? {})); }
      }
      if (!after.length) continue;
      cases.push({ key: `${f.slice(0, 8)}|${ts}`, dropped: ev.dropped, present: ev.summary + '\n' + ev.kept, after: after.join('\n') });
    }
  }
}
console.log(`compactions with later work: ${cases.length}`);
for (const m of mods) {
  const S = await import(pathToFileURL(resolve(m)).href);
  // STRICT=3: a value found in 3+ different sessions is generic (a common flag
  // or word); typing it again shows no memory, so it doesn't count as needed
  const STRICT = Number(process.env.STRICT ?? 0);
  const sessionsOf = new Map<string, Set<string>>();
  if (STRICT) for (const c of cases) for (const h of S.collect(c.dropped).values() as any) {
    const v = h.probe ? h.probe[h.probe.length - 1] : h.s;
    const s = sessionsOf.get(v) ?? new Set<string>(); s.add(c.key.split('|')[0]!); sessionsOf.set(v, s);
  }
  const particular = (v: string) => !STRICT || (sessionsOf.get(v)?.size ?? 0) < STRICT;
  let needed = 0, carried = 0, items = 0, usefulItems = 0, chars = 0;
  for (const c of cases) {
    const hits = [...S.collect(c.dropped).values()];
    const missing = hits.filter((h: any) => !(h.probe ?? [h.s]).every((p: string) => c.present.includes(p)));
    // needed: its value shows up again in later work (the probe's last part is the value)
    const val = (h: any) => (h.probe ? h.probe[h.probe.length - 1] : h.s);
    const need = missing.filter((h: any) => { const v = val(h); return v.length >= 4 && c.after.includes(v) && particular(v); });
    const block = S.specificsBlock(c.dropped, c.present, Number(process.env.BUDGET ?? 6000), true, true);
    const bt = block?.text ?? '';
    needed += need.length;
    carried += need.filter((h: any) => bt.includes(val(h))).length;
    const lines = bt.split('\n').filter((l: string) => l.startsWith('- '));
    items += lines.length;
    usefulItems += lines.filter((l: string) => need.some((h: any) => l.includes(val(h)))).length;
    chars += bt.length;
  }
  console.log(`${m.split('/').pop()}: needed-later details ${needed}, block carried ${carried} (${((100 * carried) / needed).toFixed(1)}%); block lines ${items}, lines holding a needed detail ${usefulItems} (${((100 * usefulItems) / items).toFixed(1)}%); avg block ${Math.round(chars / cases.length)} chars`);
}
