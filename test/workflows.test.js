const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OUTPUTS, CODE, render, source } = require('../scripts/build-workflows.js');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, 'workflows');
const committedFiles = fs.readdirSync(WORKFLOW_DIR).filter((file) => file.endsWith('.json'));
const read = (file) => fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
const main = JSON.parse(read('timesheet-check.json'));
const alert = JSON.parse(read('failure-alert.json'));
const heartbeat = JSON.parse(read('heartbeat.json'));
const all = [main, alert, heartbeat];
const node = (name, workflow = main) => workflow.nodes.find((n) => n.name === name);

test('every committed workflow is exactly what the build script produces', () => {
  assert.deepEqual(committedFiles.map((file) => `workflows/${file}`).sort(), Object.keys(OUTPUTS).sort());
  for (const [file, build] of Object.entries(OUTPUTS)) {
    assert.equal(read(path.basename(file)), render(build()), `${file} is out of date: run "npm run build"`);
  }
});

test('each Code node holds the exact text of the tested source files', () => {
  for (const [name, { files }] of Object.entries(CODE)) {
    const jsCode = all.flatMap((workflow) => workflow.nodes).find((n) => n.name === name).parameters.jsCode;
    for (const file of files) {
      assert.ok(jsCode.includes(source(file)), `Code node "${name}" does not contain src/${file} unchanged`);
    }
  }
});

test('the committed workflows contain no addresses, ids, hosts or secrets', () => {
  for (const file of committedFiles) {
    const text = read(file);
    // Source code inside Code nodes is public anyway; everything else must be free of installation details.
    const workflow = JSON.parse(text);
    // Node ids are generated from the node names and identify nothing outside this file.
    const nodeIds = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    const outsideCode = JSON.stringify({
      ...workflow,
      nodes: workflow.nodes.map((n) => (n.type === 'n8n-nodes-base.code' ? { ...n, parameters: {} } : n)),
    }).replace(nodeIds, '');

    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, `${file}: contains an email address`);
    assert.doesNotMatch(outsideCode, /https?:\/\//, `${file}: contains a URL outside the Code nodes`);
    assert.doesNotMatch(text, /localhost|127\.0\.0\.1|amazonaws|vercel\.app|docs\.google\.com/i, `${file}: contains a host name`);
    assert.doesNotMatch(outsideCode, /[A-Za-z0-9_-]{30,}/, `${file}: contains something that looks like an id, key or token`);
    assert.doesNotMatch(text, /"(password|apiKey|clientSecret|accessToken|refreshToken|oauthTokenData)"/i, `${file}: contains credential data`);
  }
});

test('local settings from .env do not appear in the committed workflows', (t) => {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return t.skip('no .env on this machine');
  const values = fs
    .readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => line.slice(line.indexOf('=') + 1).trim())
    .filter((value) => value.length >= 8);
  for (const file of committedFiles) {
    for (const value of values) {
      assert.equal(read(file).includes(value), false, `${file}: contains a value from .env`);
    }
  }
});

test('credentials are referenced by name only, with a placeholder id', () => {
  for (const n of all.flatMap((workflow) => workflow.nodes)) {
    for (const credential of Object.values(n.credentials ?? {})) {
      assert.deepEqual(Object.keys(credential).sort(), ['id', 'name']);
      assert.equal(credential.id, 'SELECT_IN_N8N');
    }
  }
});

test('the only calls to the time tracker are the login and GET requests', () => {
  const calls = main.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  const summary = calls.map((n) => `${n.parameters.method} ${n.parameters.url.replace('={{ $env.TIME_TRACKER_API_URL }}', '')}`);

  assert.deepEqual(summary.sort(), [
    'GET /admin/time/logs',
    'GET /admin/time/logs',
    'GET /admin/users',
    'GET /pto/all',
    'POST /auth/login',
  ]);
});

test('the schedule is 8:00 every day in Manila time, and a manual start exists', () => {
  assert.equal(main.settings.timezone, 'Asia/Manila');
  assert.deepEqual(node('Every morning at 8:00').parameters.rule.interval, [
    { field: 'days', daysInterval: 1, triggerAtHour: 8, triggerAtMinute: 0 },
  ]);
  assert.ok(node('Run by hand'));
});

test('the login retries at most twice; data and model calls retry up to three times with a wait', () => {
  assert.equal(node('Log in').retryOnFail, true);
  assert.equal(node('Log in').maxTries, 3, 'three tries is the first attempt plus two retries');
  for (const name of ['Get time logs', 'Get open entries', 'Get PTO requests', 'Get users', 'Summarise']) {
    assert.equal(node(name).retryOnFail, true, name);
    assert.equal(node(name).maxTries, 3, name);
    assert.ok(node(name).waitBetweenTries >= 1000, name);
  }
});

test('a failed model call does not stop the run', () => {
  assert.equal(node('Summarise').onError, 'continueRegularOutput');
});

test('the run-history row is written after the Sheet rows and the email', () => {
  const next = (name) => main.connections[name].main.flat().map((link) => link.node);
  assert.deepEqual(next('Append exceptions'), ['Send summary']);
  assert.deepEqual(next('Send summary'), ['Run history row']);
  assert.deepEqual(next('Run history row'), ['Append run']);
  assert.equal(main.connections['Append run'], undefined, 'nothing runs after the run-history row');
});

test('every node is connected and every connection points at a real node', () => {
  const triggers = ['Every morning at 8:00', 'Every day at 10:00', 'Run by hand', 'When a run fails'];
  for (const workflow of all) {
    const names = new Set(workflow.nodes.map((n) => n.name));
    const targets = new Set();
    for (const [from, outputs] of Object.entries(workflow.connections)) {
      assert.ok(names.has(from), from);
      for (const link of outputs.main.flat()) {
        assert.ok(names.has(link.node), `${from} -> ${link.node}`);
        targets.add(link.node);
      }
    }
    for (const name of names) {
      assert.ok(triggers.includes(name) || targets.has(name), `${workflow.name}: "${name}" is never reached`);
    }
  }
});

test('the three workflows have fixed, distinct ids and all use Manila time', () => {
  assert.deepEqual(
    all.map((workflow) => workflow.id),
    ['timesheetCheck', 'timesheetCheckFailureAlert', 'timesheetCheckHeartbeat'],
  );
  for (const workflow of all) assert.equal(workflow.settings.timezone, 'Asia/Manila', workflow.name);
});

test('a failure in the main or heartbeat workflow starts the failure-alert workflow', () => {
  assert.equal(main.settings.errorWorkflow, alert.id);
  assert.equal(heartbeat.settings.errorWorkflow, alert.id);
  assert.equal(alert.settings.errorWorkflow, undefined, 'the alert workflow does not alert about itself');
  assert.equal(node('When a run fails', alert).type, 'n8n-nodes-base.errorTrigger');
});

test('both alert emails go to the configured address through Gmail', () => {
  for (const [workflow, name] of [
    [alert, 'Send failure alert'],
    [heartbeat, 'Send heartbeat alert'],
  ]) {
    const send = node(name, workflow);
    assert.equal(send.type, 'n8n-nodes-base.gmail');
    assert.equal(send.parameters.sendTo, '={{ $env.MAIL_TO }}');
    assert.equal(send.parameters.subject, '={{ $json.subject }}');
  }
});

test('the heartbeat runs at 10:00 every day and only emails when a run is overdue', () => {
  assert.deepEqual(node('Every day at 10:00', heartbeat).parameters.rule.interval, [
    { field: 'days', daysInterval: 1, triggerAtHour: 10, triggerAtMinute: 0 },
  ]);
  const [whenOverdue, otherwise] = heartbeat.connections['Run overdue?'].main;
  assert.deepEqual(whenOverdue.map((link) => link.node), ['Send heartbeat alert']);
  assert.deepEqual(otherwise, []);
  assert.equal(node('Run overdue?', heartbeat).parameters.conditions.conditions[0].leftValue, '={{ $json.alert }}');
});

test('the alert workflows never call the time tracker', () => {
  for (const workflow of [alert, heartbeat]) {
    assert.deepEqual(workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest'), []);
  }
});
