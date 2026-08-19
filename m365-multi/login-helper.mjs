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
import { openSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG = '@softeria/ms-365-mcp-server@0.145.0';
const SERVER_ARGS = [
  '--preset',
  'outlook',
  '--allowed-scopes',
  'Mail.ReadWrite Mail.Send Calendars.ReadWrite User.Read',
];

const LOG = join(tmpdir(), 'm365-multi-login.log');
const LOG_ERR = join(tmpdir(), 'm365-multi-login.err.log');
const STATE = join(tmpdir(), 'm365-multi-login.json');

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return null;
  }
};

const readLog = () => {
  let out = '';
  for (const f of [LOG, LOG_ERR]) {
    try {
      out += readFileSync(f, 'utf8');
    } catch {}
  }
  return out;
};

const parseLog = (text) => ({
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

async function startLogin() {
  for (const f of [LOG, LOG_ERR, STATE]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {}
  }

  const args = ['-y', PKG, ...SERVER_ARGS, '--login'];
  let child;

  if (process.platform === 'win32') {
    // On Windows, `detached: true` breaks stdout redirection — the child runs
    // but writes nowhere, so the device code can never be read back. Verified
    // across fd-inheritance, cmd.exe and shell forms. Start-Process launches a
    // genuinely independent process and does its own redirection, which works.
    writeFileSync(LOG, '');
    writeFileSync(LOG_ERR, '');
    const argList = args.map((a) => (a.includes(' ') ? `'"${a}"'` : `'${a}'`)).join(',');
    const ps =
      `Start-Process -FilePath 'npx.cmd' -ArgumentList ${argList} ` +
      `-RedirectStandardOutput '${LOG}' -RedirectStandardError '${LOG_ERR}' -WindowStyle Hidden`;
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    const fd = openSync(LOG, 'a');
    child = spawn('npx', args, {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
  }

  writeFileSync(STATE, JSON.stringify({ startedAt: Date.now() }));

  // Wait for the device code to appear. npx may need to fetch the package first.
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const parsed = parseLog(readLog());
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
  return { status: 'error', message: 'No device code appeared within 90s. Check ' + LOG };
}

function loginStatus() {
  const state = readState();
  if (!state) return { status: 'not_started', message: 'No sign-in has been started.' };

  const p = parseLog(readLog());
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

  return {
    status: 'pending',
    code: p.code,
    url: p.url,
    message: 'Still waiting for the browser sign-in to complete.',
  };
}

const TOOLS = [
  {
    name: 'start-login',
    description:
      'Begin adding a Microsoft 365 account. Returns a URL and device code for the user to open in ' +
      'a browser. The sign-in runs in a detached background process, so it completes even though the ' +
      'MCP server is restarted between turns. Use this instead of the m365 login tool.',
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
