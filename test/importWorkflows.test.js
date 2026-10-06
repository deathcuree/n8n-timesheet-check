const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attachCredentials } = require('../scripts/import-workflows.js');

const workflow = {
  name: 'Example',
  nodes: [
    { name: 'Trigger', parameters: {} },
    { name: 'Read sheet', credentials: { googleSheetsOAuth2Api: { id: 'SELECT_IN_N8N', name: 'Google Sheets - timesheet check' } } },
    { name: 'Send mail', credentials: { gmailOAuth2: { id: 'SELECT_IN_N8N', name: 'Gmail - timesheet check' } } },
  ],
};
const credentialOf = (attached, nodeName) => Object.values(attached.nodes.find((n) => n.name === nodeName).credentials)[0];

test('a credential with the expected name is attached, even when others of that type exist', () => {
  const attached = attachCredentials(workflow, [
    { id: 'a1', name: 'Some other sheets login', type: 'googleSheetsOAuth2Api' },
    { id: 'a2', name: 'Google Sheets - timesheet check', type: 'googleSheetsOAuth2Api' },
    { id: 'b1', name: 'Gmail - timesheet check', type: 'gmailOAuth2' },
  ]);

  assert.deepEqual(credentialOf(attached, 'Read sheet'), { id: 'a2', name: 'Google Sheets - timesheet check' });
  assert.deepEqual(credentialOf(attached, 'Send mail'), { id: 'b1', name: 'Gmail - timesheet check' });
});

test('with one credential of the type, it is attached whatever its name', () => {
  const attached = attachCredentials(workflow, [
    { id: 'a1', name: 'Google Sheets account', type: 'googleSheetsOAuth2Api' },
    { id: 'b1', name: 'Gmail account', type: 'gmailOAuth2' },
  ]);

  assert.deepEqual(credentialOf(attached, 'Read sheet'), { id: 'a1', name: 'Google Sheets account' });
  assert.equal(workflow.nodes[1].credentials.googleSheetsOAuth2Api.id, 'SELECT_IN_N8N', 'the input is not changed');
  assert.equal(attached.nodes[0].credentials, undefined);
});

test('a missing credential stops the import and says what to create', () => {
  assert.throws(
    () => attachCredentials(workflow, [{ id: 'a1', name: 'Google Sheets account', type: 'googleSheetsOAuth2Api' }]),
    /"Send mail" needs a "gmailOAuth2" credential.*Gmail - timesheet check/s,
  );
});

test('several credentials of a type with none named as expected stops the import', () => {
  assert.throws(
    () =>
      attachCredentials(workflow, [
        { id: 'a1', name: 'Sheets one', type: 'googleSheetsOAuth2Api' },
        { id: 'a2', name: 'Sheets two', type: 'googleSheetsOAuth2Api' },
        { id: 'b1', name: 'Gmail account', type: 'gmailOAuth2' },
      ]),
    /"Read sheet".*has 2 \(Sheets one, Sheets two\).*Rename/s,
  );
});
