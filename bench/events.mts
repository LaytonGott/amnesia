// Rebuilds, per compaction boundary in a Claude Code session file, the messages
// the compaction replaced, shaped as the engine hands them to a session.compact
// hook (assistant tool uses carry their result text). Shared by the offline
// audit and the A/B replay.
import { readFileSync } from 'node:fs';

export type Msg = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: { tool_use_id?: string; tool: string; input: Record<string, unknown>; text?: string }[];
  toolResults?: { tool_use_id?: string; text?: string }[];
};

export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'LS']);

export const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
      : '';

export type Event = {
  key: string;
  dropped: Msg[];
  prompts: string[];
  readOnly: (s: string) => boolean;
  summary: string;
};

export function eventsOf(path: string): Event[] {
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
