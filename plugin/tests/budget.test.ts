import { test, expect } from 'claude-code/testing';
import type { SessionMessage } from 'claude-code';

// present at run time in the test host; not in the hooks environment's typings
declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown;

const m = (role: 'user' | 'assistant', text: string, handle: string): SessionMessage => ({ role, text, toolUses: [], handle });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const history = [m('user', 'set AMNESIA_SLOW_FLAG_77 in src/slow/path_file.ts', 'a'), m('user', 'continue', 'b')];

// amnesia (user tier) > slow-upper (builtin, 6 s then next) > test's on (6 s, answers)
test(
  '12 s beneath the plugin, no single hook over 10 s of its own',
  {
    timeoutMs: 40_000,
    plugins: [
      {
        name: 'slow-upper',
        tier: 'builtin',
        register: (on) => {
          on('session.compact', async ($, e, next) => {
            await new Promise((r) => setTimeout(r, 6_000));
            return next(e);
          });
        },
      },
    ],
  },
  async ($, on) => {
    const started = Date.now();
    on('session.compact', async () => {
      await sleep(6_000);
      return { messages: [m('user', 'Summary: did a thing.', 'S'), history[1]!], tokensBefore: 10, tokensAfter: 5 };
    });
    const r = await $.session.compact({ trigger: 'auto', messages: history });
    const took = Date.now() - started;
    if (r.skip !== undefined) throw new Error('skipped');
    expect({ slow: took > 11_000, len: r.messages.length }).toEqual({ slow: true, len: 3 });
    expect(r.messages[1]?.text ?? '').toContain('AMNESIA_SLOW_FLAG_77');
  },
);
