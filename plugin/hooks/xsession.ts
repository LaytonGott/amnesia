// Cross-session recall: what other sessions of the same project said about a
// name this session has never mentioned. Pure functions; register.ts reads the
// transcripts through $.fs.
import { promptTerms, windowOf } from './recall.ts';

export type SessionMsg = { at: number; role: 'user' | 'assistant'; text: string };
export type OtherSession = { id: string; messages: readonly SessionMsg[] };

export const XS_LEAD =
  "[amnesia] From other sessions in this project, verbatim (they may be out of date; this session's instructions win):";

// the wrappers Claude Code puts around pasted text, reminders and commands are no names
const HARNESS = new Set([
  'pasted_content', 'system-reminder', 'local-command-stdout', 'local-command-stderr', 'command-name',
  'command-message', 'command-args', 'user-prompt-submit-hook', 'task-notification',
]);

// strict: a digit, an underscore, a dotted name (file.ext, a.b) or a path; hyphenated
// words ("read-only", "end-to-end") are mostly English, so they never count here
export const strictName = (t: string) =>
  t.length >= 5 && /[a-z]/.test(t) && !HARNESS.has(t) && (/[0-9_]/.test(t) || /[a-z][.][a-z]/.test(t) || /[a-z][/][a-z]/.test(t));

const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.filter((b) => b && (b as { type?: unknown }).type === 'text').map((b) => String((b as { text?: unknown }).text ?? '')).join('\n')
      : '';

// what the person and the agent wrote in a transcript: no tool results,
// reminders, summaries, commands or amnesia's own blocks
export function transcriptMessages(jsonl: string): SessionMsg[] {
  const out: SessionMsg[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let o: { type?: string; isMeta?: boolean; isCompactSummary?: boolean; timestamp?: string; message?: { content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isMeta || o.isCompactSummary) continue;
    const c = o.message?.content;
    if (Array.isArray(c) && c.some((b) => b && (b as { type?: unknown }).type === 'tool_result')) continue;
    const text = textOf(c).trim();
    if (!text || text.startsWith('<') || text.startsWith('[amnesia]') || text.startsWith('This session is being continued')) continue;
    out.push({ at: Date.parse(o.timestamp ?? '') || 0, role: o.type, text: text.slice(0, 20_000) });
  }
  return out;
}

// The messages of other sessions that hold a strict name the prompt uses and
// this session never has. A name in more than 3 of their messages is common
// project vocabulary, not a pointer to one decision.
export function crossSessionRecall(
  prompt: string,
  others: readonly OtherSession[],
  own: string,
  { before = Infinity, maxSnippets = 2, width = 600, skip = new Set<string>() }: { before?: number; maxSnippets?: number; width?: number; skip?: ReadonlySet<string> } = {},
): { text: string; keys: string[] } | null {
  const ownL = own.toLowerCase();
  const names = promptTerms(prompt).filter((t) => strictName(t) && !ownL.includes(t));
  if (names.length === 0) return null;
  const pool = others.flatMap((s) => s.messages.filter((m) => m.at < before).map((m) => ({ ...m, id: s.id, low: m.text.toLowerCase() })));
  const df = new Map(names.map((n) => [n, pool.filter((m) => m.low.includes(n)).length]));
  // and in at most 2 other sessions: a name every session of a loop uses is the project's vocabulary
  const sessionsWith = (n: string) => new Set(pool.filter((m) => m.low.includes(n)).map((m) => m.id)).size;
  const keep = names.filter((n) => (df.get(n) ?? 0) >= 1 && (df.get(n) ?? 0) <= 3 && sessionsWith(n) <= 2);
  if (keep.length === 0) return null;
  const key = (m: { id: string; at: number }) => `${m.id}\u0000${m.at}`;
  const picked = pool
    .map((m) => ({ m, hit: keep.filter((n) => m.low.includes(n)) }))
    .filter((x) => x.hit.length > 0 && !skip.has(key(x.m)))
    .sort((a, b) => b.hit.length - a.hit.length || (a.m.role === 'user' ? -1 : 0) - (b.m.role === 'user' ? -1 : 0) || b.m.at - a.m.at)
    .slice(0, maxSnippets);
  if (picked.length === 0) return null;
  const entries = picked.map(({ m, hit }) => {
    const date = m.at ? new Date(m.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown date';
    return `[${m.role} in session ${m.id.slice(0, 8)}, ${date}] ${windowOf(m.text, hit, width)}`;
  });
  return { text: [XS_LEAD, ...entries].join('\n\n'), keys: picked.map(({ m }) => key(m)) };
}
