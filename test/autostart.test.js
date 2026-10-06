const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPlist } = require('../scripts/autostart.js');

test('the launch agent runs "npm run n8n" from the project folder with the given node', () => {
  const plist = buildPlist('/opt/node/bin/node', '/Users/someone/n8n-timesheet-check');

  assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/opt\/node\/lib\/node_modules\/npm\/bin\/npm-cli\.js<\/string>\s*<string>run<\/string>\s*<string>n8n<\/string>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/someone\/n8n-timesheet-check<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/node\/bin:/);
});

test('the launch agent starts at login and restarts n8n if it exits', () => {
  const plist = buildPlist('/opt/node/bin/node', '/Users/someone/n8n-timesheet-check');

  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test('characters that are special in XML are escaped in paths', () => {
  const plist = buildPlist('/opt/node/bin/node', '/Users/someone/R&D <checks>');

  assert.match(plist, /<string>\/Users\/someone\/R&amp;D &lt;checks&gt;<\/string>/);
});
