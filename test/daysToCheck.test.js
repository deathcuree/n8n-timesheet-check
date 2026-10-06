const { test } = require('node:test');
const assert = require('node:assert/strict');
const { daysToCheck } = require('../src/daysToCheck.js');

// Wednesday 7 October 2026, 08:00 in Manila.
const NOW = new Date('2026-10-07T00:00:00.000Z');

test('with no run history it checks yesterday only', () => {
  assert.deepEqual(daysToCheck(null, NOW), ['2026-10-06']);
});

test('after a normal run the day before, it checks yesterday', () => {
  assert.deepEqual(daysToCheck('2026-10-05', NOW), ['2026-10-06']);
});

test('after three missed mornings it covers the three missed days', () => {
  // The last run was on 4 October and covered 3 October.
  assert.deepEqual(daysToCheck('2026-10-03', NOW), ['2026-10-04', '2026-10-05', '2026-10-06']);
});

test('a long gap is capped at the seven most recent days', () => {
  assert.deepEqual(daysToCheck('2026-09-16', NOW), [
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
    '2026-10-05',
    '2026-10-06',
  ]);
});

test('the cap comes from the settings', () => {
  assert.deepEqual(daysToCheck('2026-09-16', NOW, { maxCatchUpDays: 2 }), ['2026-10-05', '2026-10-06']);
});

test('a second run on the same day checks yesterday again', () => {
  assert.deepEqual(daysToCheck('2026-10-06', NOW), ['2026-10-06']);
});

test('yesterday is the Manila day, not the UTC day', () => {
  // 00:30 on Wednesday in Manila is 16:30 on Tuesday in UTC.
  assert.deepEqual(daysToCheck(null, new Date('2026-10-06T16:30:00.000Z')), ['2026-10-06']);
});

test('the range crosses a month boundary correctly', () => {
  assert.deepEqual(daysToCheck('2026-09-29', new Date('2026-10-02T00:00:00.000Z')), ['2026-09-30', '2026-10-01']);
});
