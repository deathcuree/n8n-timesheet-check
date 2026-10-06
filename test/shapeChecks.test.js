const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkLogin, checkTimeLogs, checkPtoRequests, checkUsers } = require('../src/shapeChecks.js');
const { ANA, ADMIN, entry, pto, TUESDAY } = require('./sampleData.js');

const timeLogs = (items = [entry(ANA, TUESDAY)]) => ({ items, pagination: { total: items.length, page: 1, pages: 1 } });
const ptoPage = (items = [pto(ANA, TUESDAY)]) => ({
  items,
  pagination: { currentPage: 1, totalPages: 1, totalItems: items.length, itemsPerPage: 100 },
});
const login = (role = 'readonly') => ({ success: true, data: { user: { id: 'u-ro', email: 'reader@example.com', role } } });
const without = (object, field) => {
  const copy = { ...object };
  delete copy[field];
  return copy;
};

test('well-formed responses pass', () => {
  assert.doesNotThrow(() => checkLogin(login()));
  assert.doesNotThrow(() => checkTimeLogs(timeLogs()));
  assert.doesNotThrow(() => checkTimeLogs(timeLogs([])));
  assert.doesNotThrow(() => checkPtoRequests(ptoPage()));
  assert.doesNotThrow(() => checkPtoRequests(ptoPage([])));
  assert.doesNotThrow(() => checkUsers([ANA, ADMIN]));
});

test('an open entry with no clock-out and zero hours passes', () => {
  assert.doesNotThrow(() => checkTimeLogs(timeLogs([entry(ANA, TUESDAY, { to: null, hours: 0, breakHours: 0 })])));
});

test('time logs without items or pagination fail, naming the endpoint and field', () => {
  assert.throws(() => checkTimeLogs(without(timeLogs(), 'items')), /Time logs.*items/);
  assert.throws(() => checkTimeLogs(without(timeLogs(), 'pagination')), /Time logs.*pagination/);
  assert.throws(() => checkTimeLogs({ items: [], pagination: { total: 0, page: 1 } }), /Time logs.*pagination\.pages/);
  assert.throws(() => checkTimeLogs({ message: 'Server error', error: 'boom' }), /Time logs.*items/);
});

for (const field of ['user', 'date', 'clockIn', 'hours', 'breakHours', 'status']) {
  test(`a time log item without ${field} fails`, () => {
    const items = [entry(ANA, TUESDAY), without(entry(ANA, TUESDAY), field)];
    assert.throws(() => checkTimeLogs(timeLogs(items)), new RegExp(`Time logs.*item 2.*${field}`));
  });
}

test('a time log item whose user has no id fails', () => {
  const item = entry(ANA, TUESDAY);
  item.user = without(item.user, '_id');
  assert.throws(() => checkTimeLogs(timeLogs([item])), /Time logs.*user\._id/);
});

test('a PTO response in the wrong shape fails', () => {
  assert.throws(() => checkPtoRequests(without(ptoPage(), 'items')), /PTO requests.*items/);
  assert.throws(() => checkPtoRequests({ items: [], pagination: { total: 0, page: 1, pages: 1 } }), /PTO requests.*pagination\.currentPage/);
  assert.throws(() => checkPtoRequests(ptoPage([without(pto(ANA, TUESDAY), 'status')])), /PTO requests.*item 1.*status/);
  assert.throws(() => checkPtoRequests(ptoPage([{ ...pto(ANA, TUESDAY), userId: 'u-ana' }])), /PTO requests.*userId\._id/);
});

test('a users response in the wrong shape fails', () => {
  assert.throws(() => checkUsers({ items: [ANA] }), /Users.*list/);
  assert.throws(() => checkUsers([ANA, without(ADMIN, 'role')]), /Users.*item 2.*role/);
  assert.throws(() => checkUsers([without(ANA, 'createdAt')]), /Users.*item 1.*createdAt/);
});

test('an empty user list fails, since the tracker always has at least the account that logged in', () => {
  assert.throws(() => checkUsers([]), /Users.*empty/);
});

test('a failed or malformed login fails', () => {
  assert.throws(() => checkLogin({ success: false, message: 'Authentication failed' }), /Login.*success/);
  assert.throws(() => checkLogin({ success: true, data: {} }), /Login.*data\.user/);
  assert.throws(() => checkLogin(undefined), /Login/);
});

test('logging in with anything stronger than a read-only account fails', () => {
  assert.throws(() => checkLogin(login('admin')), /Login.*"admin".*readonly/);
  assert.throws(() => checkLogin(login('user')), /Login.*"user".*readonly/);
});
