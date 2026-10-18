// Offline audit of just-in-time recall on real sessions (no model calls).
// For every real compaction under ~/.claude/projects: rebuild what it replaced
// as the recall archive would hold it, then replay the prompts the person
// actually sent after it (up to the next compaction) through promptRecall.
// Reports how often a prompt would carry attached messages, with examples.
//
//   node bench/jit-audit.mts [--module <recall.ts>] [--examples 12]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eventsOf } from './events.mts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1]! : d);
const mod = await import(pathToFileURL(resolve(opt('module', new URL('../plugin/hooks/recall.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))).href);
const EXAMPLES = Number(opt('examples', '12'));
const root = join(homedir(), '.claude', 'projects');

// what a person typed: not a tool result, a reminder, a summary, a command or a plugin block
const typed = (o: any): string | null => {
  if (o?.type !== 'user' || o.isMeta || o.isCompactSummary) return null;
  const c = o.message?.content;
  if (Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')) return null;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '';
  const s = t.trim();
  if (!s || /^</.test(s) || s.startsWith('[amnesia]') || s.startsWith('This session is being continued')) return null;
  return s;
};

let events = 0, prompts = 0, attached = 0, snippets = 0;
const examples: string[] = [];
for (const d of readdirSync(root)) {
  if (/ab-100|amnesia-bench|scratchpad/i.test(d)) continue;
  for (const f of readdirSync(join(root, d))) {
    if (!f.endsWith('.jsonl')) continue;
    const p = join(root, d, f);
    if (statSync(p).size < 50_000) continue;
    let evs;
    try { evs = eventsOf(p); } catch { continue; }
    if (!evs.length) continue;
    const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const bounds = rows.map((o, i) => (o?.subtype === 'compact_boundary' ? i : -1)).filter((i) => i >= 0);
    for (const ev of evs) {
      const ts = ev.key.split('|')[0];
      const bi = bounds.find((i) => rows[i].timestamp === ts);
      if (bi === undefined) continue;
      const end = bounds.find((i) => i > bi) ?? rows.length;
      const at = Date.parse(ts!) || 0;
      const archive = mod.droppedFiles(ev.dropped, at).flat();
      const after = rows.slice(bi + 1, end).map(typed).filter((x): x is string => x !== null);
      if (!after.length) continue;
      events++;
      const seen = new Set<string>();
      for (const q of after) {
        prompts++;
        const r = mod.promptRecall(archive, q, { skip: seen });
        if (!r) continue;
        attached++;
        snippets += r.keys.length;
        for (const k of r.keys) seen.add(k);
        if (examples.length < EXAMPLES) {
          const first = r.text.split('\n\n')[1] ?? '';
          examples.push(`- ${f.slice(0, 8)} prompt: ${q.replace(/\s+/g, ' ').slice(0, 110)}\n    attached: ${first.replace(/^\[[^\]]*\] /, '').slice(0, 150)}`);
        }
      }
    }
  }
}
console.log(`compactions ${events}, prompts after them ${prompts}, prompts that would carry messages ${attached} (${((100 * attached) / Math.max(1, prompts)).toFixed(1)}%), messages attached ${snippets}`);
console.log(examples.join('\n'));
