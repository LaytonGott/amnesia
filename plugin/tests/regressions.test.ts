import { test, expect } from 'claude-code/testing';
import { specificsBlock, type Msg } from '../hooks/specifics.ts';

// Lines from a real ~968k-token auto-compaction (2026-10-17) whose block
// carried junk: each line below put one bad item in it.
const user = (text: string): Msg => ({ role: 'user', text, toolUses: [] });
const asst = (text: string, toolUses: Msg['toolUses'] = []): Msg => ({ role: 'assistant', text, toolUses });
const items = (block: string | undefined) =>
  (block ?? '').split('\n').slice(1).map((l) => l.replace(/^- /, '').split(' — "')[0] ?? '');
const WIDE = 40000;

test('a file:line reference is not a setting', () => {
  const got = items(specificsBlock([asst('- In `actions.mjs:261`, the target is `process.cwd()`, not the folder the session came from.')], '', WIDE)?.text);
  expect(got.some((s) => s.includes('actions.mjs = '))).toBe(false);
  expect(got).toContain('actions.mjs:261');
});

test('a scheme prefix is not a drive letter', () => {
  const got = items(specificsBlock([asst('`npx github:LaytonGott/amnesia` works and prints `amnesia 0.12.1`. Writing the new README.')], '', WIDE)?.text);
  expect(got.some((s) => s.startsWith('b:'))).toBe(false);
  expect(got).toContain('npx github:LaytonGott/amnesia');
});

test('markdown emphasis does not leak into a value', () => {
  const got = items(specificsBlock([asst('Biggest DROPPED: **f3d9f2e5** (layton-os worktree), 16 events, 15,438,614 dropped, 7m 41s dead.')], '', WIDE)?.text);
  expect(got.some((s) => s.includes('*'))).toBe(false);
  expect(got).toContain('f3d9f2e5');
});

test('code fragments are not details', () => {
  const got = items(
    specificsBlock(
      [
        asst("The chain stopped early: my sed didn't match the `\\u2014` escape, so the marker stayed.", [
          { tool_use_id: 'e1', tool: 'Edit', input: { new_string: "{ kind: 'code', re: /\\b(?=[A-Z0-9-]*\\d)[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\\b/g },\n    out.push(entry);" }, text: 'ok' },
        ]),
        asst('    $.ui.status?.(`amnesia: kept ${block.included} dropped detail(s)`);'),
        asst('      const dir = join(root, encodeProjectPath(process.cwd()));'),
      ],
      '',
      WIDE,
    )?.text,
  );
  for (const junk of ['\\u2014', 'A-Z0-9', 'out.push', 'ui.status', 'process.cwd']) expect(got).not.toContain(junk);
});

test('a hash inside a path is not a commit', () => {
  const got = items(
    specificsBlock(
      [
        asst('checking types', [
          { tool_use_id: 'b1', tool: 'Bash', input: { command: 'T="C:/Users/97lay/AppData/Local/Temp/claude/bundled-skills/2.1.299/1c0faf7d244142a1621d3a4138bccc37/plugin-authoring"; wc -l "$T/types/claude-code.d.ts"' }, text: '14000' },
        ]),
        user('and pin the build to commit 7f3c2a91e'),
      ],
      '',
      WIDE,
    )?.text,
  );
  expect(got).not.toContain('1c0faf7d244142a1621d3a4138bccc37');
  expect(got).toContain('7f3c2a91e');
});

test("hyphenated words in the agent's prose are not identifiers; the person's are", () => {
  const got = items(
    specificsBlock(
      [
        asst('210a6ea docs: real-data audit evidence; and colon-hex serials were never candidates.'),
        asst('  amnesia · compaction receipt for claude-code'),
        user('never touch legacy-loader'),
      ],
      '',
      WIDE,
    )?.text,
  );
  for (const junk of ['real-data', 'colon-hex', 'claude-code']) expect(got).not.toContain(junk);
  expect(got).toContain('legacy-loader');
  expect(got).toContain('210a6ea');
});

test('a string inside a longer chosen item is not listed again', () => {
  const got = items(
    specificsBlock(
      [
        asst('Plugin install takes `--marketplace`.'),
        asst('Run `/plugin install amnesia --marketplace LaytonGott/amnesia`.'),
        asst('The plugin is committed as fcaf2bc on feat/compact-plugin, branched from fix/audit-bugs.'),
      ],
      '',
      WIDE,
    )?.text,
  );
  expect(got).toContain('/plugin install amnesia --marketplace LaytonGott/amnesia');
  expect(got).not.toContain('--marketplace');
  expect(got).not.toContain('compact-plugin');
  expect(got).toContain('feat/compact-plugin');
});

test('a flag that is a prefix of a longer flag is still its own item', () => {
  const got = items(specificsBlock([asst('`--write` refuses unless you pass `--out`.'), asst('Run it with `--output-format json`.')], '', WIDE)?.text);
  expect(got).toContain('--out');
  expect(got).toContain('--output-format json');
});
