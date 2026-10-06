// Checks that each time tracker response has the shape the workflow relies on.
// Each check throws an Error naming the endpoint and the missing field, which
// stops the run before anything is written or sent.
//
// This file has no imports so the same text can be pasted into an n8n Code
// node unchanged.

function isMissing(value) {
  return value === undefined || value === null;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Reads a dotted path such as "user._id".
function readPath(object, path) {
  return path.split('.').reduce((value, part) => (isObject(value) ? value[part] : undefined), object);
}

function requireFields(endpoint, label, object, fields) {
  for (const field of fields) {
    if (isMissing(readPath(object, field))) {
      throw new Error(`${endpoint} response: ${label} is missing "${field}"`);
    }
  }
}

function requirePage(endpoint, body, paginationFields, itemFields) {
  if (!isObject(body) || !Array.isArray(body.items)) {
    throw new Error(`${endpoint} response: missing the "items" list`);
  }
  if (!isObject(body.pagination)) {
    throw new Error(`${endpoint} response: missing "pagination"`);
  }
  for (const field of paginationFields) {
    if (typeof body.pagination[field] !== 'number') {
      throw new Error(`${endpoint} response: missing "pagination.${field}"`);
    }
  }
  body.items.forEach((item, index) => requireFields(endpoint, `item ${index + 1}`, item, itemFields));
}

// POST /api/auth/login. The account must be read-only, so the workflow never
// runs with a login that could change anything.
function checkLogin(body) {
  if (!isObject(body) || body.success !== true) {
    throw new Error('Login response: "success" is not true');
  }
  if (!isObject(body.data) || !isObject(body.data.user)) {
    throw new Error('Login response: missing "data.user"');
  }
  const role = body.data.user.role;
  if (role !== 'readonly') {
    throw new Error(`Login response: the account's role is "${role}", but it must be "readonly"`);
  }
}

// GET /api/admin/time/logs. clockOut is not required: it is null on an open entry.
function checkTimeLogs(body) {
  requirePage(
    'Time logs',
    body,
    ['total', 'page', 'pages'],
    ['_id', 'user', 'user._id', 'date', 'clockIn', 'hours', 'breakHours', 'status'],
  );
}

// GET /api/pto/all
function checkPtoRequests(body) {
  requirePage(
    'PTO requests',
    body,
    ['currentPage', 'totalPages', 'totalItems', 'itemsPerPage'],
    ['_id', 'date', 'hours', 'status', 'createdAt', 'userId', 'userId._id'],
  );
}

// GET /api/admin/users
function checkUsers(body) {
  if (!Array.isArray(body)) {
    throw new Error('Users response: expected a list of users');
  }
  if (body.length === 0) {
    throw new Error('Users response: the list is empty');
  }
  body.forEach((user, index) =>
    requireFields('Users', `item ${index + 1}`, user, ['_id', 'firstName', 'lastName', 'email', 'role', 'createdAt']),
  );
}

// Lets the tests load this file; has no effect inside an n8n Code node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { checkLogin, checkTimeLogs, checkPtoRequests, checkUsers };
}
