#!/usr/bin/env node
// Minimal MCP stdio server providing a sign-in flow that survives the host
// restarting MCP servers between turns.
//
// The upstream `login` tool polls for device-code completion inside its own
// process. Cowork tears that process down at the turn boundary, so the poll is
// discarded while the user is still in the browser and no token is ever written.
//
// Here the login runs as a DETACHED child process. It outlives this server
// being killed, finishes polling on its own, and writes the shared token cache
// that the main m365 server reads.

import { spawn } from 'node:child_process';
import {
  openSync,
  readFileSync,
  existsSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  lstatSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Each sign-in gets its own private directory, created with mkdtemp so the name
// is unpredictable and the directory is 0700 on POSIX. Predictable names in the
// shared temp root would let a local user pre-create a symlink and have us
// truncate or append to the target — harmless on Windows, where TEMP is
// per-user, but live on macOS and Linux.
//
// Keeping each run separate also means a previous run's output can never be
// mistaken for the current one, which otherwise left a dead run reporting
// "pending" forever.
const RUN_PREFIX = 'm365-multi-login-';
const STATE = join(tmpdir(), 'm365-multi-login.json');

const makeRunDir = () => {
  const dir = mkdtempSync(join(tmpdir(), RUN_PREFIX));
  return { dir, out: join(dir, 'out.log'), err: join(dir, 'err.log') };
};

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return null;
  }
};

const readLog = (state) => {
  if (!state) return '';
  let out = '';
  for (const f of [state.out, state.err]) {
    try {
      out += readFileSync(f, 'utf8');
    } catch {}
  }
  return out;
};

const parseLog = (text) => ({
  finished: /__RUNNER_EXIT__/.test(text),
  url: text.match(/open the page (\S+)/)?.[1] ?? null,
  code: text.match(/enter the code (\S+)/)?.[1] ?? null,
  success: /"success"\s*:\s*true/.test(text) || /Login successful/i.test(text),
  upn: text.match(/"userPrincipalName"\s*:\s*"([^"]+)"/)?.[1] ?? null,
  expired: /device_code_expired|expired_token/.test(text),
  declined: /authorization_declined/.test(text),
  needsAdmin: /AADSTS65001|Need admin approval/i.test(text),
  spRace: /AADSTS650051/.test(text),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Quote a value for a PowerShell single-quoted string. Inside single quotes the
// only special character is the quote itself, escaped by doubling. Without this,
// a path containing an apostrophe — legal in Windows usernames, so it appears in
// the plugin path for users like O'Brien — terminates the string and the rest is
// parsed as PowerShell.
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Remove run directories from previous sign-ins. They accumulate otherwise, and
// they hold device codes and account names. Symlinks are skipped so this can
// never be used to delete something outside the temp root.
const sweepOldRuns = () => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(RUN_PREFIX)) continue;
      const p = join(tmpdir(), name);
      try {
        const st = lstatSync(p);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        if (st.mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
};

async function startLogin() {
  sweepOldRuns();
  try {
    if (existsSync(STATE)) unlinkSync(STATE);
  } catch {}

  const { dir, out: LOG, err: LOG_ERR } = makeRunDir();
  const state = { dir, out: LOG, err: LOG_ERR, startedAt: Date.now() };

  const runner = join(dirname(fileURLToPath(import.meta.url)), 'login-runner.mjs');

  if (process.platform === 'win32') {
    // `detached: true` breaks stdout redirection on Windows — the child runs but
    // writes nowhere, so the device code can never be read back. Verified across
    // fd-inheritance, cmd.exe and shell forms. Start-Process launches a genuinely
    // independent process and does its own redirection.
    //
    // Launch node by absolute path (process.execPath) rather than a PATH lookup:
    // this process environment is not guaranteed to resolve `npx` or `node` the
    // way an interactive shell does.
    writeFileSync(LOG, '');
    writeFileSync(LOG_ERR, '');
    const ps =
      `Start-Process -FilePath ${psq(process.execPath)} -ArgumentList ${psq(`"${runner}"`)} ` +
      `-RedirectStandardOutput ${psq(LOG)} -RedirectStandardError ${psq(LOG_ERR)} -WindowStyle Hidden`;
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    const fd = openSync(LOG, 'a');
    const child = spawn(process.execPath, [runner], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
  }

  // 'wx' fails rather than following a pre-existing symlink at this path.
  try {
    unlinkSync(STATE);
  } catch {}
  writeFileSync(STATE, JSON.stringify(state), { flag: 'wx', mode: 0o600 });

  // Wait for the device code to appear. npx may need to fetch the package first,
  // which on a cold cache can take a while.
  for (let i = 0; i < 150; i++) {
    await sleep(1000);
    const parsed = parseLog(readLog(state));
    if (parsed.code && parsed.url) {
      return {
        status: 'awaiting_browser',
        url: parsed.url,
        code: parsed.code,
        message:
          `Open ${parsed.url} and enter code ${parsed.code}, then sign in with the account you ` +
          `want to add. The sign-in completes in a background process, so it does not matter how ` +
          `long you take or whether this conversation continues. Call login-status afterwards.`,
      };
    }
  }
  // Surface whatever the background process actually said, so the failure can be
  // diagnosed from here instead of asking the user to go and read a log file.
  // Distinguish "still working" from "dead". A runner that has not exited may
  // still produce a code — that has happened — so do not call it an error.
  const diag = readLog(state).trim();
  const died = /__RUNNER_EXIT__/.test(diag);
  return {
    status: died ? 'error' : 'starting',
    message: died
      ? 'The sign-in process exited before producing a device code.'
      : 'No device code yet after 150 seconds, but the sign-in process is still running. ' +
        'Call login-status shortly rather than starting another sign-in.',
    processOutput: diag.slice(-500) || '(the background process produced no output at all)',
    logPath: LOG,
  };
}

function loginStatus() {
  const state = readState();
  if (!state) return { status: 'not_started', message: 'No sign-in has been started.' };

  const p = parseLog(readLog(state));
  if (p.success) {
    return {
      status: 'success',
      account: p.upn,
      message:
        `Signed in as ${p.upn ?? 'unknown'}. The account appears once the m365 server restarts, ` +
        `which happens on its own between turns.`,
    };
  }
  if (p.spRace)
    return {
      status: 'retry_needed',
      message:
        'Microsoft returned AADSTS650051 (service principal race on first use in this tenant). ' +
        'This is expected on the first sign-in for a new tenant. Call start-login again.',
    };
  if (p.needsAdmin)
    return {
      status: 'admin_consent_required',
      message:
        'This tenant requires administrator consent before this account can sign in. See the ' +
        'README section "If you see Need admin approval".',
    };
  if (p.declined)
    return { status: 'declined', message: 'Sign-in was declined or cancelled. Call start-login again.' };
  if (p.expired)
    return { status: 'expired', message: 'The device code expired unused. Call start-login again.' };

  const raw = readLog(state).trim();

  // The runner has exited without a success line: this run is over and will
  // never complete, however long it is left. Say so rather than reporting
  // pending forever.
  if (p.finished) {
    return {
      status: 'failed',
      message:
        'The sign-in process has exited without completing. Any code from this attempt is dead — ' +
        'start a new sign-in rather than waiting or retrying the old code.',
      processOutput: raw.slice(-500) || '(no output)',
      logPath: state.out,
    };
  }

  if (!p.code && !p.url) {
    return {
      status: 'stuck',
      message: 'The sign-in process started but has not produced a device code yet.',
      processOutput: raw.slice(-500) || '(the background process produced no output at all)',
      logPath: state.out,
    };
  }

  return {
    status: 'pending',
    code: p.code,
    url: p.url,
    startedAt: new Date(state.startedAt).toISOString(),
    message: 'Still waiting for the browser sign-in to complete.',
  };
}

const TOOLS = [
  {
    name: 'start-login',
    description:
      'THE ONLY WORKING WAY to add or sign in a Microsoft 365 / Outlook account. Always use this ' +
      'instead of the m365 server\'s `login` tool, which fails silently in Cowork: it polls inside a ' +
      'process that is restarted between turns, so the user completes the browser step and no token ' +
      'is ever written, with no error shown. This tool runs the sign-in in an independent background ' +
      'process that survives the restart. Returns a URL and device code to give the user; then call ' +
      'login-status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'login-status',
    description:
      'Check whether the sign-in started by start-login has completed, and report the account that ' +
      'was added or the reason it failed.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// --- MCP plumbing -----------------------------------------------------------

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => write({ jsonrpc: '2.0', id, result });
const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });

let buf = '';
process.stdin.on('data', async (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue; // notification

    try {
      if (msg.method === 'initialize') {
        ok(msg.id, {
          protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'm365-login-helper', version: '1.0.0' },
        });
      } else if (msg.method === 'ping') {
        ok(msg.id, {});
      } else if (msg.method === 'tools/list') {
        ok(msg.id, { tools: TOOLS });
      } else if (msg.method === 'tools/call') {
        const name = msg.params?.name;
        if (name === 'start-login') ok(msg.id, text(await startLogin()));
        else if (name === 'login-status') ok(msg.id, text(loginStatus()));
        else write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown tool: ' + name } });
      } else {
        write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method' } });
      }
    } catch (e) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } });
    }
  }
});
