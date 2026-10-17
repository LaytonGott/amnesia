// Times the plugin extractor on real compactions and prints the block for the newest one.
// Node 22.18+/24 (runs .ts directly):  node bench/specifics-real.mts <session.jsonl>
import { readFileSync } from 'node:fs';
import { specificsBlock, type Msg } from '../plugin/hooks/specifics.ts';

const file = process.argv[2]!;
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const bIdx = rows.map((o: any, i: number) => (o.subtype === 'compact_boundary' ? i : -1)).filter((i: number) => i >= 0);
const text = (c: any) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '');
const resText = (c: any) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '');
for (const k of [bIdx.length - 1, Math.floor(bIdx.length / 2), 0]) {
  const end = bIdx[k]!, start = k > 0 ? bIdx[k - 1]! : -1;
  const dropped: Msg[] = [];
  for (let i = start + 1; i < end; i++) {
    const o = rows[i];
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const c = o.message?.content;
    const toolUses = Array.isArray(c) ? c.filter((b: any) => b?.type === 'tool_use').map((b: any) => ({ tool: b.name, input: b.input ?? {} })) : [];
    const toolResults = Array.isArray(c) ? c.filter((b: any) => b?.type === 'tool_result').map((b: any) => ({ text: resText(b.content) })) : [];
    dropped.push({ role: o.type, text: text(c), toolUses, toolResults });
  }
  const summary = rows.slice(end).find((o: any) => o.isCompactSummary);
  const sum = text(summary?.message?.content);
  const t0 = performance.now();
  const r = specificsBlock(dropped, sum, 6000);
  const ms = performance.now() - t0;
  const chars = dropped.reduce((a, m) => a + m.text.length + (m.toolResults ?? []).reduce((x, t) => x + (t.text?.length ?? 0), 0), 0);
  console.log(`event ${k + 1}: ${dropped.length} msgs, ${(chars / 1e6).toFixed(1)}M chars dropped, summary ${sum.length} chars -> ${ms.toFixed(0)} ms; candidates ${r?.candidates} missing ${r?.missing} included ${r?.included} block ${r?.text.length} chars`);
  if (k === bIdx.length - 1) console.log(r?.text.split('\n').slice(0, 16).join('\n'));
}
