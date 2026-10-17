// Replays the compactions of a bench/run-ab.mjs result offline with the
// current extractor: for each run, which facts the real summary dropped and
// which of those the block would carry now. No model calls.
//
//   node bench/replay-ab.mts [bench/results/ab-100]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { eventsOf } from './events.mts';
import { specificsBlock } from '../plugin/hooks/specifics.ts';

const dir = resolve(process.argv[2] || 'bench/results/ab-100');
const runs: any[] = JSON.parse(readFileSync(join(dir, 'runs.json'), 'utf8'));
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
for (const r of runs) {
  const p = find(r.forkId);
  const e = p ? eventsOf(p)[0] : undefined;
  if (!e) {
    console.log(`${r.arm}${r.rep}: transcript not found`);
    continue;
  }
  const block = specificsBlock(e.dropped, e.summary, 6000)?.text ?? '';
  const facts: { id: string; expected: string }[] = r.results;
  const lost = facts.filter((f) => !e.summary.includes(f.expected));
  const kept = lost.filter((f) => block.includes(f.expected));
  dropped += lost.length;
  carried += kept.length;
  console.log(
    `${r.arm}${r.rep}: summary dropped ${lost.length}, block now carries ${kept.length}` +
      (lost.length ? `; still missing: ${lost.filter((f) => !kept.includes(f)).map((f) => `${f.id}=${f.expected}`).join(', ') || 'none'}` : ''),
  );
}
console.log(`total: block carries ${carried} of ${dropped} facts the summaries dropped`);
