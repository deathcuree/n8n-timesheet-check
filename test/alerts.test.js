const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildFailureAlert, checkHeartbeat } = require('../src/alerts.js');

// What n8n hands an error workflow when a node fails during a run.
const failedRun = (overrides = {}) => ({
  execution: {
    id: '231',
    url: 'http://localhost:5678/workflow/abc/executions/231',
    retryOf: null,
    error: {
      message: 'The service refused the connection - perhaps it is offline',
      description: '{"items":[{"user":{"firstName":"Ana","lastName":"Cruz","email":"ana@example.com"},"hours":12.5}]}',
      stack: 'NodeApiError: The service refused the connection\n    at ExecuteContext.execute (/path/HttpRequest.node.js:1:1)',
      ...overrides.error,
    },
    lastNodeExecuted: 'Log in',
    mode: 'trigger',
    ...overrides.execution,
  },
  workflow: { id: 'timesheetCheck', name: 'Timesheet check' },
});

// What n8n hands an error workflow when the workflow could not even start.
const failedTrigger = {
  trigger: { error: { message: 'Could not start the schedule', description: 'details' }, mode: 'trigger' },
  workflow: { id: 'timesheetCheck', name: 'Timesheet check' },
};

test('a failure alert names the workflow, the failing node and the error', () => {
  const { subject, html } = buildFailureAlert(failedRun());

  assert.match(subject, /FAILED/);
  assert.match(subject, /Timesheet check/);
  assert.match(subject, /Log in/);
  assert.match(html, /Timesheet check/);
  assert.match(html, /Log in/);
  assert.match(html, /The service refused the connection - perhaps it is offline/);
});

test('a failure alert leaves out response bodies and stack traces', () => {
  const { subject, html } = buildFailureAlert(failedRun());
  const text = subject + html;

  for (const leaked of ['Ana', 'Cruz', 'ana@example.com', '12.5', 'HttpRequest.node.js', 'NodeApiError']) {
    assert.equal(text.includes(leaked), false, `alert leaks "${leaked}"`);
  }
});

test('a very long error message is cut short', () => {
  const { html } = buildFailureAlert(failedRun({ error: { message: `Bad response: ${'x'.repeat(5000)}` } }));

  assert.ok(html.length < 1500, `alert is ${html.length} characters`);
  assert.match(html, /Bad response: x+…/);
});

test('a failure alert says nothing was recorded and what happens next', () => {
  const { html } = buildFailureAlert(failedRun());

  assert.match(html, /no run was recorded/i);
  assert.match(html, /next run/i);
});

test('the note about catching up is only added for the daily check', () => {
  const heartbeatFailure = { ...failedRun(), workflow: { id: 'timesheetCheckHeartbeat', name: 'Timesheet check - heartbeat' } };

  assert.doesNotMatch(buildFailureAlert(heartbeatFailure).html, /no run was recorded/i);
  assert.match(buildFailureAlert(heartbeatFailure).html, /Open the run in n8n/);
});

test('a failure before any node ran is still reported', () => {
  const { subject, html } = buildFailureAlert(failedTrigger);

  assert.match(subject, /FAILED/);
  assert.match(subject, /Timesheet check/);
  assert.match(html, /could not start/i);
  assert.match(html, /Could not start the schedule/);
});

test('an alert with missing details still names what it can', () => {
  const { subject, html } = buildFailureAlert({ workflow: { name: 'Timesheet check' }, execution: {} });

  assert.match(subject, /FAILED: Timesheet check/);
  assert.match(html, /unknown/i);
});

test('the error text is escaped', () => {
  const { html } = buildFailureAlert(failedRun({ error: { message: 'Unexpected token < in <html>' } }));

  assert.match(html, /Unexpected token &lt; in &lt;html&gt;/);
});

// Wednesday 7 October 2026, 10:00 in Manila.
const NOW = new Date('2026-10-07T02:00:00.000Z');
const run = (runAt) => ({ run_at: runAt, days_covered: '2026-10-06', new_exceptions: 0, total_exceptions: 0 });

test('a run this morning keeps the heartbeat silent', () => {
  const result = checkHeartbeat([run('2026-10-06T00:00:10.000Z'), run('2026-10-07T00:00:09.000Z')], NOW);

  assert.equal(result.alert, false);
  assert.equal(result.lastRunAt, '2026-10-07T00:00:09.000Z');
});

test('the newest run counts, wherever it is in the list', () => {
  const result = checkHeartbeat([run('2026-10-07T00:00:09.000Z'), run('2026-10-01T00:00:10.000Z')], NOW);

  assert.equal(result.alert, false);
});

test('a newest run exactly 36 hours old is still fine; a second older is not', () => {
  assert.equal(checkHeartbeat([run('2026-10-05T14:00:00.000Z')], NOW).alert, false);
  assert.equal(checkHeartbeat([run('2026-10-05T13:59:59.000Z')], NOW).alert, true);
});

test('no run for two days raises an alert that says how long it has been', () => {
  const result = checkHeartbeat([run('2026-10-05T00:00:10.000Z')], NOW);

  assert.equal(result.alert, true);
  assert.match(result.subject, /no run/i);
  assert.match(result.subject, /50 hours/);
  assert.match(result.html, /2026-10-05T00:00:10\.000Z/);
  assert.match(result.html, /36 hours/);
});

test('one hour is written in the singular', () => {
  const result = checkHeartbeat([run('2026-10-07T01:00:00.000Z')], NOW, { maxSilentHours: 0 });

  assert.match(result.subject, /no run for 1 hour$/);
  assert.match(result.html, /about 1 hour ago\. The limit is 0 hours\./);
});

test('an empty run history raises an alert', () => {
  for (const rows of [[], [{}], [{ run_at: '' }]]) {
    const result = checkHeartbeat(rows, NOW);
    assert.equal(result.alert, true);
    assert.equal(result.lastRunAt, null);
    assert.match(result.subject, /no run has ever been recorded/i);
  }
});

test('rows with unreadable times are ignored', () => {
  const result = checkHeartbeat([run('not a date'), run('2026-10-07T00:00:09.000Z'), { run_at: 46301.5 }], NOW);

  assert.equal(result.alert, false);
  assert.equal(result.lastRunAt, '2026-10-07T00:00:09.000Z');
});

test('the silence limit comes from the settings', () => {
  assert.equal(checkHeartbeat([run('2026-10-06T00:00:10.000Z')], NOW, { maxSilentHours: 12 }).alert, true);
});
