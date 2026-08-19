#!/usr/bin/env node
// Runs the actual device-code sign-in. Launched by login-helper.mjs as an
// independent process whose stdout/stderr are already redirected to log files.
//
// Kept separate from the helper for two reasons:
//   1. The child is spawned ATTACHED here, which is the only form that reliably
//      redirects output on Windows.
//   2. Arguments are baked in rather than passed through a shell, so the quoted
//      --allowed-scopes value cannot be split into separate arguments.

import { spawn } from 'node:child_process';

const PKG = '@softeria/ms-365-mcp-server@0.145.0';
const SCOPES = 'Mail.ReadWrite Mail.Send Calendars.ReadWrite User.Read';
const ARGS = ['--preset', 'outlook', '--allowed-scopes', SCOPES, '--login'];

const child =
  process.platform === 'win32'
    ? // Build the command line by hand so the quoting is exact. Node cannot
      // spawn npx.cmd without a shell on Windows, and shell:true with an args
      // array splits the scopes string.
      spawn(
        'cmd.exe',
        ['/d', '/s', '/c', `npx -y ${PKG} --preset outlook --allowed-scopes "${SCOPES}" --login`],
        { stdio: 'inherit' }
      )
    : spawn('npx', ['-y', PKG, ...ARGS], { stdio: 'inherit' });

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (e) => {
  console.error('runner failed to start sign-in: ' + (e?.message ?? e));
  process.exit(1);
});
