// Builds the importable n8n workflow files in workflows/ from the tested
// source files in src/.
//
//   npm run build
//
// Each Code node holds the exact text of one or more src/ files followed by a
// few lines of glue that read the node's input and return its output. A test
// fails if the committed workflow differs from what this script produces, so
// the code running in n8n cannot drift from the code under test.
//
// Written for n8n 2.41.6.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');

// Names the credentials must have in n8n. The ids are placeholders: after
// importing, pick the matching credential on each node that asks for one.
const CREDENTIALS = {
  timeTracker: { httpCustomAuth: { id: 'SELECT_IN_N8N', name: 'Time tracker read-only login' } },
  sheets: { googleSheetsOAuth2Api: { id: 'SELECT_IN_N8N', name: 'Google Sheets - timesheet check' } },
  gmail: { gmailOAuth2: { id: 'SELECT_IN_N8N', name: 'Gmail - timesheet check' } },
  gemini: { googlePalmApi: { id: 'SELECT_IN_N8N', name: 'Gemini - timesheet check' } },
};

// Values that differ per installation come from environment variables, so
// they never appear in this file. See .env.example.
const API = '={{ $env.TIME_TRACKER_API_URL }}';
const SHEET = { __rl: true, mode: 'id', value: '={{ $env.SHEET_ID }}' };
const tab = (name) => ({ __rl: true, mode: 'name', value: name });

const stableId = (name) => {
  const hex = crypto.createHash('sha1').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

// ---------------------------------------------------------------------------
// Code node contents: source files, then glue.
// ---------------------------------------------------------------------------

const code = (files, glue, header = '') =>
  [header, ...files.map(source), `// ---- n8n glue: reads this node's input and returns its output ----\n${glue.trim()}\n`]
    .filter(Boolean)
    .join('\n');

const CODE = {
  'Work out days to check': {
    files: ['daysToCheck.js'],
    glue: `
const now = new Date();
const days = daysToCheck(lastCoveredDay($input.all().map((item) => item.json)), now);
// The time tracker stores each day as midnight in Manila (UTC+8).
const startOfDay = (day) => new Date(day + 'T00:00:00+08:00').toISOString();
return [
  {
    json: {
      runAt: now.toISOString(),
      days,
      startDate: startOfDay(days[0]),
      endDate: startOfDay(days[days.length - 1]),
    },
  },
];`,
  },

  'Check login': {
    files: ['shapeChecks.js'],
    glue: `
const response = $input.first().json;
checkLogin(response.body);
const cookies = [].concat((response.headers ?? {})['set-cookie'] ?? []);
const token = cookies.map((cookie) => String(cookie).split(';')[0]).find((cookie) => cookie.startsWith('token='));
if (!token) {
  throw new Error('Login response: no "token" cookie was set');
}
return [{ json: { cookie: token } }];`,
  },

  'Find exceptions': {
    header: `// Settings. Anything left out keeps the default from DEFAULT_SETTINGS below.
const SETTINGS = {
  // Dates (YYYY-MM-DD) nobody is expected to work, besides weekends.
  holidays: [],
};
`,
    files: ['shapeChecks.js', 'findExceptions.js'],
    glue: `
const plan = $('Work out days to check').first().json;
const pages = (nodeName) => $(nodeName).all().map((item) => item.json);

// Checks every page, joins the items, and makes sure no page went missing.
const collect = (nodeName, check, totalOf) => {
  const bodies = pages(nodeName);
  bodies.forEach(check);
  const items = bodies.flatMap((body) => body.items);
  const expected = totalOf(bodies[bodies.length - 1].pagination);
  if (items.length !== expected) {
    throw new Error(nodeName + ': read ' + items.length + ' items but the time tracker reports ' + expected);
  }
  return items;
};

const entries = collect('Get time logs', checkTimeLogs, (pagination) => pagination.total);
const openEntries = collect('Get open entries', checkTimeLogs, (pagination) => pagination.total);
const ptoRequests = collect('Get PTO requests', checkPtoRequests, (pagination) => pagination.totalItems);
const users = pages('Get users');
checkUsers(users);

const exceptions = findExceptions(
  { daysToCheck: plan.days, entries, openEntries, users, ptoRequests },
  SETTINGS,
  new Date(plan.runAt),
);
return [{ json: { runAt: plan.runAt, days: plan.days, exceptions } }];`,
  },

  'Prepare report': {
    files: ['report.js', 'llmSummary.js'],
    glue: `
const found = $('Find exceptions').first().json;
const existingKeys = $input.all().map((item) => item.json.key).filter(Boolean);
const exceptions = markReported(found.exceptions, existingKeys);
const payload = buildLlmPayload(exceptions);
return [
  {
    json: {
      runAt: found.runAt,
      days: found.days,
      exceptions,
      newRows: sheetRows(exceptions, found.runAt),
      // llmItems is all that is sent to the model. names stays here.
      llmItems: payload.items,
      names: payload.names,
      needsSummary: exceptions.length > 0,
    },
  },
];`,
  },

  'Build email': {
    files: ['llmSummary.js', 'report.js'],
    glue: `
const report = $('Prepare report').first().json;
let summary = null;
let summaryProblem = null;
if (report.needsSummary) {
  const reply = $('Summarise').isExecuted ? ($('Summarise').first() ?? {}).json ?? {} : {};
  const parts = reply.content && Array.isArray(reply.content.parts) ? reply.content.parts : [];
  const text = parts.map((part) => part.text ?? '').join('').trim();
  const verdict = reply.error ? { ok: false, reason: 'the model could not be reached' } : checkLlmReply(text, report.names);
  if (verdict.ok) {
    summary = restoreNames(text, report.names);
  } else {
    summaryProblem = verdict.reason;
  }
}
const email = buildEmail({ days: report.days, exceptions: report.exceptions, summary, summaryProblem });
return [
  {
    json: {
      subject: email.subject,
      html: email.html,
      summaryUsed: summary !== null,
      summaryProblem,
      newRows: report.newRows,
      runRow: runRow(report.runAt, report.days, report.exceptions),
    },
  },
];`,
  },

  'Run history row': {
    files: [],
    glue: `return [{ json: $('Build email').first().json.runRow }];`,
  },

  // Failure-alert workflow
  'Build failure alert': {
    files: ['alerts.js'],
    glue: `return [{ json: buildFailureAlert($input.first().json) }];`,
  },

  // Heartbeat workflow
  'Check heartbeat': {
    files: ['alerts.js'],
    glue: `return [{ json: checkHeartbeat($input.all().map((item) => item.json), new Date()) }];`,
  },
};

const PROMPT = `={{ "These are today's timesheet exceptions as JSON. Each has a placeholder for the person (null means the whole team), a type and a day.\\n\\n" + JSON.stringify($json.llmItems) + "\\n\\nWrite a summary of at most five sentences for the person who manages the team. Refer to people only by the placeholders given, exactly as written. Do not invent names, hours or reasons. Plain text only." }}`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const codeNode = (name) => ({
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  parameters: { jsCode: code(CODE[name].files, CODE[name].glue, CODE[name].header) },
});

const sheetRead = (name, tabName) => ({
  name,
  type: 'n8n-nodes-base.googleSheets',
  typeVersion: 4.7,
  parameters: { resource: 'sheet', operation: 'read', documentId: SHEET, sheetName: tab(tabName), options: {} },
  credentials: CREDENTIALS.sheets,
  // An empty tab still passes one empty item on, so the run continues.
  alwaysOutputData: true,
  executeOnce: true,
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 3000,
});

const sheetAppend = (name, tabName) => ({
  name,
  type: 'n8n-nodes-base.googleSheets',
  typeVersion: 4.7,
  parameters: {
    resource: 'sheet',
    operation: 'append',
    documentId: SHEET,
    sheetName: tab(tabName),
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
    // RAW keeps dates and keys as plain text instead of letting Sheets reformat them.
    options: { cellFormat: 'RAW', handlingExtraData: 'error' },
  },
  credentials: CREDENTIALS.sheets,
});

const apiGet = (name, endpoint, query, completeWhen) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.5,
  parameters: {
    method: 'GET',
    url: `${API}${endpoint}`,
    ...(query.length > 0
      ? { sendQuery: true, queryParameters: { parameters: query.map(([n, value]) => ({ name: n, value })) } }
      : {}),
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Cookie', value: "={{ $('Check login').first().json.cookie }}" }] },
    options: completeWhen
      ? {
          pagination: {
            pagination: {
              paginationMode: 'updateAParameterInEachRequest',
              parameters: { parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }] },
              paginationCompleteWhen: 'other',
              completeExpression: completeWhen,
              limitPagesFetched: true,
              maxRequests: 50,
            },
          },
        }
      : {},
  },
  executeOnce: true,
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 3000,
});

const DAYS = "$('Work out days to check').first().json";

const NODES = [
  {
    name: 'Every morning at 8:00',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.3,
    parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 8, triggerAtMinute: 0 }] } },
  },
  { name: 'Run by hand', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },

  sheetRead('Read run history', 'Runs'),
  codeNode('Work out days to check'),

  {
    name: 'Log in',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.5,
    parameters: {
      method: 'POST',
      url: `${API}/auth/login`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      // The email and password come from the credential, which adds them to the request body.
      options: { response: { response: { fullResponse: true } } },
    },
    credentials: CREDENTIALS.timeTracker,
    // At most two retries: five failed logins lock the account out for 15 minutes.
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
  },
  codeNode('Check login'),

  apiGet(
    'Get time logs',
    '/admin/time/logs',
    [
      ['startDate', `={{ ${DAYS}.startDate }}`],
      ['endDate', `={{ ${DAYS}.endDate }}`],
      ['limit', '100'],
    ],
    '={{ !$response.body.pagination || $response.body.pagination.page >= $response.body.pagination.pages }}',
  ),
  apiGet(
    'Get open entries',
    '/admin/time/logs',
    [
      ['status', 'active'],
      ['limit', '100'],
    ],
    '={{ !$response.body.pagination || $response.body.pagination.page >= $response.body.pagination.pages }}',
  ),
  apiGet(
    'Get PTO requests',
    '/pto/all',
    [['limit', '100']],
    '={{ !$response.body.pagination || $response.body.pagination.currentPage >= $response.body.pagination.totalPages }}',
  ),
  // An empty user list still passes one empty item on, which then fails the shape check.
  { ...apiGet('Get users', '/admin/users', [], null), alwaysOutputData: true },

  codeNode('Find exceptions'),
  sheetRead('Read reported keys', 'Exceptions'),
  codeNode('Prepare report'),

  {
    name: 'Anything to summarise?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: stableId('condition: needs summary'),
            leftValue: '={{ $json.needsSummary }}',
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  },
  {
    name: 'Summarise',
    type: '@n8n/n8n-nodes-langchain.googleGemini',
    typeVersion: 1.2,
    parameters: {
      resource: 'text',
      operation: 'message',
      // The model this n8n version selects by default. Pick another from the node's list if it is retired.
      modelId: { __rl: true, mode: 'id', value: 'models/gemini-3-flash-preview' },
      messages: { values: [{ content: PROMPT, role: 'user' }] },
      simplify: true,
      jsonOutput: false,
      builtInTools: {},
      options: { temperature: 0.2 },
    },
    credentials: CREDENTIALS.gemini,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    // A failure here must not stop the report: the email goes out without the summary.
    onError: 'continueRegularOutput',
  },
  codeNode('Build email'),

  {
    name: 'Any new rows?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: stableId('condition: new rows'),
            leftValue: '={{ $json.newRows.length }}',
            rightValue: 0,
            operator: { type: 'number', operation: 'gt' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  },
  {
    name: 'One item per new row',
    type: 'n8n-nodes-base.splitOut',
    typeVersion: 1,
    parameters: { fieldToSplitOut: 'newRows', options: {} },
  },
  sheetAppend('Append exceptions', 'Exceptions'),

  {
    name: 'Send summary',
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.2,
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: '={{ $env.MAIL_TO }}',
      subject: "={{ $('Build email').first().json.subject }}",
      emailType: 'html',
      message: "={{ $('Build email').first().json.html }}",
      options: { appendAttribution: false },
    },
    credentials: CREDENTIALS.gmail,
    executeOnce: true,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
  },
  codeNode('Run history row'),
  // Written last: a run that failed anywhere above leaves no row, so the next run covers the same days again.
  sheetAppend('Append run', 'Runs'),
];

// name -> [next node, ...]; an IF node lists [when true, when false].
const FLOW = {
  'Every morning at 8:00': ['Read run history'],
  'Run by hand': ['Read run history'],
  'Read run history': ['Work out days to check'],
  'Work out days to check': ['Log in'],
  'Log in': ['Check login'],
  'Check login': ['Get time logs'],
  'Get time logs': ['Get open entries'],
  'Get open entries': ['Get PTO requests'],
  'Get PTO requests': ['Get users'],
  'Get users': ['Find exceptions'],
  'Find exceptions': ['Read reported keys'],
  'Read reported keys': ['Prepare report'],
  'Prepare report': ['Anything to summarise?'],
  'Anything to summarise?': { true: ['Summarise'], false: ['Build email'] },
  Summarise: ['Build email'],
  'Build email': ['Any new rows?'],
  'Any new rows?': { true: ['One item per new row'], false: ['Send summary'] },
  'One item per new row': ['Append exceptions'],
  'Append exceptions': ['Send summary'],
  'Send summary': ['Run history row'],
  'Run history row': ['Append run'],
};

const LAYOUT = [
  ['Every morning at 8:00', 'Read run history', 'Work out days to check', 'Log in', 'Check login'],
  ['Get time logs', 'Get open entries', 'Get PTO requests', 'Get users', 'Find exceptions'],
  ['Read reported keys', 'Prepare report', 'Anything to summarise?', 'Summarise', 'Build email'],
  ['Any new rows?', 'One item per new row', 'Append exceptions', 'Send summary', 'Run history row', 'Append run'],
];

// ---------------------------------------------------------------------------
// Failure-alert workflow: n8n starts it whenever one of the other two fails.
// ---------------------------------------------------------------------------

const gmailSend = (name) => ({
  name,
  type: 'n8n-nodes-base.gmail',
  typeVersion: 2.2,
  parameters: {
    resource: 'message',
    operation: 'send',
    sendTo: '={{ $env.MAIL_TO }}',
    subject: '={{ $json.subject }}',
    emailType: 'html',
    message: '={{ $json.html }}',
    options: { appendAttribution: false },
  },
  credentials: CREDENTIALS.gmail,
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
});

const ALERT_NODES = [
  { name: 'When a run fails', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, parameters: {} },
  codeNode('Build failure alert'),
  gmailSend('Send failure alert'),
];
const ALERT_FLOW = {
  'When a run fails': ['Build failure alert'],
  'Build failure alert': ['Send failure alert'],
};
const ALERT_LAYOUT = [['When a run fails', 'Build failure alert', 'Send failure alert']];

// ---------------------------------------------------------------------------
// Heartbeat workflow: warns when no run has been recorded for too long.
// ---------------------------------------------------------------------------

const HEARTBEAT_NODES = [
  {
    name: 'Every day at 10:00',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.3,
    parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 10, triggerAtMinute: 0 }] } },
  },
  { name: 'Run by hand', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
  sheetRead('Read run history', 'Runs'),
  codeNode('Check heartbeat'),
  {
    name: 'Run overdue?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: stableId('condition: run overdue'),
            leftValue: '={{ $json.alert }}',
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  },
  gmailSend('Send heartbeat alert'),
];
const HEARTBEAT_FLOW = {
  'Every day at 10:00': ['Read run history'],
  'Run by hand': ['Read run history'],
  'Read run history': ['Check heartbeat'],
  'Check heartbeat': ['Run overdue?'],
  'Run overdue?': { true: ['Send heartbeat alert'], false: [] },
};
const HEARTBEAT_LAYOUT = [['Every day at 10:00', 'Read run history', 'Check heartbeat', 'Run overdue?', 'Send heartbeat alert']];

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

// Fixed workflow ids, so "npm run import" replaces the same three workflows
// every time and the other two can name the failure-alert workflow.
const WORKFLOWS = {
  main: {
    id: 'timesheetCheck',
    name: 'Timesheet check',
    nodes: NODES,
    flow: FLOW,
    layout: LAYOUT,
    onFailure: 'alert',
  },
  alert: {
    id: 'timesheetCheckFailureAlert',
    name: 'Timesheet check - failure alert',
    nodes: ALERT_NODES,
    flow: ALERT_FLOW,
    layout: ALERT_LAYOUT,
  },
  heartbeat: {
    id: 'timesheetCheckHeartbeat',
    name: 'Timesheet check - heartbeat',
    nodes: HEARTBEAT_NODES,
    flow: HEARTBEAT_FLOW,
    layout: HEARTBEAT_LAYOUT,
    onFailure: 'alert',
  },
};

function position(layout, name) {
  if (name === 'Run by hand') return [0, 180];
  for (let row = 0; row < layout.length; row++) {
    const column = layout[row].indexOf(name);
    if (column !== -1) return [column * 240, row * 260];
  }
  throw new Error(`No canvas position for "${name}"`);
}

const link = (names) => names.map((node) => ({ node, type: 'main', index: 0 }));

function connections(flow) {
  const result = {};
  for (const [from, to] of Object.entries(flow)) {
    result[from] = { main: Array.isArray(to) ? [link(to)] : [link(to.true), link(to.false)] };
  }
  return result;
}

// For the local test run only: stands in for Google and Gemini so the rest of
// each workflow can be executed without anyone's accounts. Never written to workflows/.
const STUBS = {
  main: {
    'Read run history': `return ($env.STUB_LAST_COVERED ? [{ json: { run_at: 'earlier', days_covered: $env.STUB_LAST_COVERED } }] : [{ json: {} }]);`,
    'Read reported keys': `return ($env.STUB_REPORTED_KEYS ? $env.STUB_REPORTED_KEYS.split(',').map((key) => ({ json: { key } })) : [{ json: {} }]);`,
    Summarise: `if ($env.STUB_LLM === 'fail') throw new Error('stubbed model failure');
return [{ json: { content: { parts: [{ text: $env.STUB_LLM_REPLY ?? 'Person 1 needs attention.' }], role: 'model' } } }];`,
    'Append exceptions': `return $input.all();`,
    'Send summary': `return [{ json: { sentTo: $env.MAIL_TO, subject: $('Build email').first().json.subject } }];`,
    'Append run': `return $input.all();`,
  },
  alert: {
    'Send failure alert': `return [{ json: { sentTo: $env.MAIL_TO, subject: $json.subject, html: $json.html } }];`,
  },
  heartbeat: {
    'Read run history': `return ($env.STUB_RUN_AT ? $env.STUB_RUN_AT.split(',').map((run_at) => ({ json: { run_at } })) : [{ json: {} }]);`,
    'Send heartbeat alert': `return [{ json: { sentTo: $env.MAIL_TO, subject: $json.subject, html: $json.html } }];`,
  },
};

function withStubs(key, nodes) {
  const stubs = STUBS[key];
  return nodes.map((node) => {
    if (stubs[node.name]) {
      const { credentials, type, typeVersion, parameters, ...settings } = node;
      return {
        ...settings,
        name: node.name,
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        parameters: { jsCode: stubs[node.name] },
      };
    }
    // Small pages, so a handful of sample records is enough to exercise paging.
    const query = node.parameters.queryParameters?.parameters;
    if (!query) return node;
    const smallPages = query.map((parameter) => (parameter.name === 'limit' ? { ...parameter, value: '10' } : parameter));
    return { ...node, parameters: { ...node.parameters, queryParameters: { parameters: smallPages } } };
  });
}

const LOCAL_TEST_CREDENTIAL = { httpCustomAuth: { id: 'localTestTimeTracker', name: 'Local test login' } };
const LOCAL_TEST_SUFFIX = 'LocalTest';

function buildWorkflow(key, { stubExternal = false } = {}) {
  const definition = WORKFLOWS[key];
  const suffix = stubExternal ? LOCAL_TEST_SUFFIX : '';
  const nodes = (stubExternal ? withStubs(key, definition.nodes) : definition.nodes).map((node) => ({
    id: stableId(`${definition.id}: ${node.name}`),
    position: position(definition.layout, node.name),
    ...node,
    ...(stubExternal && node.credentials ? { credentials: LOCAL_TEST_CREDENTIAL } : {}),
  }));
  return {
    id: definition.id + suffix,
    name: definition.name + (stubExternal ? ' (local test copy)' : ''),
    nodes,
    connections: connections(definition.flow),
    settings: {
      executionOrder: 'v1',
      // The schedule and every date in the workflow use this timezone, whatever the computer is set to.
      timezone: 'Asia/Manila',
      // Any failure starts the failure-alert workflow, which emails what went wrong.
      ...(definition.onFailure ? { errorWorkflow: WORKFLOWS[definition.onFailure].id + suffix } : {}),
    },
    pinData: {},
    active: false,
  };
}

const OUTPUTS = {
  'workflows/timesheet-check.json': () => buildWorkflow('main'),
  'workflows/failure-alert.json': () => buildWorkflow('alert'),
  'workflows/heartbeat.json': () => buildWorkflow('heartbeat'),
};

const render = (workflow) => `${JSON.stringify(workflow, null, 2)}\n`;

if (require.main === module && process.argv[2] === '--local-test') {
  // node scripts/build-workflows.js --local-test <folder>: the stubbed copies, for a local n8n test run.
  fs.mkdirSync(process.argv[3], { recursive: true });
  for (const key of Object.keys(WORKFLOWS)) {
    const target = path.join(process.argv[3], `${key}.json`);
    fs.writeFileSync(target, render(buildWorkflow(key, { stubExternal: true })));
    console.log(`wrote ${target}`);
  }
} else if (require.main === module) {
  for (const [file, build] of Object.entries(OUTPUTS)) {
    const target = path.join(ROOT, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, render(build()));
    console.log(`wrote ${file}`);
  }
}

module.exports = { OUTPUTS, CODE, WORKFLOWS, buildWorkflow, render, source };
