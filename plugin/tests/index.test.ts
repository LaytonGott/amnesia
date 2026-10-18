import { test, expect } from 'claude-code/testing';
import type { On, SessionMessage } from 'claude-code';
import { INDEX_LEAD, labelOf, specificsBlock, type Msg } from '../hooks/specifics.ts';

const user = (text: string): Msg => ({ role: 'user', text, toolUses: [] });
const indexOf = (text: string | undefined) => (text ?? '').split('\n').find((l) => l.startsWith(INDEX_LEAD)) ?? null;

// 40 services, two values each: far more than a 1,000-char block holds
const MANY = Array.from({ length: 40 }, (_, i) =>
  user(`For svc-${i}-billing, the staging port is ${20000 + i * 7}. For svc-${i}-billing, the pinned commit is ${(0xabc0000 + i * 4099).toString(16)}9.`),
);

test('when everything fits, no index line is added', () => {
  const r = specificsBlock([user('For acme-billing, the staging port is 29860.')], '', 6000, true, true);
  expect(r?.text).toContain('29860');
  expect(indexOf(r?.text)).toBe(null);
  expect(r?.indexed).toBe(0);
});

test('when more is missing than fits, the rest is named without its values', () => {
  const r = specificsBlock(MANY, '', 1000, true, true);
  expect(r).not.toBe(null);
  expect(r!.text.length <= 1000).toBe(true);
  const line = indexOf(r?.text);
  expect(line).not.toBe(null);
  expect(r!.indexed > 0).toBe(true);
  expect(line).toMatch(/svc-\d+-billing \((?:staging port|pinned commit)/);
  expect(line).toMatch(/and \d+ more\.$/);
  // names only: no port number or commit from the index's own entries
  for (const m of MANY.slice(30)) {
    const port = m.text.match(/port is (\d+)/)![1]!;
    expect(line!.includes(port)).toBe(false);
  }
});

test('the index is off unless asked for', () => {
  const r = specificsBlock(MANY, '', 1000, true);
  expect(indexOf(r?.text)).toBe(null);
  expect(r?.indexed).toBe(0);
});

test('values keep most of the budget, and the index uses what is left', () => {
  const plain = specificsBlock(MANY, '', 2000, true, false)!;
  const withIndex = specificsBlock(MANY, '', 2000, true, true)!;
  expect(withIndex.included < plain.included).toBe(true);
  expect(withIndex.included > 0).toBe(true);
  expect(withIndex.text.length <= 2000).toBe(true);
});

test('labels name a detail by what it is', () => {
  expect(labelOf({ s: 'For brisk-payouts, the pinned SDK version is 5.13.1', kind: 'setting', probe: ['5.13.1'], context: '' }))
    .toEqual({ owner: 'brisk-payouts', what: 'pinned SDK version' });
  expect(labelOf({ s: 'settlement_retry_timeout_ms = 7350', kind: 'setting', probe: ['settlement_retry_timeout_ms', '7350'], context: '' }))
    .toEqual({ what: 'settlement_retry_timeout_ms' });
  expect(labelOf({ s: '4e9b1c27d', kind: 'hash', context: 'Pin the release to commit 4e9b1c27d.' })).toBe(null);
  expect(labelOf({ s: '4e9b1c27d', kind: 'hash', context: 'Pin the release to commit 4e9b1c27d.' }, { words: true })).toEqual({ what: 'the release to commit' });
  expect(labelOf({ s: 'status.example', kind: 'dotted', context: 'The incident status page is https://status.example-ledger.io/incidents/5519' })).toBe(null);
  expect(labelOf({ s: 'src/runtime/config.ts', kind: 'path', context: 'see src/runtime/config.ts' })).toEqual({ what: 'src/runtime/config.ts' });
});

test("an earlier block's index line is not carried forward as a detail", () => {
  const earlier = specificsBlock(MANY, '', 1000, true, true)!.text;
  const r = specificsBlock([{ role: 'user', text: earlier, toolUses: [] }], '', 40000, true, true);
  expect((r?.text ?? '').includes('Also dropped (look up')).toBe(false);
});

const msg = (role: 'user' | 'assistant', text: string, handle: string): SessionMessage => ({ role, text, toolUses: [], handle });
const HISTORY = [...MANY.map((m, i) => msg('user', m.text, `h${i}`)), msg('user', 'continue', 'last')];
const compactWith = (on: On) =>
  on('session.compact', () => ({ messages: [msg('user', 'Summary: services were configured.', 'S'), HISTORY.at(-1)!], tokensBefore: 9000, tokensAfter: 300 }));

test('the plugin adds the index by default', { options: { budgetChars: 1000 } }, async ($, on) => {
  compactWith(on);
  const r = await $.session.compact({ trigger: 'auto', messages: HISTORY });
  if (r.skip !== undefined) throw new Error('skipped');
  expect(r.messages.some((m) => m.text.includes(INDEX_LEAD))).toBe(true);
});

test('lossIndex: false leaves values only', { options: { budgetChars: 1000, lossIndex: false } }, async ($, on) => {
  compactWith(on);
  const r = await $.session.compact({ trigger: 'auto', messages: HISTORY });
  if (r.skip !== undefined) throw new Error('skipped');
  expect(r.messages.some((m) => m.text.includes(INDEX_LEAD))).toBe(false);
  expect(r.messages.some((m) => m.text.startsWith('[amnesia]'))).toBe(true);
});
