// Builds the two alert emails: one when a run fails, one when no run has been
// recorded for too long.
//
// This file has no imports so the same text can be pasted into an n8n Code
// node unchanged.

const HEARTBEAT_DEFAULTS = {
  // Alert when the newest recorded run is older than this.
  maxSilentHours: 36,
};

const MAX_ERROR_LENGTH = 300;

// The id of the daily check, whose failed runs are covered again by the next run.
const DAILY_CHECK_ID = 'timesheetCheck';

function escapeAlertHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shorten(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > MAX_ERROR_LENGTH ? `${clean.slice(0, MAX_ERROR_LENGTH)}…` : clean;
}

/**
 * @param data  what n8n passes to an error workflow: { execution, workflow },
 *              or { trigger, workflow } when the workflow could not start.
 * @returns     { subject, html }. Only the workflow name, the node name and
 *              the error message are used. The error's description and stack
 *              are left out, because they can hold response data.
 */
function buildFailureAlert(data) {
  const workflowName = data?.workflow?.name || 'unknown workflow';
  const execution = data?.execution;
  const couldNotStart = !execution && Boolean(data?.trigger);
  const error = (couldNotStart ? data.trigger.error : execution?.error) ?? {};
  const message = error.message ? shorten(error.message) : 'unknown error';
  const nodeName = couldNotStart ? null : execution?.lastNodeExecuted || 'unknown step';

  const subject = couldNotStart
    ? `FAILED: ${workflowName} could not start`
    : `FAILED: ${workflowName} at "${nodeName}"`;

  const lines = [
    `<p><b>${escapeAlertHtml(workflowName)}</b> ${couldNotStart ? 'could not start.' : 'failed.'}</p>`,
    '<table style="border-collapse:collapse">',
    nodeName ? `<tr><td style="padding:2px 12px 2px 0">Step</td><td><b>${escapeAlertHtml(nodeName)}</b></td></tr>` : '',
    `<tr><td style="padding:2px 12px 2px 0">Error</td><td>${escapeAlertHtml(message)}</td></tr>`,
    execution?.id ? `<tr><td style="padding:2px 12px 2px 0">Run</td><td>${escapeAlertHtml(execution.id)}</td></tr>` : '',
    '</table>',
    data?.workflow?.id === DAILY_CHECK_ID
      ? '<p>No run was recorded, so the next run will cover the same days again. Nothing is written twice.</p>'
      : '',
    '<p>Open the run in n8n to see the details.</p>',
  ];

  return { subject, html: lines.filter(Boolean).join('\n') };
}

/**
 * @param runRows   the rows of the run-history tab, each with a `run_at` time.
 * @param now       the moment of the check.
 * @param settings  overrides for HEARTBEAT_DEFAULTS.
 * @returns         { alert, lastRunAt, subject, html }; subject and html are
 *                  only set when alert is true.
 */
function checkHeartbeat(runRows, now, settings) {
  const config = { ...HEARTBEAT_DEFAULTS, ...settings };
  const nowMs = new Date(now).getTime();

  let lastRunAt = null;
  let lastRunMs = -Infinity;
  for (const row of runRows) {
    if (typeof row.run_at !== 'string') continue;
    const ms = Date.parse(row.run_at);
    if (Number.isNaN(ms) || ms <= lastRunMs) continue;
    lastRunMs = ms;
    lastRunAt = row.run_at;
  }

  if (lastRunAt === null) {
    return {
      alert: true,
      lastRunAt,
      subject: 'Timesheet check: no run has ever been recorded',
      html:
        '<p>The run history is empty, so the timesheet check has never finished a run.</p>' +
        '<p>Check that n8n is running and the workflow is switched on.</p>',
    };
  }

  const silentMs = nowMs - lastRunMs;
  if (silentMs <= config.maxSilentHours * 60 * 60 * 1000) {
    return { alert: false, lastRunAt };
  }

  const hours = Math.round(silentMs / (60 * 60 * 1000));
  const hoursText = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return {
    alert: true,
    lastRunAt,
    subject: `Timesheet check: no run for ${hoursText}`,
    html:
      `<p>The last recorded run of the timesheet check was at <b>${escapeAlertHtml(lastRunAt)}</b>, ` +
      `about ${hoursText} ago. The limit is ${config.maxSilentHours} hours.</p>` +
      '<p>Check that n8n is running and the workflow is switched on. ' +
      'The next successful run will catch up on the missed days, up to 7.</p>',
  };
}

// Lets the tests load this file; has no effect inside an n8n Code node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildFailureAlert, checkHeartbeat, HEARTBEAT_DEFAULTS };
}
