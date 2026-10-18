import { test, expect } from 'claude-code/testing';
import type { On, SessionMessage } from 'claude-code';
import { parsePicks, rerankPrompt } from '../hooks/specifics.ts';

const msg = (role: 'user' | 'assistant', text: string, handle: string): SessionMessage => ({ role, text, toolUses: [], handle });
// 40 services, each with its own port: plenty for a shortlist
const HISTORY: SessionMessage[] = [
  ...Array.from({ length: 40 }, (_, i) => msg('user', `For svc-${i}-api, the staging port is ${20000 + i}.`, `h${i}`)),
  msg('user', 'continue', 'z'),
];
const core = (on: On) =>
  on('session.compact', () => ({ messages: [msg('user', 'Summary: configured services; next, deploy svc-3-api.', 'S'), HISTORY.at(-1)!], tokensBefore: 9000, tokensAfter: 300 }));
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const blockOf = (r: { messages: readonly SessionMessage[] }) => r.messages.find((m) => m.text.startsWith('[amnesia]'))?.text ?? '';

test('the picks parse in order, each once, and stay in range', () => {
  expect(parsePicks('3, 1, 3, 99, 2 and 0', 4)).toEqual([2, 0, 1]);
  expect(parsePicks('none of them', 4)).toEqual([]);
  const p = rerankPrompt([{ s: 'a = 1', context: '' }, { s: 'b', context: 'the b value' }], 'WIP');
  expect(p).toContain('1. a = 1');
  expect(p).toContain('2. b  (the b value)');
  expect(p).toContain('--- WORK IN PROGRESS ---\nWIP');
});

test("the reranker's picks lead the block", async ($, on) => {
  core(on);
  const asked: string[] = [];
  on('model.complete', (_$, e) => {
    asked.push(String(e.prompt));
    // pick whatever the prompt numbered for svc-3-api
    const n = /^(\d+)\. [^\n]*svc-3-api\b/m.exec(String(e.prompt))![1]!;
    return { value: { isAnswered: true, text: n, usage } };
  });
  const r = await $.session.compact({ trigger: 'auto', messages: HISTORY });
  if (r.skip !== undefined) throw new Error('skipped');
  expect(asked.length).toBe(1);
  expect(asked[0]).toContain('next, deploy svc-3-api');
  // and the person's last two requests, which the summary replaced
  expect(asked[0]).toContain("The person's latest requests:\nFor svc-38-api, the staging port is 20038.\nFor svc-39-api");
  const first = blockOf(r).split('\n').find((l) => l.startsWith('- '));
  expect(first).toContain('svc-3-api');
});

test('when the model call fails, the block is the learned order', async ($, on) => {
  core(on);
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } }) as never);
  const r = await $.session.compact({ trigger: 'auto', messages: HISTORY });
  if (r.skip !== undefined) throw new Error('skipped');
  expect(blockOf(r)).toContain('svc-');
});

test('rerank: false asks no model', { options: { rerank: false } }, async ($, on) => {
  core(on);
  let calls = 0;
  on('model.complete', () => { calls++; return { value: { isAnswered: true, text: '1', usage } }; });
  const r = await $.session.compact({ trigger: 'auto', messages: HISTORY });
  if (r.skip !== undefined) throw new Error('skipped');
  expect(calls).toBe(0);
  expect(blockOf(r)).toContain('svc-');
});
