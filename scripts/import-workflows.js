// Imports the three workflows into the local n8n and wires them up:
//
//   npm run import
//
// - attaches your existing n8n credentials to the nodes that need them
// - replaces the three workflows (they have fixed ids), so it is safe to rerun
// - publishes the failure-alert workflow, which n8n only starts when published
//
// The main and heartbeat workflows are left switched off. Switch them on in
// n8n when you want them to run on their schedule.
//
// Stop n8n before running this, then start it again with "npm run n8n".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const N8N = ['-y', 'n8n@2.41.6'];
const ALERT_WORKFLOW_ID = 'timesheetCheckFailureAlert';

/**
 * Returns a copy of the workflow with each credential placeholder replaced by
 * a real credential: the one with the same type and name, or, failing that,
 * the only credential of that type.
 */
function attachCredentials(workflow, credentials) {
  const pick = (type, wanted, nodeName) => {
    const ofType = credentials.filter((credential) => credential.type === type);
    const match = ofType.find((credential) => credential.name === wanted.name) ?? (ofType.length === 1 ? ofType[0] : null);
    if (match) return { id: match.id, name: match.name };
    if (ofType.length === 0) {
      throw new Error(`Node "${nodeName}" needs a "${type}" credential, but n8n has none. Create one named "${wanted.name}".`);
    }
    throw new Error(
      `Node "${nodeName}" needs a "${type}" credential and n8n has ${ofType.length} ` +
        `(${ofType.map((credential) => credential.name).join(', ')}). Rename the right one to "${wanted.name}".`,
    );
  };

  return {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      node.credentials
        ? {
            ...node,
            credentials: Object.fromEntries(
              Object.entries(node.credentials).map(([type, wanted]) => [type, pick(type, wanted, node.name)]),
            ),
          }
        : node,
    ),
  };
}

function n8n(args) {
  const result = spawnSync('npx', [...N8N, ...args], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`n8n ${args[0]} failed:\n${(result.stdout + result.stderr).trim().split('\n').slice(-6).join('\n')}`);
  }
  return result.stdout;
}

async function n8nIsRunning() {
  try {
    await fetch('http://localhost:5678/healthz', { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (await n8nIsRunning()) {
    throw new Error('n8n is running. Stop it first (Ctrl+C in its terminal, or "npm run autostart:remove"), run this again, then start it again.');
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'timesheet-check-'));
  try {
    // The export holds names, types and ids; the secret part stays encrypted.
    const credentialsFile = path.join(work, 'credentials.json');
    n8n(['export:credentials', '--all', `--output=${credentialsFile}`]);
    const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));

    const importDir = path.join(work, 'workflows');
    fs.mkdirSync(importDir);
    for (const file of fs.readdirSync(path.join(ROOT, 'workflows')).filter((name) => name.endsWith('.json'))) {
      const workflow = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', file), 'utf8'));
      fs.writeFileSync(path.join(importDir, file), JSON.stringify(attachCredentials(workflow, credentials)));
      console.log(`prepared ${workflow.name}`);
    }

    n8n(['import:workflow', '--separate', `--input=${importDir}`]);
    console.log('imported the three workflows');

    n8n(['publish:workflow', `--id=${ALERT_WORKFLOW_ID}`]);
    console.log('published the failure-alert workflow');
    console.log('\nDone. Start n8n with "npm run n8n". The main and heartbeat workflows are switched off until you publish them.');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { attachCredentials };
