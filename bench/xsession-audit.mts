// Offline audit of cross-session recall on real projects (no model calls).
// For every prompt the person sent in a project with 2+ sessions: what would
// crossSessionRecall attach from the project's other sessions, using only
// messages written before the prompt? Prints the rate and a sample to review.
//
//   node bench/xsession-audit.mts [--sample 20] [--seed 7]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { crossSessionRecall, transcriptMessages, type OtherSession } from '../plugin/hooks/xsession.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1]! : d);
const SAMPLE = Number(opt('sample', '20'));
let seed = Number(opt('seed', '7'));
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const root = join(homedir(), '.claude', 'projects');

let prompts = 0, attached = 0;
const hits: string[] = [];
for (const d of readdirSync(root)) {
  if (/ab-100|amnesia-bench|scratchpad/i.test(d)) continue;
  const files = readdirSync(join(root, d)).filter((f) => f.endsWith('.jsonl') && statSync(join(root, d, f)).size > 20_000);
  if (files.length < 2) continue;
  const sessions: OtherSession[] = files.map((f) => ({ id: f.replace(/\.jsonl$/, ''), messages: transcriptMessages(readFileSync(join(root, d, f), 'utf8')) }));
  for (const s of sessions) {
    const others = sessions.filter((o) => o !== s);
    let own = '';
    const seen = new Set<string>();
    for (const m of s.messages) {
      if (m.role === 'user') {
        prompts++;
        const r = crossSessionRecall(m.text, others, own, { before: m.at, skip: seen });
        if (r) {
          attached++;
          for (const k of r.keys) seen.add(k);
          hits.push(`### ${d.slice(-30)} / ${s.id.slice(0, 8)}\nPROMPT: ${m.text.replace(/\s+/g, ' ').slice(0, 220)}\nATTACHED: ${r.text.split('\n\n').slice(1).join('\n  ').replace(/\s+/g, ' ').slice(0, 420)}`);
        }
      }
      own += '\n' + m.text;
    }
  }
}
console.log(`prompts ${prompts}; would carry other-session messages ${attached} (${((100 * attached) / Math.max(1, prompts)).toFixed(1)}%)\n`);
const sample = [...hits].sort(() => rnd() - 0.5).slice(0, SAMPLE);
console.log(sample.join('\n\n'));
