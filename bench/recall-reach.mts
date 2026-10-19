// Can recall reach what the block missed? For each dropped detail used again
// later (strict label: found in fewer than 3 sessions) that the 12k block did
// not carry, query recall with the words around its later use (the value left
// out) and check whether the top results show it. LIM / MAXC: results and chars.
//   node bench/recall-reach.mts
import { eventsOf } from './events.mts';
import * as S from '../plugin/hooks/specifics.ts';
import { droppedFiles, search } from '../plugin/hooks/recall.ts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const root = join(homedir(), '.claude', 'projects');
const textOf = (c: any) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '');
const cases: any[] = [];
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
      const bi = bounds.find((i) => rows[i].timestamp === ts); if (bi === undefined) continue;
      const end = bounds.find((i) => i > bi) ?? rows.length;
      const after: string[] = [];
      for (const o of rows.slice(bi + 1, end)) {
        if (o.isCompactSummary || o.isMeta) continue;
        const c = o.message?.content;
        if (o.type === 'user' && !(Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result'))) { const t = textOf(c); if (!t.startsWith('[amnesia]')) after.push(t); }
        if (o.type === 'assistant' && Array.isArray(c)) for (const b of c) { if (b?.type === 'text') after.push(b.text); if (b?.type === 'tool_use') after.push(JSON.stringify(b.input ?? {})); }
      }
      if (after.length) cases.push({ key: f.slice(0, 8), dropped: ev.dropped, present: ev.summary + '\n' + ev.kept, after: after.join('\n') });
    }
  }
}

const val = (h: any) => (h.probe ? h.probe[h.probe.length - 1] : h.s);
const sessionsOf = new Map<string, Set<string>>();
for (const c of cases) for (const h of S.collect(c.dropped).values() as any) { const s = sessionsOf.get(val(h)) ?? new Set(); s.add(c.key); sessionsOf.set(val(h), s); }
const STOP = new Set('the and for with that this from have what which into then than also just when where were been will your they them there their about would could should because these those here only some more most very can not are was its it\'s you use used using make sure'.split(' '));
// what an agent that knows the subject but not the value would type: words
// around where the value was used later, the value itself left out
const queryFor = (after: string, v: string) => {
  const at = after.indexOf(v);
  const win = (after.slice(Math.max(0, at - 80), at) + ' ' + after.slice(at + v.length, at + v.length + 40)).toLowerCase();
  const words = [...new Set(win.split(/[^\p{L}\p{N}._/@-]+/u).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)))];
  return words.slice(-5).join(' ');
};
let missed = 0, found = 0, carried = 0, noQuery = 0;
const byKind: Record<string, [number, number]> = {};
for (const c of cases) {
  const hits = [...S.collect(c.dropped).values()] as any[];
  const need = hits.filter((h) => !(h.probe ?? [h.s]).every((p: string) => c.present.includes(p)) && val(h).length >= 4 && c.after.includes(val(h)) && (sessionsOf.get(val(h))?.size ?? 0) < 3);
  const bt = S.specificsBlock(c.dropped, c.present, 12000, true, true)?.text ?? '';
  const recs = droppedFiles(c.dropped, 1).flat();
  for (const h of need) {
    if (bt.includes(val(h))) { carried++; continue; }
    const q = queryFor(c.after, val(h));
    if (!q) { noQuery++; continue; }
    missed++;
    const ok = search(recs, q, Number(process.env.LIM ?? 10), Number(process.env.MAXC ?? 8000)).includes(val(h));
    if (ok) found++;
    const k = byKind[h.kind] ?? [0, 0]; k[0]++; if (ok) k[1]++; byKind[h.kind] = k;
  }
}
console.log(`block carried ${carried}; missed with a usable query ${missed}, recall top results found ${found} (${((100 * found) / missed).toFixed(1)}%); no query words ${noQuery}`);
console.log(Object.entries(byKind).sort((a, b) => b[1][0] - a[1][0]).map(([k, [n, f]]) => `${k} ${f}/${n} (${((100 * f) / n).toFixed(0)}%)`).join(', '));
