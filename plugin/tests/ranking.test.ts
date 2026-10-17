import { test, expect } from 'claude-code/testing';
import { specificsBlock, type Msg } from '../hooks/specifics.ts';

const user = (text: string): Msg => ({ role: 'user', text, toolUses: [] });
const asst = (text: string, toolUses: Msg['toolUses'] = []): Msg => ({ role: 'assistant', text, toolUses });
const items = (block: string | undefined) =>
  (block ?? '').split('\n').slice(1).map((l) => l.replace(/^- /, '').split(' — "')[0]);
const TIGHT = 330;

const idents = Array.from({ length: 30 }, (_, i) => `fieldName${i}Value`).join(' ');

test('a commit hash outranks code identifiers from the same message', () => {
  const r = specificsBlock([user(`${idents} and pin the build to commit 7f3c2a91e`)], '', TIGHT);
  expect(items(r?.text)[0]).toBe('7f3c2a91e');
});

test("the person's words outrank tool output of a higher kind", () => {
  const r = specificsBlock(
    [
      user('rename it to settings_loader please'),
      asst('ran it', [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'git log -1' }, text: 'commit a1b2c3d4e5\ncommit a1b2c3d4e5' }]),
    ],
    '',
    TIGHT,
  );
  expect(items(r?.text)[0]).toBe('settings_loader');
});

test('a path only ever seen in Read output ranks below one the agent wrote', () => {
  const r = specificsBlock(
    [
      asst('reading', [
        { tool_use_id: 'r1', tool: 'Read', input: { file_path: 'notes.txt' }, text: 'see src/only/in_read.ts and src/only/in_read.ts' },
      ]),
      asst('I changed src/agent/wrote_this.ts'),
    ],
    '',
    TIGHT,
  );
  const got = items(r?.text);
  expect(got.indexOf('src/agent/wrote_this.ts')).toBe(0);
  expect(got.indexOf('src/only/in_read.ts') === -1 || got.indexOf('src/only/in_read.ts') > 0).toBe(true);
});

test("a tool_result mirroring its tool use's text is counted once", () => {
  const out = 'wrote /tmp/once_only/report_9.txt';
  const r = specificsBlock(
    [
      asst('done', [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'make' }, text: out }]),
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b1', text: out }] },
    ],
    '',
    6000,
  );
  // one mention in tool traffic is dropped as noise; counted twice it would have passed
  expect((r?.text ?? '').includes('report_9.txt')).toBe(false);
});

test('an earlier summary and harness rows do not count as the person speaking', () => {
  const r = specificsBlock(
    [
      user('This session is being continued from a previous conversation. Summary: touched legacy_summary_name.'),
      user('<system-reminder>harness_reminder_name</system-reminder>'),
      user('also keep person_typed_name'),
    ],
    '',
    TIGHT,
  );
  expect(items(r?.text)[0]).toBe('person_typed_name');
});

test('hex runs inside a UUID are not taken for commits', () => {
  const r = specificsBlock([user('session 3f2b8c1d-9a4e-4b7f-8c2d-1e5f6a7b8c9d failed; commit 0ef02c3 fixed it')], '', 6000);
  const got = items(r?.text);
  expect(got.includes('0ef02c3')).toBe(true);
  expect(got.some((s) => s === '3f2b8c1d' || s === '1e5f6a7b8c9d')).toBe(false);
});
