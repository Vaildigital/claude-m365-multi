#!/usr/bin/env node
// Runs the actual device-code sign-in. Launched by login-helper.mjs as an
// independent process whose stdout/stderr are already redirected to log files.
//
// Nothing here may depend on PATH. The host spawns MCP servers with an
// environment that does not necessarily contain the Node or npm bin directory —
// observed in Cowork on Windows as `'npx' is not recognized`, and before that as
// the package binary not being found. The main server escapes this because the
// host resolves its `npx` command itself.
//
// So: run npm's own npx-cli.js with the absolute path of the Node binary already
// executing this file. No shell, no PATH lookup, and arguments passed as an
// array so the quoted --allowed-scopes value cannot be split.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';

const PKG = '@softeria/ms-365-mcp-server@0.145.0';
const SCOPES = 'Mail.ReadWrite Mail.Send Calendars.ReadWrite User.Read';
const ARGS = ['--preset', 'outlook', '--allowed-scopes', SCOPES, '--login'];

const nodeDir = dirname(process.execPath);
const candidates = [
  join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'), // Windows layout
  join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), // POSIX layout
  join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
];
const npxCli = candidates.find((p) => existsSync(p));

const done = (code) => {
  console.log(`\n__RUNNER_EXIT__ ${code}`);
  process.exit(code);
};

if (!npxCli) {
  console.error(
    'Could not locate npx-cli.js next to the Node binary at ' +
      process.execPath +
      '. Looked in:\n  ' +
      candidates.join('\n  ')
  );
  done(1);
}

// Resolving npx-cli.js absolutely is not sufficient on its own: npm installs the
// package's bin as a shim that invokes `node` by name, so the shim still fails
// with `'"node"' is not recognized` when PATH lacks the Node directory. Put it
// on PATH for the child.
const env = { ...process.env, PATH: nodeDir + delimiter + (process.env.PATH ?? '') };

const child = spawn(process.execPath, [npxCli, '-y', PKG, ...ARGS], { stdio: 'inherit', env });

// Emit a sentinel when the sign-in ends. Without it, a run that died is
// indistinguishable from one still waiting on the browser, and status reports
// "pending" forever.
child.on('exit', (code) => done(code ?? 0));
child.on('error', (e) => {
  console.error('runner failed to start sign-in: ' + (e?.message ?? e));
  done(1);
});
