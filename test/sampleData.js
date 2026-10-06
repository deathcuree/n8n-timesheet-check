// Builders for sample API data in the time tracker's own shapes.
// All people here are invented.

// The run happens on Wednesday 7 October 2026 at 08:30 in Manila.
const NOW = new Date('2026-10-07T00:30:00.000Z');
const MONDAY = '2026-10-05';
const TUESDAY = '2026-10-06';
const TODAY = '2026-10-07';

const person = (id, firstName, lastName, role = 'user', createdAt = '2026-01-05T02:00:00.000Z') => ({
  _id: id,
  firstName,
  lastName,
  email: `${firstName.toLowerCase()}@example.com`,
  role,
  position: 'Assistant',
  createdAt,
  updatedAt: createdAt,
});

const ANA = person('u-ana', 'Ana', 'Cruz');
const BEN = person('u-ben', 'Ben', 'Reyes');
const CORA = person('u-cora', 'Cora', 'Lim');
const DAN = person('u-dan', 'Dan', 'Santos');
const ADMIN = person('u-admin', 'Ada', 'Admin', 'admin');
const READONLY = person('u-ro', 'Report', 'Reader', 'readonly');

const pad = (n) => String(n).padStart(2, '0');

// The tracker stores an entry's day as Manila midnight, which is 16:00 UTC the day before.
const manilaMidnight = (day) => {
  const previous = new Date(Date.parse(`${day}T00:00:00.000Z`) - 24 * 60 * 60 * 1000);
  return `${previous.toISOString().slice(0, 10)}T16:00:00.000Z`;
};
const manilaTime = (day, hhmm) => new Date(`${day}T${hhmm}:00+08:00`).toISOString();

let nextId = 1;

function entry(user, day, options = {}) {
  const { from = '09:00', to = '17:00', hours = 8, breakHours = 0, status } = options;
  const open = to === null;
  return {
    _id: `e-${pad(nextId++)}`,
    date: manilaMidnight(day),
    clockIn: manilaTime(day, from),
    clockOut: open ? null : manilaTime(day, to),
    updatedAt: manilaTime(day, from),
    user: { _id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email },
    breaks: [],
    hours,
    breakHours,
    status: status ?? (open ? 'active' : 'completed'),
  };
}

// In production the tracker stores a PTO date as UTC midnight of the chosen day.
function pto(user, day, options = {}) {
  const { hours = 8, status = 'approved', createdAt = '2026-09-20T03:00:00.000Z' } = options;
  return {
    _id: `p-${pad(nextId++)}`,
    userId: { _id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email },
    userName: `${user.firstName} ${user.lastName}`,
    userEmail: user.email,
    date: `${day}T00:00:00.000Z`,
    hours,
    reason: 'Family matter',
    status,
    createdAt,
    updatedAt: createdAt,
  };
}

module.exports = {
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
  manilaTime,
};
