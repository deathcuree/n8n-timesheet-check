const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findExceptions } = require('../src/findExceptions.js');
const {
  NOW,
  MONDAY,
  TUESDAY,
  TODAY,
  ANA,
  BEN,
  CORA,
  DAN,
  ADMIN,
  READONLY,
  person,
  entry,
  pto,
  manilaMidnight,
} = require('./sampleData.js');

const STAFF = [ANA, BEN, CORA, DAN, ADMIN, READONLY];
const SATURDAY = '2026-10-03';

const run = (data, settings = {}, now = NOW) =>
  findExceptions(
    { daysToCheck: [TUESDAY], entries: [], openEntries: [], users: STAFF, ptoRequests: [], ...data },
    settings,
    now,
  );

// Everyone worked a normal day on Tuesday.
const normalTuesday = () => [ANA, BEN, CORA, DAN].map((u) => entry(u, TUESDAY));

const summary = (exceptions) => exceptions.map((e) => `${e.type} ${e.person} ${e.day}`.replace(/\s+/g, ' '));

test('one of each problem produces exactly those six exceptions', () => {
  const danOpen = entry(DAN, TUESDAY, { to: null, hours: 23.5 });
  const exceptions = run({
    daysToCheck: [MONDAY, TUESDAY],
    // Monday: nobody clocked in. Tuesday: Ana worked 12 h, Ben paused 2.5 h,
    // Cora has no entry, Dan never clocked out.
    entries: [
      entry(ANA, TUESDAY, { to: '21:00', hours: 12 }),
      entry(BEN, TUESDAY, { hours: 6, breakHours: 2.5 }),
      danOpen,
    ],
    openEntries: [danOpen],
    ptoRequests: [pto(ANA, '2026-10-20', { status: 'pending', createdAt: '2026-10-01T03:00:00.000Z' })],
  });

  assert.deepEqual(summary(exceptions).sort(), [
    'long_pause Ben Reyes 2026-10-06',
    'long_shift Ana Cruz 2026-10-06',
    'missed_clock_out Dan Santos 2026-10-06',
    'no_entries_at_all 2026-10-05',
    'no_entry Cora Lim 2026-10-06',
    'pto_pending Ana Cruz 2026-10-20',
  ]);
});

test('clean data produces no exceptions', () => {
  const exceptions = run({
    daysToCheck: [MONDAY, TUESDAY],
    entries: [...[ANA, BEN, CORA, DAN].map((u) => entry(u, MONDAY)), ...normalTuesday()],
    ptoRequests: [
      pto(ANA, '2026-10-20', { status: 'approved' }),
      pto(BEN, '2026-09-30', { status: 'denied' }),
      // Pending, but made yesterday for a future date.
      pto(CORA, '2026-10-21', { status: 'pending', createdAt: '2026-10-06T03:00:00.000Z' }),
    ],
  });

  assert.deepEqual(exceptions, []);
});

test('each exception carries a key, the person and a readable detail', () => {
  const [exception] = run({
    entries: [entry(ANA, TUESDAY, { to: '21:00', hours: 12 }), ...normalTuesday().slice(1)],
  });

  assert.deepEqual(exception, {
    key: 'long_shift|u-ana|2026-10-06',
    type: 'long_shift',
    day: '2026-10-06',
    userId: 'u-ana',
    person: 'Ana Cruz',
    email: 'ana@example.com',
    detail: 'Worked 12 hours (limit 10)',
  });
});

test('a shift or pause exactly at the limit is not flagged', () => {
  const exceptions = run({
    entries: [entry(ANA, TUESDAY, { hours: 10, breakHours: 2 }), ...normalTuesday().slice(1)],
  });

  assert.deepEqual(exceptions, []);
});

test('thresholds come from the settings', () => {
  const exceptions = run(
    { entries: [entry(ANA, TUESDAY, { hours: 9.5, breakHours: 1.75 }), ...normalTuesday().slice(1)] },
    { maxWorkedHours: 9, maxPauseHours: 1.5 },
  );

  assert.deepEqual(summary(exceptions).sort(), [
    'long_pause Ana Cruz 2026-10-06',
    'long_shift Ana Cruz 2026-10-06',
  ]);
});

test('an open entry from an earlier day raises only a missed clock-out, however long it has run', () => {
  const open = entry(DAN, TUESDAY, { to: null, hours: 23.5, breakHours: 9, status: 'paused' });
  const exceptions = run({ entries: [...normalTuesday().slice(0, 3), open], openEntries: [open] });

  assert.deepEqual(summary(exceptions), ['missed_clock_out Dan Santos 2026-10-06']);
  assert.equal(exceptions[0].key, 'missed_clock_out|u-dan|2026-10-06');
});

test('an open entry older than the days being checked is still a missed clock-out', () => {
  const old = entry(DAN, '2026-09-25', { to: null, hours: 280 });
  const exceptions = run({ entries: normalTuesday(), openEntries: [old] });

  assert.deepEqual(summary(exceptions), ['missed_clock_out Dan Santos 2026-09-25']);
});

test('an open entry dated today is not an exception', () => {
  const exceptions = run({ entries: normalTuesday(), openEntries: [entry(DAN, TODAY, { to: null, hours: 0.5 })] });

  assert.deepEqual(exceptions, []);
});

test('no entry is flagged only for expected staff on a workday', () => {
  const lateJoiner = person('u-eve', 'Eve', 'Tan', 'user', '2026-10-06T09:00:00.000Z');
  const exceptions = run(
    {
      // Saturday, Monday (listed as a holiday) and Tuesday.
      daysToCheck: [SATURDAY, MONDAY, TUESDAY],
      entries: [entry(ANA, MONDAY), entry(ANA, TUESDAY), entry(BEN, TUESDAY), entry(CORA, TUESDAY)],
      // Eve's account was created on Tuesday afternoon, after Monday.
      users: [...STAFF, lateJoiner],
    },
    { holidays: [MONDAY] },
  );

  // Dan and Eve are missing on Tuesday; Eve already had an account that day.
  // Nothing for Saturday, the holiday, the admin or the read-only account.
  assert.deepEqual(summary(exceptions).sort(), ['no_entry Dan Santos 2026-10-06', 'no_entry Eve Tan 2026-10-06']);
});

test('a person is not expected on a day before their account was created', () => {
  const joinsTuesday = person('u-eve', 'Eve', 'Tan', 'user', '2026-10-06T01:00:00.000Z');
  const exceptions = run({
    daysToCheck: [MONDAY, TUESDAY],
    entries: [...[ANA, BEN, CORA, DAN].map((u) => entry(u, MONDAY)), ...normalTuesday(), entry(joinsTuesday, TUESDAY)],
    users: [...STAFF, joinsTuesday],
  });

  assert.deepEqual(exceptions, []);
});

test('partial approved PTO still flags a missing entry and notes the hours', () => {
  const exceptions = run({
    entries: normalTuesday().slice(0, 3),
    ptoRequests: [pto(DAN, TUESDAY, { hours: 4 })],
  });

  assert.deepEqual(summary(exceptions), ['no_entry Dan Santos 2026-10-06']);
  assert.match(exceptions[0].detail, /4 approved PTO hours/);
});

test('a full day of approved PTO excuses a missing entry', () => {
  const exceptions = run({
    entries: normalTuesday().slice(0, 3),
    ptoRequests: [pto(DAN, TUESDAY, { hours: 8 })],
  });

  assert.deepEqual(exceptions, []);
});

test('pending or denied PTO does not excuse a missing entry', () => {
  const exceptions = run({
    entries: normalTuesday().slice(0, 2),
    ptoRequests: [
      pto(CORA, TUESDAY, { hours: 8, status: 'denied' }),
      pto(DAN, TUESDAY, { hours: 8, status: 'pending', createdAt: '2026-10-05T03:00:00.000Z' }),
    ],
  });

  // Dan's pending request is also flagged, because its date has passed.
  assert.deepEqual(summary(exceptions).sort(), [
    'no_entry Cora Lim 2026-10-06',
    'no_entry Dan Santos 2026-10-06',
    'pto_pending Dan Santos 2026-10-06',
  ]);
});

test('a PTO date stored as Manila midnight is read as the same day', () => {
  const localStyle = { ...pto(DAN, TUESDAY, { hours: 8 }), date: manilaMidnight(TUESDAY) };
  const exceptions = run({ entries: normalTuesday().slice(0, 3), ptoRequests: [localStyle] });

  assert.deepEqual(exceptions, []);
});

test('a workday with no entries at all is one exception, not one per person', () => {
  const exceptions = run({ daysToCheck: [MONDAY] });

  assert.deepEqual(
    exceptions.map((e) => ({ key: e.key, type: e.type, day: e.day, userId: e.userId, person: e.person })),
    [{ key: 'no_entries_at_all|2026-10-05', type: 'no_entries_at_all', day: MONDAY, userId: null, person: '' }],
  );
});

test('a weekend or holiday with no entries is not an exception', () => {
  const exceptions = run({ daysToCheck: [SATURDAY, '2026-10-04', MONDAY] }, { holidays: [MONDAY] });

  assert.deepEqual(exceptions, []);
});

test('pending PTO is flagged after three days, or once its date has passed', () => {
  const waitingTooLong = pto(ANA, '2026-10-20', { status: 'pending', createdAt: '2026-10-03T23:00:00.000Z' });
  const stillFresh = pto(BEN, '2026-10-21', { status: 'pending', createdAt: '2026-10-04T02:00:00.000Z' });
  const datePassed = pto(CORA, MONDAY, { status: 'pending', createdAt: '2026-10-05T12:00:00.000Z' });
  const forToday = pto(DAN, TODAY, { status: 'pending', createdAt: '2026-10-06T12:00:00.000Z' });
  const exceptions = run({
    entries: normalTuesday(),
    ptoRequests: [waitingTooLong, stillFresh, datePassed, forToday],
  });

  assert.deepEqual(
    exceptions.map((e) => e.key).sort(),
    [`pto_pending|${waitingTooLong._id}`, `pto_pending|${datePassed._id}`].sort(),
  );
  assert.match(exceptions.find((e) => e.userId === 'u-cora').detail, /date has passed/);
});

test('the days are Manila days even when the run happens late in the UTC day before', () => {
  // 00:30 on Wednesday in Manila is still Tuesday in UTC.
  const justAfterMidnight = new Date('2026-10-06T16:30:00.000Z');
  const open = entry(DAN, TUESDAY, { to: null, hours: 15.5 });
  const exceptions = run({ entries: [...normalTuesday().slice(0, 3), open], openEntries: [open] }, {}, justAfterMidnight);

  assert.deepEqual(summary(exceptions), ['missed_clock_out Dan Santos 2026-10-06']);
});
