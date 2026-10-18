import { test, expect } from 'claude-code/testing';
import type { SessionMessage } from 'claude-code';

const msg = (role: 'user' | 'assistant', text: string, handle: string, toolUses: SessionMessage['toolUses'] = []): SessionMessage =>
  ({ role, text, toolUses, handle });

const HISTORY: SessionMessage[] = [
  msg('user', 'Pin the dataset to dataset-identity v2.4.1 and move temperature into src/runtime/config.ts', 'h1'),
  msg('assistant', 'Done. arm.config now overrides config.temperature per run; see src/runtime/config.ts', 'h2', [
    { tool_use_id: 't1', tool: 'Edit', input: { file_path: 'C:/proj/src/runtime/config.ts' }, text: 'ok' },
  ]),
  msg('user', 'Also set MAX_RETRY_COUNT=3 and never touch legacy_loader', 'h3'),
  msg('assistant', 'Set MAX_RETRY_COUNT in .env.local.', 'h4'),
  msg('user', 'continue', 'h5'),
];

const at = (xs: readonly SessionMessage[], i: number): SessionMessage => {
  const m = xs[i];
  if (!m) throw new Error(`no message at ${i} of ${xs.length}`);
  return m;
};

const SUMMARY =msg('user', 'Summary: user is tuning a runtime config. Set retries. Kept legacy code alone.', 'S');

const core = (summary: SessionMessage, kept: readonly SessionMessage[]) => () => ({
  messages: [summary, ...kept],
  tokensBefore: 120000,
  tokensAfter: 3000,
});

test('appends the specifics the summary dropped, right after the summary', async ($, on) => {
  on('session.compact', core(SUMMARY, HISTORY.slice(-1)));
  const r = await $.session.compact({ trigger: 'manual', messages: HISTORY });
  if (r.skip !== undefined) throw new Error('skipped: ' + r.skip);
  expect(r.messages.length).toBe(3);
  expect(at(r.messages, 0).text).toBe(SUMMARY.text);
  const block = at(r.messages, 1);
  expect(block.role).toBe('user');
  expect(block.text.startsWith('[amnesia]')).toBe(true);
  for (const s of ['src/runtime/config.ts', 'config.temperature', 'MAX_RETRY_COUNT', 'legacy_loader', 'v2.4.1']) {
    expect(block.text).toContain(s);
  }
  expect(block.text).toContain('do not redo actions');
  expect(at(r.messages, 2).text).toBe('continue');
});

test('leaves out strings the summary already has', async ($, on) => {
  const full = msg('user', 'Summary: src/runtime/config.ts, config.temperature, arm.config, MAX_RETRY_COUNT=3, legacy_loader, dataset-identity v2.4.1, .env.local, C:/proj/src/runtime/config.ts', 'S2');
  on('session.compact', core(full, HISTORY.slice(-1)));
  const r = await $.session.compact({ trigger: 'auto', messages: HISTORY });
  if (r.skip !== undefined) throw new Error('skipped');
  expect(r.messages.length).toBe(2);
  expect(at(r.messages, 0).text).toBe(full.text);
});

test('precompute gets no block: its result is kept for the next compaction', async ($, on) => {
  on('session.compact', core(SUMMARY, HISTORY.slice(-1)));
  const r = await $.session.compact({ trigger: 'precompute', messages: HISTORY });
  if (r.skip !== undefined) throw new Error('skipped');
  expect(r.messages.length).toBe(2);
});

test("a subagent's compaction passes through untouched", async ($, on) => {
  on('session.compact', core(SUMMARY, HISTORY.slice(-1)));
  const r = await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: HISTORY });
  if (r.skip !== undefined) throw new Error('skipped');
  expect(r.messages.length).toBe(2);
});

test("core's skip is handed up as is", async ($, on) => {
  on('session.compact', () => ({ skip: 'blocked by a PreCompact hook' }));
  const r = await $.session.compact({ trigger: 'manual', messages: HISTORY });
  expect(r.skip).toBe('blocked by a PreCompact hook');
});

test('the block stays within its budget on a huge history', async ($, on) => {
  const big: SessionMessage[] = [];
  for (let i = 0; i < 400; i++) {
    big.push(msg('user', `edit src/module_${i}/file_${i}.ts and set FLAG_NUMBER_${i} to v1.${i}.0`, `b${i}`));
  }
  on('session.compact', core(SUMMARY, []));
  const r = await $.session.compact({ trigger: 'auto', messages: big });
  if (r.skip !== undefined) throw new Error('skipped');
  const block = at(r.messages, 1).text;
  expect(block.length <= 6000).toBe(true);
  expect(block).toContain('module_399');
});

test("an earlier block's items carry forward, its header and context do not", async ($, on) => {
  const earlier = '[amnesia] Exact details the summary above dropped.\n- old/carried/path_9.ts — "set in the first window"';
  const withBlock = [msg('user', earlier, 'a0'), ...HISTORY];
  on('session.compact', core(SUMMARY, HISTORY.slice(-1)));
  const r = await $.session.compact({ trigger: 'auto', messages: withBlock });
  if (r.skip !== undefined) throw new Error('skipped');
  const block = at(r.messages, 1).text;
  expect(block).toContain('old/carried/path_9.ts');
  expect(block.includes('set in the first window')).toBe(false);
  expect(block.split('[amnesia]').length).toBe(2);
});

test('prose with slashes is not taken for a path', async ($, on) => {
  const h = [msg('user', 'check the deploy/infra notes and messages/PRs/notes, then edit ./scripts/run_all.sh', 'p1'), msg('user', 'continue', 'p2')];
  on('session.compact', core(SUMMARY, h.slice(-1)));
  const r = await $.session.compact({ trigger: 'auto', messages: h });
  if (r.skip !== undefined) throw new Error('skipped');
  const block = at(r.messages, 1).text;
  expect(block).toContain('./scripts/run_all.sh');
  expect(block.includes('- deploy/infra')).toBe(false);
  expect(block.includes('- messages/PRs/notes')).toBe(false);
});

test('a configured budget (userConfig budgetChars) sizes the block', { options: { budgetChars: 12000 } }, async ($, on) => {
  const big: SessionMessage[] = [];
  for (let i = 0; i < 400; i++) {
    big.push(msg('user', `edit src/module_${i}/file_${i}.ts and set FLAG_NUMBER_${i} to v1.${i}.0`, `b${i}`));
  }
  on('session.compact', core(SUMMARY, []));
  const r = await $.session.compact({ trigger: 'auto', messages: big });
  if (r.skip !== undefined) throw new Error('skipped');
  const block = at(r.messages, 1).text;
  expect(block.length > 6000).toBe(true);
  expect(block.length <= 12000).toBe(true);
});

test('details still in the messages core kept verbatim are not repeated', async ($, on) => {
  const keptMsg = msg('assistant', 'Pinned the build to commit 4e9b1c27d and set MAX_RETRY_COUNT=3.', 'k1');
  const history = [msg('user', 'Pin the build to commit 4e9b1c27d and set MAX_RETRY_COUNT=3; ticket OPS-77412.', 'h1'), keptMsg];
  on('session.compact', core(SUMMARY, [keptMsg]));
  const r = await $.session.compact({ trigger: 'auto', messages: history });
  if (r.skip !== undefined) throw new Error('skipped');
  const block = at(r.messages, 1).text;
  expect(block).toContain('OPS-77412');
  expect(block.includes('4e9b1c27d')).toBe(false);
});
