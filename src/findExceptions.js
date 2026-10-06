// Finds timesheet exceptions in data read from the time tracker.
//
// This file has no imports so the same text can be pasted into an n8n Code
// node unchanged. Everything is a plain function of its arguments: nothing
// here reads the clock, the network or n8n.

const DEFAULT_SETTINGS = {
  // A completed entry with more worked hours than this is a long shift.
  maxWorkedHours: 10,
  // A completed entry with more break hours than this is a long pause.
  maxPauseHours: 2,
  // A PTO request still pending after this many days is flagged.
  ptoPendingDays: 3,
  // Approved PTO hours on a day that count as the whole day off.
  fullDayPtoHours: 8,
  // Dates (YYYY-MM-DD) nobody is expected to work, besides weekends.
  holidays: [],
  timezone: 'Asia/Manila',
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Calendar date (YYYY-MM-DD) of a moment, as seen in the given timezone.
function localDay(value, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

// Clock time (HH:MM, 24-hour) of a moment, as seen in the given timezone.
function localTime(value, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function isWorkday(day, settings) {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !settings.holidays.includes(day);
}

// The key that identifies an exception in the Sheet, so a rerun adds no duplicates.
function exceptionKey(type, id, day) {
  if (type === 'no_entries_at_all') return `${type}|${day}`;
  if (type === 'pto_pending') return `${type}|${id}`;
  return `${type}|${id}|${day}`;
}

function fullName(person) {
  return `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim();
}

function hoursText(hours) {
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/**
 * @param data      { daysToCheck, entries, openEntries, users, ptoRequests }
 *                  in the shapes the time tracker API returns them.
 * @param settings  overrides for DEFAULT_SETTINGS.
 * @param now       the moment of the run.
 * @returns         a list of { key, type, day, userId, person, email, detail }.
 */
function findExceptions(data, settings, now) {
  const config = { ...DEFAULT_SETTINGS, ...settings };
  const tz = config.timezone;
  const today = localDay(now, tz);
  const daysToCheck = data.daysToCheck ?? [];
  const exceptions = [];

  const add = (type, day, person, id, detail) => {
    exceptions.push({
      key: exceptionKey(type, id, day),
      type,
      day,
      userId: person ? String(person._id) : null,
      person: person ? fullName(person) : '',
      email: person ? (person.email ?? '') : '',
      detail,
    });
  };

  // Missed clock-outs: any entry still open from a day before today.
  // An open entry is never also a long shift or pause, since its hours are still counting.
  const seenOpen = new Set();
  for (const entry of data.openEntries ?? []) {
    if (entry.clockOut || seenOpen.has(String(entry._id))) continue;
    seenOpen.add(String(entry._id));
    const day = localDay(entry.date, tz);
    if (day >= today) continue;
    add(
      'missed_clock_out',
      day,
      entry.user,
      entry.user._id,
      `Clocked in at ${localTime(entry.clockIn, tz)} and never clocked out`,
    );
  }

  // Long shifts and long pauses on completed entries, and who was present each day.
  const presentByDay = new Map(daysToCheck.map((day) => [day, new Set()]));
  const markPresent = (entry) => {
    const present = presentByDay.get(localDay(entry.date, tz));
    if (present) present.add(String(entry.user._id));
  };
  (data.openEntries ?? []).forEach(markPresent);

  for (const entry of data.entries ?? []) {
    markPresent(entry);
    const day = localDay(entry.date, tz);
    if (!presentByDay.has(day) || entry.status !== 'completed') continue;
    if (entry.hours > config.maxWorkedHours) {
      add(
        'long_shift',
        day,
        entry.user,
        entry.user._id,
        `Worked ${hoursText(entry.hours)} (limit ${config.maxWorkedHours})`,
      );
    }
    if (entry.breakHours > config.maxPauseHours) {
      add(
        'long_pause',
        day,
        entry.user,
        entry.user._id,
        `Paused ${hoursText(entry.breakHours)} (limit ${config.maxPauseHours})`,
      );
    }
  }

  // Approved PTO hours per person per day.
  const ptoRequests = data.ptoRequests ?? [];
  const requesterId = (request) => String(request.userId?._id ?? request.userId);
  const approvedHours = new Map();
  for (const request of ptoRequests) {
    if (request.status !== 'approved') continue;
    const slot = `${requesterId(request)}|${localDay(request.date, tz)}`;
    approvedHours.set(slot, (approvedHours.get(slot) ?? 0) + Number(request.hours));
  }

  // Missing entries on workdays. Only regular users are expected to clock in.
  const expectedStaff = (data.users ?? []).filter((user) => user.role === 'user');
  for (const day of daysToCheck) {
    if (!isWorkday(day, config)) continue;
    const present = presentByDay.get(day);
    if (present.size === 0) {
      // One exception for the day instead of one per person: this usually means
      // a holiday that is not in the list, or a problem reading the tracker.
      add('no_entries_at_all', day, null, null, 'Nobody has a time entry on this workday');
      continue;
    }
    for (const user of expectedStaff) {
      if (present.has(String(user._id))) continue;
      if (localDay(user.createdAt, tz) > day) continue;
      const pto = approvedHours.get(`${user._id}|${day}`) ?? 0;
      if (pto >= config.fullDayPtoHours) continue;
      const note = pto > 0 ? ` (${pto} approved PTO ${pto === 1 ? 'hour' : 'hours'})` : '';
      add('no_entry', day, user, user._id, `No time entry and no full-day PTO${note}`);
    }
  }

  // PTO requests left pending too long, or still pending after their date.
  const nowMs = new Date(now).getTime();
  for (const request of ptoRequests) {
    if (request.status !== 'pending') continue;
    const day = localDay(request.date, tz);
    const madeOn = localDay(request.createdAt, tz);
    const datePassed = day < today;
    const waitingTooLong = nowMs - new Date(request.createdAt).getTime() > config.ptoPendingDays * DAY_MS;
    if (!datePassed && !waitingTooLong) continue;
    const person = typeof request.userId === 'object' && request.userId ? request.userId : { _id: request.userId };
    add(
      'pto_pending',
      day,
      person,
      request._id,
      `Pending since ${madeOn} for PTO on ${day} (${hoursText(request.hours)})` +
        (datePassed ? '; the PTO date has passed' : ''),
    );
  }

  return exceptions.sort(
    (a, b) => a.day.localeCompare(b.day) || a.type.localeCompare(b.type) || a.person.localeCompare(b.person),
  );
}

// Lets the tests load this file; has no effect inside an n8n Code node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { findExceptions, exceptionKey, DEFAULT_SETTINGS };
}
