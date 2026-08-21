# claude-m365-multi

A Claude plugin marketplace containing **m365-multi** — use several Microsoft 365 accounts in a
single Claude session, without disconnecting and reconnecting between them.

Claude's built-in Microsoft 365 connector binds to one Microsoft identity at a time. This plugin runs
a Microsoft Graph MCP server locally instead, keeping a token per account and adding an `account`
argument to every tool, so "what's unread across all my accounts?" works across mailboxes in
different tenants.

## Install

```
/plugin marketplace add Vaildigital/claude-m365-multi
```

```
/plugin install m365-multi@vail-m365
```

Then ask Claude to add an account. Full setup, sign-in troubleshooting, and admin-consent guidance
are in **[m365-multi/README.md](m365-multi/README.md)**.

## What it can do

Read and search mail, read calendars, create drafts and replies, create and update calendar events —
across every signed-in account.

Deliberately **not** included: sending mail, deleting or moving anything, and sharing calendars.
Claude reads email written by anyone who can reach the mailbox, so the tool surface is an explicit
allow-list rather than a default one — 27 tools, of which exactly one modifies data that already
exists. Sign-in requests two delegated permissions, `Mail.ReadWrite` and `Calendars.ReadWrite`.

The reasoning, and the risks that remain, are written up in
**[SECURITY-REVIEW.md](SECURITY-REVIEW.md)**.

## Requirements

- **Node.js 20+**. Nothing else is installed, and nothing is downloaded at runtime — the Graph server
  ships pre-built in `m365-multi/vendor/`.
- **Windows.** The vendored `keytar` native module is a Windows build. On macOS it will not load and
  credential storage silently falls back to a file-based key; this is untested and unsupported.
- A Microsoft 365 work or school account per mailbox. Tenants that disable user consent to
  applications need an administrator to act first — see the plugin README.

## Repository layout

```
.claude-plugin/marketplace.json   marketplace manifest ("vail-m365")
SECURITY-REVIEW.md                threat model, findings, and what remains
m365-multi/
  .claude-plugin/plugin.json      plugin manifest
  .mcp.json                       the two MCP servers this plugin provides
  login-helper.mjs                start-login / login-status
  login-runner.mjs                runs the sign-in as an independent process
  skills/                         guidance for Claude on adding accounts
  vendor/                         pre-built Graph server + keytar + SHA256SUMS
  scripts/checksums.mjs           write/verify vendored checksums
```

## Verifying what you are running

Installing this plugin means executing code from this repository. `vendor/ms365-server.mjs` is a
build artefact and cannot meaningfully be read, so every vendored file is checksummed:

```bash
cd m365-multi && npm run verify
```

To confirm the bundle is the upstream server rather than something else, rebuild it and compare
hashes — it is produced from a pinned release of
[`@softeria/ms-365-mcp-server`](https://github.com/softeria/ms-365-mcp-server) by:

```bash
cd m365-multi && npm run build:vendor
```

**Pin the marketplace to a commit SHA rather than a branch.** Push access to this repository is code
execution on every machine where the plugin is installed.

## Maintenance

Bumping the upstream server version means editing the pin in `m365-multi/package.json`, running
`npm run build:vendor`, and committing the regenerated `vendor/` directory along with its checksums.
The bundle is deliberately committed so the plugin never fetches code at install or run time.

## Status

Internal tooling, built for Vail Digital's own use and shared as-is. There is no support commitment,
no release process, and no compatibility guarantee — it depends on how the Claude desktop app runs
local MCP servers, which can change without notice.
