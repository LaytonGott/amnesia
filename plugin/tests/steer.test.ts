import { test, expect } from 'claude-code/testing';
import type { On, SessionMessage } from 'claude-code';
import { STEER_LEAD, steerText, withSteer, type Msg } from '../hooks/specifics.ts';

const user = (text: string): Msg => ({ role: 'user', text, toolUses: [] });
const msg = (role: 'user' | 'assistant', text: string, handle: string): SessionMessage => ({ role, text, toolUses: [], handle });

const HISTORY: SessionMessage[] = [
  msg('user', 'Pin the release to commit 4e9b1c27d. For acme-billing, the staging port is 29860.', 'h1'),
  msg('assistant', 'Noted. I read src/runtime/config.ts and set `retry_timeout_ms` = 7350.', 'h2'),
  msg('user', 'continue', 'h3'),
];

// a core that records what the summarizer was told
function core(on: On, seen: (string | undefined)[]) {
  on('session.compact', (_$, e) => {
    seen.push(e.instructions);
    return { messages: [msg('user', 'Summary: release work.', 'S'), HISTORY.at(-1)!], tokensBefore: 9000, tokensAfter: 300 };
  });
}

test('the must-keep list holds values with what they belong to, and not names', () => {
  const r = steerText([user('Pin the release to commit 4e9b1c27d. For acme-billing, the staging port is 29860. See src/runtime/config.ts')], 2000);
  expect(r).not.toBe(null);
  expect(r!.text.startsWith(STEER_LEAD)).toBe(true);
  expect(r!.text).toContain('For acme-billing, the staging port is 29860');
  expect(r!.text).toContain('release to commit: 4e9b1c27d');
  expect(r!.text.includes('src/runtime/config.ts')).toBe(false);
});

test('the must-keep list stays within its budget', () => {
  const many = Array.from({ length: 80 }, (_, i) => user(`For svc-${i}-api, the staging port is ${20000 + i}.`));
  const r = steerText(many, 2000)!;
  expect(r.text.length <= 2000).toBe(true);
  expect(r.items > 10).toBe(true);
  expect(r.items < 80).toBe(true);
});

test('tool output alone is never put on the list', () => {
  const r = steerText([{ role: 'assistant', text: 'ran it', toolUses: [{ tool: 'Bash', input: { command: 'env' }, text: 'DB_PORT=5432\nDB_PORT=5432' }] }], 2000);
  expect(r).toBe(null);
});

test("the person's own /compact instructions come first and stay whole", () => {
  expect(withSteer('focus on the migration', 'LIST')).toBe('focus on the migration\n\nLIST');
  expect(withSteer(undefined, 'LIST')).toBe('LIST');
  expect(withSteer('   ', 'LIST')).toBe('LIST');
});

test('an auto compaction tells the summarizer what to keep', async ($, on) => {
  const seen: (string | undefined)[] = [];
  core(on, seen);
  await $.session.compact({ trigger: 'auto', messages: HISTORY });
  expect(seen.length).toBe(1);
  expect(seen[0]).toContain(STEER_LEAD);
  expect(seen[0]).toContain('4e9b1c27d');
});

test('a manual compaction keeps the instructions typed after /compact', async ($, on) => {
  const seen: (string | undefined)[] = [];
  core(on, seen);
  await $.session.compact({ trigger: 'manual', instructions: 'focus on billing', messages: HISTORY });
  expect(seen[0]!.startsWith('focus on billing\n\n')).toBe(true);
  expect(seen[0]).toContain('29860');
});

test('a precompute is steered, and the compaction that uses it is told the same', async ($, on) => {
  const seen: (string | undefined)[] = [];
  core(on, seen);
  await $.session.compact({ trigger: 'precompute', messages: HISTORY.slice(0, 2) });
  // by the real compaction the conversation has grown: the list stays the precompute's
  await $.session.compact({ trigger: 'auto', messages: [...HISTORY, msg('user', 'For acme-billing, the tracking ticket is OPS-96797.', 'h4')] });
  expect(seen.length).toBe(2);
  expect(seen[0]).toContain(STEER_LEAD);
  expect(seen[1]).toBe(seen[0]);
});

test('steer: false leaves the instructions as they were', { options: { steer: false } }, async ($, on) => {
  const seen: (string | undefined)[] = [];
  core(on, seen);
  await $.session.compact({ trigger: 'auto', messages: HISTORY });
  await $.session.compact({ trigger: 'manual', instructions: 'focus on billing', messages: HISTORY });
  expect(seen).toEqual([undefined, 'focus on billing']);
});

test("a subagent's compaction is not steered", async ($, on) => {
  const seen: (string | undefined)[] = [];
  core(on, seen);
  await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: HISTORY });
  expect(seen).toEqual([undefined]);
});
