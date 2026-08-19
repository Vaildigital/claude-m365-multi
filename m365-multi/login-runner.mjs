#!/usr/bin/env node
// Runs the device-code sign-in. Launched by login-helper.mjs as an independent
// process whose stdout/stderr are already redirected to log files.
//
// Nothing here depends on PATH, on npx, or on anything being installed. The host
// spawns MCP servers with an environment that does not necessarily contain the
// Node or npm bin directory; earlier versions failed with "'npx' is not
// recognized", "'\"node\"' is not recognized" and "'ms-365-mcp-server' is not
// recognized" in exactly that situation.
//
// The server is vendored as a single file under vendor/. We run it with the Node
// binary already executing this file. No shell, no lookup, no network fetch, and
// arguments passed as an array so the quoted --allowed-scopes value cannot be
// split.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mail.Send is deliberately absent. The agent reads untrusted email content, so
// granting it send rights creates a prompt-injection path to sending mail from
// the user's mailboxes. Drafting needs only Mail.ReadWrite; a human sends from
// Outlook. See SECURITY-REVIEW.md.
const SCOPES = 'Mail.ReadWrite Calendars.ReadWrite User.Read';
const ARGS = ['--preset', 'outlook', '--allowed-scopes', SCOPES, '--login'];

const here = dirname(fileURLToPath(import.meta.url));
const nodeDir = dirname(process.execPath);
const env = { ...process.env, PATH: nodeDir + delimiter + (process.env.PATH ?? '') };

const done = (code) => {
  console.log(`\n__RUNNER_EXIT__ ${code}`);
  process.exit(code);
};

const entry = join(here, 'vendor', 'ms365-server.mjs');

if (!existsSync(entry)) {
  // No fallback by design. A previous version fell back to `npx -y <pkg>`, which
  // fetched and executed code from the network at runtime — silently swapping
  // unreviewed code in for the vendored bundle. Failing loudly is correct.
  console.error(
    `The vendored server is missing at ${entry}. The plugin install is incomplete or ` +
      `corrupt; reinstall it. This plugin never downloads code at runtime.`
  );
  done(1);
}

const child = spawn(process.execPath, [entry, ...ARGS], { stdio: 'inherit', env });

// Emit a sentinel when the sign-in ends. Without it, a run that died is
// indistinguishable from one still waiting on the browser, and status reports
// "pending" forever.
child.on('exit', (code) => done(code ?? 0));
child.on('error', (e) => {
  console.error('runner failed to start sign-in: ' + (e?.message ?? e));
  done(1);
});
