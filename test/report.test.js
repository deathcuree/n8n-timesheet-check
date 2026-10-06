const { test } = require('node:test');
const assert = require('node:assert/strict');
const { markReported, sheetRows, runRow, buildEmail } = require('../src/report.js');
const { lastCoveredDay } = require('../src/daysToCheck.js');

const exception = (type, day, userId, person, detail) => ({
  key: type === 'no_entries_at_all' ? `${type}|${day}` : `${type}|${userId}|${day}`,
  type,
  day,
  userId,
  person,
  email: userId ? `${person.split(' ')[0].toLowerCase()}@example.com` : '',
  detail,
});

const LONG_SHIFT = exception('long_shift', '2026-10-02', 'u-ana', 'Ana Cruz', 'Worked 12.5 hours (limit 10)');
const MISSED = exception('missed_clock_out', '2026-10-02', 'u-dan', 'Dan Santos', 'Clocked in at 09:00 and never clocked out');
const NOBODY = exception('no_entries_at_all', '2026-10-01', null, '', 'Nobody has a time entry on this workday');
const DAYS = ['2026-10-01', '2026-10-02'];

test('the last covered day is the latest day in the run history', () => {
  const rows = [
    { run_at: '2026-09-30T00:00:05.000Z', days_covered: '2026-09-29', new_exceptions: 0, total_exceptions: 0 },
    { run_at: '2026-10-03T00:00:04.000Z', days_covered: '2026-09-30, 2026-10-01, 2026-10-02', new_exceptions: 4, total_exceptions: 5 },
  ];

  assert.equal(lastCoveredDay(rows), '2026-10-02');
});

test('an empty or unreadable run history gives no last covered day', () => {
  assert.equal(lastCoveredDay([]), null);
  assert.equal(lastCoveredDay([{}]), null);
  assert.equal(lastCoveredDay([{ run_at: 'x', days_covered: '' }]), null);
  assert.equal(lastCoveredDay([{ days_covered: 46300 }]), null);
});

test('exceptions already in the Sheet are marked as reported before', () => {
  const marked = markReported([LONG_SHIFT, MISSED, NOBODY], [MISSED.key, 'long_shift|u-zed|2026-09-01']);

  assert.deepEqual(
    marked.map((e) => [e.key, e.reportedBefore]),
    [
      [LONG_SHIFT.key, false],
      [MISSED.key, true],
      [NOBODY.key, false],
    ],
  );
  assert.equal(LONG_SHIFT.reportedBefore, undefined, 'the input is not changed');
});

test('only new exceptions become Sheet rows, in the Sheet column layout', () => {
  const marked = markReported([LONG_SHIFT, MISSED], [MISSED.key]);

  assert.deepEqual(sheetRows(marked, '2026-10-05T00:00:07.000Z'), [
    {
      key: 'long_shift|u-ana|2026-10-02',
      found_at: '2026-10-05T00:00:07.000Z',
      day: '2026-10-02',
      type: 'long_shift',
      person: 'Ana Cruz',
      email: 'ana@example.com',
      detail: 'Worked 12.5 hours (limit 10)',
    },
  ]);
});

test('a second run with the same exceptions produces no Sheet rows', () => {
  const firstRun = sheetRows(markReported([LONG_SHIFT, MISSED, NOBODY], []), '2026-10-05T00:00:07.000Z');
  const secondRun = sheetRows(markReported([LONG_SHIFT, MISSED, NOBODY], firstRun.map((row) => row.key)), '2026-10-05T00:05:00.000Z');

  assert.equal(firstRun.length, 3);
  assert.deepEqual(secondRun, []);
});

test('the run-history row records the time, the days covered and the counts', () => {
  const marked = markReported([LONG_SHIFT, MISSED, NOBODY], [MISSED.key]);

  assert.deepEqual(runRow('2026-10-05T00:00:07.000Z', DAYS, marked), {
    run_at: '2026-10-05T00:00:07.000Z',
    days_covered: '2026-10-01, 2026-10-02',
    new_exceptions: 2,
    total_exceptions: 3,
  });
});

test('the email names the days covered and lists every exception', () => {
  const { subject, html } = buildEmail({ days: DAYS, exceptions: markReported([LONG_SHIFT, MISSED], [MISSED.key]) });

  assert.match(subject, /2 exceptions/);
  assert.match(subject, /1 new/);
  assert.match(html, /2026-10-01/);
  assert.match(html, /2026-10-02/);
  assert.match(html, /Ana Cruz/);
  assert.match(html, /Worked 12\.5 hours \(limit 10\)/);
  assert.match(html, /Dan Santos/);
});

test('the email marks exceptions that were reported before, and only those', () => {
  const { html } = buildEmail({ days: DAYS, exceptions: markReported([LONG_SHIFT, MISSED], [MISSED.key]) });
  const rowFor = (name) => html.split('<tr').find((row) => row.includes(name));

  assert.match(rowFor('Dan Santos'), /reported before/i);
  assert.doesNotMatch(rowFor('Ana Cruz'), /reported before/i);
});

test('a day with no entries at all is called out in the subject and at the top', () => {
  const { subject, html } = buildEmail({ days: DAYS, exceptions: markReported([LONG_SHIFT, NOBODY], []) });

  assert.match(subject, /no entries/i);
  assert.match(subject, /2026-10-01/);
  assert.ok(html.indexOf('Nobody has a time entry') < html.indexOf('Ana Cruz'), 'the warning comes before the list');
});

test('with nothing found the email still goes out and says so', () => {
  const { subject, html } = buildEmail({ days: DAYS, exceptions: [] });

  assert.match(subject, /nothing to report/i);
  assert.match(html, /No exceptions/);
  assert.match(html, /2026-10-01/);
});

test('a valid summary appears above the list', () => {
  const { html } = buildEmail({
    days: DAYS,
    exceptions: markReported([LONG_SHIFT], []),
    summary: 'Ana Cruz worked a very long shift on Friday.',
  });

  assert.ok(html.indexOf('worked a very long shift on Friday') < html.indexOf('<table'), 'the summary comes before the table');
  assert.doesNotMatch(html, /summary was unavailable/i);
});

test('without a summary the email says it was unavailable and still has the list', () => {
  const { html } = buildEmail({
    days: DAYS,
    exceptions: markReported([LONG_SHIFT], []),
    summary: null,
    summaryProblem: 'The reply is empty',
  });

  assert.match(html, /summary was unavailable/i);
  assert.match(html, /The reply is empty/);
  assert.match(html, /Ana Cruz/);
});

test('names and details are escaped in the email', () => {
  const odd = exception('long_shift', '2026-10-02', 'u-x', 'Kim <b>Lee</b> & Co', 'Worked 11 hours (limit 10)');
  const { html } = buildEmail({ days: DAYS, exceptions: markReported([odd], []), summary: 'A <script> tag' });

  assert.match(html, /Kim &lt;b&gt;Lee&lt;\/b&gt; &amp; Co/);
  assert.doesNotMatch(html, /<script>/);
});
