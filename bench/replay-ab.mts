// Replays the compactions of a bench/run-ab.mjs result offline with the
// current extractor: for each run, which facts the real summary dropped,
// which of those the block would carry now, and which it would carry bound
// to their owner (the value and its service or key on one block line, so the
// agent can tell whose value it is). No model calls.
//
//   node bench/replay-ab.mts [bench/results/ab-100] [runs-v7.json]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eventsOf } from './events.mts';
// AUDIT_MODULE=<file> replays another version of the extractor
const modUrl = process.env.AUDIT_MODULE ? pathToFileURL(process.env.AUDIT_MODULE).href : new URL('../plugin/hooks/specifics.ts', import.meta.url).href;
const { specificsBlock } = (await import(modUrl)) as { specificsBlock: (d: any[], s: string, b: number) => { text: string } | null };

const dir = resolve(process.argv[2] || 'bench/results/ab-100');
const runsFile = process.argv[3] || 'runs.json';
const runs: any[] = JSON.parse(readFileSync(join(dir, runsFile), 'utf8'));
const factsPath = join(dir, 'facts.json');
const owners = new Map<string, string>(
  existsSync(factsPath) ? JSON.parse(readFileSync(factsPath, 'utf8')).map((f: any) => [f.id, f.owner ?? '']) : [],
);
const root = join(homedir(), '.claude', 'projects');
const find = (id: string) => {
  for (const d of readdirSync(root)) {
    const p = join(root, d, `${id}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
};

let dropped = 0;
let carried = 0;
let bound = 0;
for (const r of runs) {
  const p = find(r.forkId);
  const e = p ? eventsOf(p)[0] : undefined;
  if (!e) {
    console.log(`${r.arm}${r.rep}: transcript not found`);
    continue;
  }
  // still in context: the summary and the messages kept verbatim (AUDIT_KEPT=0: summary alone, pre-0.14)
  const present = e.summary + '\n' + e.kept;
  const given = process.env.AUDIT_KEPT === '0' ? e.summary : present;
  const block = specificsBlock(e.dropped, given, Number(process.env.AUDIT_BUDGET || 6000))?.text ?? '';
  const lines = block.split('\n');
  const facts: { id: string; expected: string }[] = r.results;
  const lost = facts.filter((f) => !present.includes(f.expected));
  const kept = lost.filter((f) => block.includes(f.expected));
  const tied = kept.filter((f) => {
    const o = (owners.get(f.id) ?? '').toLowerCase();
    return lines.some((l) => l.includes(f.expected) && (!o || l.toLowerCase().includes(o)));
  });
  dropped += lost.length;
  carried += kept.length;
  bound += tied.length;
  if (!lost.length) continue;
  const unbound = kept.filter((f) => !tied.includes(f)).map((f) => `${f.id}=${f.expected}`);
  const missing = lost.filter((f) => !kept.includes(f)).map((f) => `${f.id}=${f.expected}`);
  console.log(
    `${r.arm}${r.rep}: summary dropped ${lost.length}, block carries ${kept.length}, bound to owner ${tied.length}` +
      (unbound.length ? `\n  carried but unbound: ${unbound.join(', ')}` : '') +
      (missing.length ? `\n  not carried: ${missing.join(', ')}` : ''),
  );
}
console.log(`total: of ${dropped} facts the summaries dropped, the block carries ${carried}, ${bound} bound to their owner`);
