#!/usr/bin/env node
// Runs the actual device-code sign-in. Launched by login-helper.mjs as an
// independent process whose stdout/stderr are already redirected to log files.
//
// Nothing here may depend on PATH. The host spawns MCP servers with an
// environment that does not necessarily contain the Node or npm bin directory.
// Observed failures when it did:
//   'npx' is not recognized              — npx itself not on PATH
//   '"node"' is not recognized           — npm's bin shim invokes node by name
//   'ms-365-mcp-server' is not recognized — npx could not launch the package bin
//
// So the server package is a declared dependency of this plugin, and we run its
// entry script directly with the Node binary already executing this file. No
// npx, no shell, no PATH lookup, and arguments passed as an array so the quoted
// --allowed-scopes value cannot be split.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, delimiter } from 'node:path';

const PKG = '@softeria/ms-365-mcp-server';
const VERSION = '0.145.0';
const SCOPES = 'Mail.ReadWrite Mail.Send Calendars.ReadWrite User.Read';
const ARGS = ['--preset', 'outlook', '--allowed-scopes', SCOPES, '--login'];

const nodeDir = dirname(process.execPath);
const env = { ...process.env, PATH: nodeDir + delimiter + (process.env.PATH ?? '') };

const done = (code) => {
  console.log(`\n__RUNNER_EXIT__ ${code}`);
  process.exit(code);
};

// Preferred: the copy installed as this plugin's own dependency.
const resolveBundled = () => {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve(`${PKG}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0];
    const entry = join(dirname(pkgJsonPath), bin ?? pkg.main ?? 'dist/index.js');
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
};

// Fallback only: npm's npx-cli.js by absolute path, if the dependency is absent
// (for example the plugin's dependency install was skipped).
const resolveNpxCli = () =>
  [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ].find((p) => existsSync(p)) ?? null;

const entry = resolveBundled();
let child;

if (entry) {
  console.log(`[runner] using bundled dependency: ${entry}`);
  child = spawn(process.execPath, [entry, ...ARGS], { stdio: 'inherit', env });
} else {
  const npxCli = resolveNpxCli();
  if (!npxCli) {
    console.error(
      `Could not find ${PKG} as a plugin dependency, and could not locate npx-cli.js ` +
        `next to the Node binary at ${process.execPath}. The plugin's dependency install ` +
        `may have failed; reinstalling the plugin should fix it.`
    );
    done(1);
  }
  console.log('[runner] bundled dependency missing, falling back to npx');
  child = spawn(process.execPath, [npxCli, '-y', `${PKG}@${VERSION}`, ...ARGS], {
    stdio: 'inherit',
    env,
  });
}

// Emit a sentinel when the sign-in ends. Without it, a run that died is
// indistinguishable from one still waiting on the browser, and status reports
// "pending" forever.
child.on('exit', (code) => done(code ?? 0));
child.on('error', (e) => {
  console.error('runner failed to start sign-in: ' + (e?.message ?? e));
  done(1);
});
