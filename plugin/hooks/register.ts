import type { Register } from 'claude-code';
import { specificsBlock, type Msg } from './specifics.ts';

// userConfig budgetChars (plugin.json declares the default and range)
const budgetOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(40000, Math.max(1000, v)) : 6000);

const keyOf = (m: Msg) => m.handle ?? `${m.role}\u0000${m.text}`;

export const register: Register = (on, options) => {
  const budget = budgetOf(options?.budgetChars);
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) return next(e);

    const done = await next(e);
    if (done.skip !== undefined) return done;

    const inKeys = new Set(e.messages.map(keyOf));
    const outKeys = new Set(done.messages.map(keyOf));
    const dropped = e.messages.filter((m) => !outKeys.has(keyOf(m)));
    const fresh = done.messages.map((m, i) => (inKeys.has(keyOf(m)) ? -1 : i)).filter((i) => i >= 0);
    if (dropped.length === 0 || fresh.length === 0) return done;

    // what is still in context: the summary, and the messages kept verbatim beside it
    const kept = done.messages.filter((m) => inKeys.has(keyOf(m)));
    const inContext = [
      ...fresh.map((i) => done.messages[i]?.text ?? ''),
      ...kept.flatMap((m) => [
        m.text,
        ...m.toolUses.flatMap((u) => [JSON.stringify(u.input ?? {}), u.text ?? '']),
        ...(m.toolResults ?? []).map((r) => r.text ?? ''),
      ]),
    ].join('\n');
    const block = specificsBlock(dropped, inContext, budget);
    if (!block) return done;

    const messages = [...done.messages];
    const after = fresh[fresh.length - 1] ?? 0;
    messages.splice(after + 1, 0, { role: 'user', text: block.text, toolUses: [] });
    const { tokensAfter: _stale, ...rest } = done;
    $.ui.status(`amnesia: kept ${block.included} dropped detail(s)`);
    return { ...rest, messages };
  }).catch(($, e, next) => next(e));
};
