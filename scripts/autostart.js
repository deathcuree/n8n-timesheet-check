// Keeps n8n running in the background on macOS, without an open terminal:
//
//   npm run autostart          start n8n now, and again at every login
//   npm run autostart:remove   stop it and stop starting it at login
//
// It installs a launch agent that runs "npm run n8n" from this folder and
// restarts it if it exits. Output goes to ~/Library/Logs/n8n-timesheet-check.log.
//
// The agent uses the node this script is run with. Run it again after
// changing node versions or moving this folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LABEL = 'com.n8n-timesheet-check';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'n8n-timesheet-check.log');
const DOMAIN = `gui/${os.userInfo().uid}`;

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Returns the launch agent's plist for the given node binary and project folder. */
function buildPlist(nodePath, root) {
  const binDir = path.dirname(nodePath);
  const npmCli = path.join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const string = (text) => `<string>${escapeXml(text)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	${string(LABEL)}
	<key>ProgramArguments</key>
	<array>
		${string(nodePath)}
		${string(npmCli)}
		<string>run</string>
		<string>n8n</string>
	</array>
	<key>WorkingDirectory</key>
	${string(root)}
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		${string(`${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`)}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>60</integer>
	<key>StandardOutPath</key>
	${string(LOG)}
	<key>StandardErrorPath</key>
	${string(LOG)}
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
`;
}

function launchctl(args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

async function n8nIsRunning() {
  try {
    await fetch('http://localhost:5678/healthz', { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

function remove() {
  launchctl(['bootout', `${DOMAIN}/${LABEL}`]);
  fs.rmSync(PLIST, { force: true });
  console.log('n8n is stopped and will no longer start at login.');
}

async function install() {
  if (process.platform !== 'darwin') {
    throw new Error('Autostart uses a macOS launch agent, so it only works on macOS.');
  }
  const installed = launchctl(['print', `${DOMAIN}/${LABEL}`]).status === 0;
  if (!installed && (await n8nIsRunning())) {
    throw new Error('n8n is already running in a terminal. Stop it first (Ctrl+C), then run this again.');
  }

  launchctl(['bootout', `${DOMAIN}/${LABEL}`]);
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, buildPlist(process.execPath, ROOT));
  const result = launchctl(['bootstrap', DOMAIN, PLIST]);
  if (result.status !== 0) {
    throw new Error(`launchctl could not load the launch agent:\n${(result.stdout + result.stderr).trim()}`);
  }
  console.log(`n8n now starts at login and is starting now at http://localhost:5678.\nLog: ${LOG}`);
}

if (require.main === module) {
  const run = process.argv[2] === 'remove' ? async () => remove() : install;
  run().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { buildPlist };
