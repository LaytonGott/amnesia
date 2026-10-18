import { test, expect } from 'claude-code/testing';
import { specificsBlock, type Msg } from '../hooks/specifics.ts';

const user = (text: string): Msg => ({ role: 'user', text, toolUses: [] });
const asst = (text: string, toolUses: Msg['toolUses'] = []): Msg => ({ role: 'assistant', text, toolUses });
const items = (block: string | undefined) =>
  (block ?? '').split('\n').slice(1).map((l) => l.replace(/^- /, '').split(' — "')[0] ?? '');
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

test('a value the agent named in prose keeps its key, and counts as kept only with both', () => {
  const said = asst('`settlement_retry_timeout_ms` is 7350 and `chargeback_hold_days` is `41`.');
  const r = specificsBlock([said], 'Summary: settlement_retry_timeout_ms was looked up.', 6000);
  const got = items(r?.text);
  expect(got).toContain('settlement_retry_timeout_ms = 7350');
  expect(got).toContain('chargeback_hold_days = 41');
  // the line carries no context: key = value already says what it is
  expect((r?.text ?? '').includes('settlement_retry_timeout_ms = 7350 —')).toBe(false);
  const both = specificsBlock([said], 'settlement_retry_timeout_ms = 7350, chargeback_hold_days = 41', 6000);
  expect(items(both?.text).some((s) => s.startsWith('settlement_retry_timeout_ms'))).toBe(false);
});

test('tickets, error codes and colon-hex serials are captured', () => {
  const r = specificsBlock(
    [asst('Tracked in OPS-77412; the FATAL was E-LEDGER-4471 and the edge cert serial is 6A:3F:91:0C:5D.')],
    '',
    6000,
  );
  // each is carried, bare or inside the clause that names it
  const got = items(r?.text);
  for (const s of ['OPS-77412', 'E-LEDGER-4471', '6A:3F:91:0C:5D']) expect(got.some((i) => i.includes(s))).toBe(true);
});

test('a backticked bare name ranks as an identifier, below a commit', () => {
  const r = specificsBlock([asst('Added `created_at` and `item_key`; merged as `0ef02c3`.')], '', TIGHT);
  expect(items(r?.text)[0]).toBe('0ef02c3');
});

test('code defaults and type hints are not settings', () => {
  const r = specificsBlock([asst('`intervention_path` is `None`, `allow_quality` is `bool`, `max_cells` is `3`.')], '', 6000);
  const got = items(r?.text);
  expect(got.some((s) => s.startsWith('intervention_path ='))).toBe(false);
  expect(got.some((s) => s.startsWith('allow_quality ='))).toBe(false);
  expect(got).toContain('max_cells = 3');
});

test('an absolute path only passed to a tool ranks below what the person said', () => {
  const r = specificsBlock(
    [
      user('the incident is INC-20931'),
      asst('editing', [{ tool_use_id: 'e1', tool: 'Edit', input: { file_path: 'C:/work/repo/src/very/deep/module_a.ts' }, text: 'ok' }]),
      asst('editing', [{ tool_use_id: 'e2', tool: 'Edit', input: { file_path: 'C:/work/repo/src/very/deep/module_a.ts' }, text: 'ok' }]),
    ],
    '',
    TIGHT,
  );
  expect(items(r?.text)[0]).toContain('INC-20931');
});

test('a value stated in prose travels with the clause that names its owner', () => {
  const r = specificsBlock(
    [user('For cobalt-payouts, the staging port is 17448. For brisk-payouts, the pinned SDK version is 5.13.1.')],
    '',
    6000,
  );
  const got = items(r?.text);
  expect(got).toContain('For cobalt-payouts: the staging port is 17448');
  expect(got).toContain('For brisk-payouts: the pinned SDK version is 5.13.1');
  // the bare value is inside its clause, so it is not listed again
  expect(got.includes('5.13.1')).toBe(false);
});

test("the context snippet keeps the words before a value, from the start of its sentence", () => {
  const r = specificsBlock(
    [asst('Unrelated earlier sentence here. The edge-gateway certificate on the partner ingress has serial 6A:3F:91:0C:5D and expires soon.')],
    '',
    6000,
  );
  const line = (r?.text ?? '').split('\n').find((l) => l.startsWith('- 6A:3F:91:0C:5D')) ?? '';
  expect(line).toContain('The edge-gateway certificate on the partner ingress');
  expect(line.includes('Unrelated earlier sentence')).toBe(false);
});

test('prose without "the", ports and handles keep their owner', () => {
  const r = specificsBlock(
    [user('Staging API listens on port 18443. Our deploy region is ap-southeast-3b. On-call owner is @mkovacs-ledger.')],
    '',
    6000,
  );
  const got = items(r?.text);
  expect(got).toContain('Staging API listens on port 18443');
  expect(got).toContain('Our deploy region is ap-southeast-3b');
  expect(got).toContain('On-call owner is @mkovacs-ledger');
});

test('counts, estimates and markdown fragments are not settings', () => {
  const r = specificsBlock(
    [asst('There are 12 failures. It was 3 tries. The cache is ~15 MB. So the corpus is **2.4K** rows. Email bob@example.com.')],
    '',
    6000,
  );
  const got = items(r?.text);
  for (const bad of ['There are 12', 'It was 3', 'The cache is ~15', 'So the corpus is **2']) {
    expect(got.some((s) => s.startsWith(bad))).toBe(false);
  }
  expect(got.some((s) => s.startsWith('@example'))).toBe(false);
});

test('a value the agent reported competes with what the person typed on equal terms', () => {
  // two lines fit: the person's own clause and the agent's looked-up value, ahead of a person's plain path
  const r = specificsBlock(
    [
      user('For acme-billing, the staging port is 29860. Also see notes/run_log_7.md'),
      asst('`settlement_retry_timeout_ms` is 7350 (line 699 of services/billing/config.yaml).'),
    ],
    '',
    300,
  );
  const got = items(r?.text);
  expect(got).toContain('For acme-billing: the staging port is 29860');
  expect(got).toContain('settlement_retry_timeout_ms = 7350');
});

test('settings that share an owner share one line', () => {
  const r = specificsBlock(
    [user('For acme-billing, the staging port is 29860. For acme-billing, the tracking ticket is OPS-96797.')],
    '',
    6000,
  );
  const lines = (r?.text ?? '').split('\n').slice(1);
  expect(lines).toContain('- For acme-billing: the staging port is 29860; the tracking ticket is OPS-96797');
  expect(r?.included).toBe(2);
});

test('when only tool-seen details are missing, no block is added', () => {
  const r = specificsBlock(
    [
      asst('reading', [
        { tool_use_id: 'r1', tool: 'Read', input: { file_path: 'C:/work/repo/config/app.env' }, text: 'DB_POOL_SIZE=20\nDB_POOL_SIZE=20\nCACHE_TTL_SECONDS=90\nCACHE_TTL_SECONDS=90' },
      ]),
    ],
    '',
    6000,
  );
  expect(r).toBe(null);
});

// ---- learned from real sessions (bench/needed-later.mts) ----

test('a burst of one kind cannot take over the block', () => {
  const versions = Array.from({ length: 40 }, (_, i) => `${i}.${i + 1}.${i + 2}`).join(', ');
  const r = specificsBlock([asst(`Semver fixtures: ${versions}. The release is pinned to commit 7f3c2a91e.`)], '', 6000);
  const got = items(r?.text);
  expect(got.filter((s) => /^\d+\.\d+\.\d+$/.test(s)).length <= 12).toBe(true);
  expect(got).toContain('7f3c2a91e');
});

test('pieces of a URL are not details of their own', () => {
  const r = specificsBlock([asst('See https://stryker-mutator.io/docs/stryker-js/incremental/ and https://pypi.org/project/mutmut/ for prior art.')], '', 6000);
  const got = items(r?.text);
  expect(got.some((s) => s === 'mutator.io' || s === 'pypi.org' || s === 'stryker-js')).toBe(false);
  expect(got.some((s) => s.startsWith('https://stryker-mutator.io'))).toBe(true);
});

test('a setting the person stated outranks a file path the agent mentioned', () => {
  const r = specificsBlock([user('`retry_timeout_ms` is 7350.'), asst('I also looked at src/runtime/loader.ts.')], '', TIGHT);
  expect(items(r?.text)[0]).toBe('retry_timeout_ms = 7350');
});
