// Turns the exceptions of a run into Sheet rows, a run-history row and the
// summary email.
//
// This file has no imports so the same text can be pasted into an n8n Code
// node unchanged.

const TYPE_LABELS = {
  missed_clock_out: 'Missed clock-out',
  long_shift: 'Long shift',
  long_pause: 'Long pause',
  no_entry: 'No entry',
  no_entries_at_all: 'No entries at all',
  pto_pending: 'PTO pending',
};

// Adds `reportedBefore` to each exception: true when its key is already in the Sheet.
function markReported(exceptions, existingKeys) {
  const seen = new Set(existingKeys.map(String));
  return exceptions.map((exception) => ({ ...exception, reportedBefore: seen.has(exception.key) }));
}

// Rows to append to the Exceptions tab: only exceptions not reported before.
function sheetRows(markedExceptions, foundAt) {
  return markedExceptions
    .filter((exception) => !exception.reportedBefore)
    .map((exception) => ({
      key: exception.key,
      found_at: foundAt,
      day: exception.day,
      type: exception.type,
      person: exception.person,
      email: exception.email,
      detail: exception.detail,
    }));
}

// The row appended to the Runs tab once everything else has succeeded.
function runRow(runAt, days, markedExceptions) {
  return {
    run_at: runAt,
    days_covered: days.join(', '),
    new_exceptions: markedExceptions.filter((exception) => !exception.reportedBefore).length,
    total_exceptions: markedExceptions.length,
  };
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param days            the days this run covered.
 * @param exceptions      exceptions from markReported.
 * @param summary         the checked summary with names restored, or null.
 * @param summaryProblem  why there is no summary, when one was expected.
 * @returns               { subject, html }
 */
function buildEmail({ days, exceptions, summary, summaryProblem }) {
  const total = exceptions.length;
  const fresh = exceptions.filter((exception) => !exception.reportedBefore).length;
  const emptyDays = exceptions.filter((exception) => exception.type === 'no_entries_at_all').map((e) => e.day);
  const lastDay = days[days.length - 1];

  let subject =
    total === 0
      ? `Timesheet check ${lastDay}: nothing to report`
      : `Timesheet check ${lastDay}: ${total} ${total === 1 ? 'exception' : 'exceptions'} (${fresh} new)`;
  if (emptyDays.length > 0) {
    subject = `NO ENTRIES on ${emptyDays.join(', ')} | ${subject}`;
  }

  const parts = [];
  parts.push(`<p>Days covered: <b>${days.map(escapeHtml).join(', ')}</b></p>`);

  for (const day of emptyDays) {
    parts.push(
      `<p style="padding:8px;border:1px solid #c00;color:#c00"><b>Nobody has a time entry on ${escapeHtml(day)}.</b> ` +
        'If it was a holiday, add it to the holiday list. If not, check that the time tracker is working.</p>',
    );
  }

  if (total === 0) {
    parts.push('<p>No exceptions were found.</p>');
    return { subject, html: parts.join('\n') };
  }

  if (summary) {
    parts.push(`<p>${escapeHtml(summary)}</p>`);
  } else if (summaryProblem) {
    parts.push(`<p><i>The written summary was unavailable (${escapeHtml(summaryProblem)}). The full list is below.</i></p>`);
  }

  const cell = 'style="padding:4px 10px;border:1px solid #ccc;text-align:left"';
  const rows = exceptions.map(
    (exception) =>
      `<tr><td ${cell}>${escapeHtml(exception.day)}</td>` +
      `<td ${cell}>${escapeHtml(TYPE_LABELS[exception.type] ?? exception.type)}</td>` +
      `<td ${cell}>${escapeHtml(exception.person || 'Everyone')}</td>` +
      `<td ${cell}>${escapeHtml(exception.detail)}</td>` +
      `<td ${cell}>${exception.reportedBefore ? 'Reported before' : '<b>New</b>'}</td></tr>`,
  );
  parts.push(
    '<table style="border-collapse:collapse">' +
      `<tr><th ${cell}>Day</th><th ${cell}>Problem</th><th ${cell}>Person</th><th ${cell}>Detail</th><th ${cell}>Status</th></tr>\n` +
      rows.join('\n') +
      '\n</table>',
  );
  parts.push(`<p>${total} in total, ${fresh} new since the last report.</p>`);

  return { subject, html: parts.join('\n') };
}

// Lets the tests load this file; has no effect inside an n8n Code node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { markReported, sheetRows, runRow, buildEmail };
}
