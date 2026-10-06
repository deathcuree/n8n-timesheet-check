const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildLlmPayload, checkLlmReply, restoreNames } = require('../src/llmSummary.js');

const exception = (type, day, userId, person, detail) => ({
  key: `${type}|${userId}|${day}`,
  type,
  day,
  userId,
  person,
  email: userId ? `${person.split(' ')[0].toLowerCase()}@example.com` : '',
  detail,
});

const EXCEPTIONS = [
  exception('long_shift', '2026-10-06', 'u-ana', 'Ana Cruz', 'Worked 12.5 hours (limit 10)'),
  exception('no_entry', '2026-10-06', 'u-cora', 'Cora Lim', 'No time entry and no full-day PTO (4 approved PTO hours)'),
  exception('pto_pending', '2026-10-20', 'u-ana', 'Ana Cruz', 'Pending since 2026-10-01 for PTO on 2026-10-20 (8 hours)'),
  exception('missed_clock_out', '2026-10-06', 'u-dan', 'Dan Santos', 'Clocked in at 09:15 and never clocked out'),
  { ...exception('no_entries_at_all', '2026-10-05', null, '', 'Nobody has a time entry on this workday'), key: 'no_entries_at_all|2026-10-05' },
];

test('the payload holds only placeholders, exception types and days', () => {
  const { items } = buildLlmPayload(EXCEPTIONS);

  assert.deepEqual(items, [
    { placeholder: 'Person 1', type: 'long_shift', day: '2026-10-06' },
    { placeholder: 'Person 2', type: 'no_entry', day: '2026-10-06' },
    { placeholder: 'Person 1', type: 'pto_pending', day: '2026-10-20' },
    { placeholder: 'Person 3', type: 'missed_clock_out', day: '2026-10-06' },
    { placeholder: null, type: 'no_entries_at_all', day: '2026-10-05' },
  ]);
});

test('nothing sent to the model contains a name, email, hours, clock time or id', () => {
  const sent = JSON.stringify(buildLlmPayload(EXCEPTIONS).items);

  for (const secret of ['Ana', 'Cruz', 'Cora', 'Dan', 'Santos', '@', 'example.com', '12.5', '09:15', 'approved', 'u-ana', 'u-dan']) {
    assert.equal(sent.includes(secret), false, `payload leaks "${secret}"`);
  }
});

test('the same person keeps one placeholder, and the names are kept aside for later', () => {
  const { names } = buildLlmPayload(EXCEPTIONS);

  assert.deepEqual(names, { 'Person 1': 'Ana Cruz', 'Person 2': 'Cora Lim', 'Person 3': 'Dan Santos' });
});

test('an empty exception list gives an empty payload', () => {
  assert.deepEqual(buildLlmPayload([]), { items: [], names: {} });
});

test('a normal reply is accepted', () => {
  const { names } = buildLlmPayload(EXCEPTIONS);
  const reply = 'Person 1 worked a very long shift and has a PTO request waiting. Person 3 did not clock out.';

  assert.deepEqual(checkLlmReply(reply, names), { ok: true });
});

test('an empty or missing reply is rejected', () => {
  const { names } = buildLlmPayload(EXCEPTIONS);

  for (const reply of ['', '   \n ', undefined, null, { text: 'hello' }]) {
    const result = checkLlmReply(reply, names);
    assert.equal(result.ok, false);
    assert.match(result.reason, /empty/);
  }
});

test('a reply longer than 1,500 characters is rejected', () => {
  const { names } = buildLlmPayload(EXCEPTIONS);

  assert.equal(checkLlmReply('a'.repeat(1500), names).ok, true);
  const result = checkLlmReply('a'.repeat(1501), names);
  assert.equal(result.ok, false);
  assert.match(result.reason, /1500/);
});

test('a reply that mentions a placeholder that was never sent is rejected', () => {
  const { names } = buildLlmPayload(EXCEPTIONS);

  const result = checkLlmReply('Person 1 and Person 7 both had long shifts.', names);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Person 7/);
});

test('names are put back into the reply', () => {
  const { names } = buildLlmPayload(EXCEPTIONS);

  assert.equal(
    restoreNames('Person 1 worked a long shift. Person 3 did not clock out, and Person 1 has PTO waiting.', names),
    'Ana Cruz worked a long shift. Dan Santos did not clock out, and Ana Cruz has PTO waiting.',
  );
});

test('Person 1 is not confused with Person 10', () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    exception('no_entry', '2026-10-06', `u-${i + 1}`, `Staff Number${i + 1}`, 'No time entry and no full-day PTO'),
  );
  const { names } = buildLlmPayload(many);

  assert.equal(restoreNames('Person 10 and Person 1 are missing.', names), 'Staff Number10 and Staff Number1 are missing.');
  assert.deepEqual(checkLlmReply('Person 10 and Person 1 are missing.', names), { ok: true });
});
