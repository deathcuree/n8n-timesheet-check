// Works out which days a run should check.
//
// This file has no imports so the same text can be pasted into an n8n Code
// node unchanged.

const DAYS_TO_CHECK_DEFAULTS = {
  // After a gap, look back at most this many days.
  maxCatchUpDays: 7,
  timezone: 'Asia/Manila',
};

function shiftDay(day, offset) {
  const moved = new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * 24 * 60 * 60 * 1000);
  return moved.toISOString().slice(0, 10);
}

/**
 * @param lastCoveredDay  the latest day (YYYY-MM-DD) a successful run has
 *                        covered, or null when there is no run history.
 * @param now             the moment of the run.
 * @param settings        overrides for DAYS_TO_CHECK_DEFAULTS.
 * @returns               days (YYYY-MM-DD), oldest first. Every day after the
 *                        last covered day up to yesterday, capped at the most
 *                        recent maxCatchUpDays. Always at least yesterday, so
 *                        a second run on the same day rechecks it.
 */
function daysToCheck(lastCoveredDay, now, settings) {
  const config = { ...DAYS_TO_CHECK_DEFAULTS, ...settings };
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
  const yesterday = shiftDay(today, -1);

  if (!lastCoveredDay || lastCoveredDay >= yesterday) return [yesterday];

  const days = [];
  for (let day = yesterday; day > lastCoveredDay && days.length < config.maxCatchUpDays; day = shiftDay(day, -1)) {
    days.unshift(day);
  }
  return days;
}

/**
 * @param runRows  the rows of the run-history tab, each with a `days_covered`
 *                 text such as "2026-10-01, 2026-10-02".
 * @returns        the latest day any successful run covered, or null.
 */
function lastCoveredDay(runRows) {
  let latest = null;
  for (const row of runRows) {
    const days = typeof row.days_covered === 'string' ? row.days_covered.match(/\d{4}-\d{2}-\d{2}/g) : null;
    for (const day of days ?? []) {
      if (latest === null || day > latest) latest = day;
    }
  }
  return latest;
}

// Lets the tests load this file; has no effect inside an n8n Code node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { daysToCheck, lastCoveredDay, DAYS_TO_CHECK_DEFAULTS };
}
