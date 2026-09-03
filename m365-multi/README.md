# m365-multi

Work across several Microsoft 365 accounts in one Claude session — read and search mail, draft replies, read and
write calendars, and read Teams, SharePoint, OneDrive and shared mailboxes — without disconnecting and reconnecting
between accounts.

Claude's built-in Microsoft 365 connector binds to one Microsoft identity at a time. This plugin
runs [`@softeria/ms-365-mcp-server`](https://github.com/softeria/ms-365-mcp-server) locally instead,
which keeps a token per account and adds an `account` argument to every tool. Sign in once per
account and they all stay available.

Mail and calendar can be read and drafted. Teams, SharePoint, OneDrive and shared mailboxes are read-only: Claude
can list and read chats, channel messages, meeting transcripts, sites, lists and files, and cannot post, upload,
share or delete anything. Nothing here can send.

**Upgrading from 0.7.0 or earlier:** the wider read scopes need new consent, so every account has to sign in again
after the upgrade. Existing tokens keep working for mail and calendar until then.

## Requirements

- **Node.js 20 or newer** (`node --version`). No admin rights needed if Node is already installed —
  if it isn't, the official Windows `.zip` and macOS `.tar.gz` builds extract to a user folder
  without an installer.
- A Microsoft 365 work or school account for each mailbox you want to reach.

## Install

Add the marketplace, then install the plugin:

```
/plugin marketplace add Vaildigital/claude-m365-multi
```

```
/plugin install m365-multi@vail-m365
```

## Sign in

Just ask Claude, once per account:

> Add a Microsoft 365 account.

Claude returns a URL and a short code. Open the URL, enter the code, and sign in as the account you
want to add. Then ask Claude to check it worked. Repeat for each mailbox.

**Use this plugin's `start-login` tool, not the `login` tool on the m365 server.** They look
interchangeable and are not. The `login` tool polls for completion inside the m365 server process,
and Cowork restarts that process between turns — so the poll is discarded while you are still in the
browser, and the sign-in silently never completes no matter how many times you retry.
`start-login` runs the sign-in as an independent background process that survives the restart, so it
finishes whenever you do.

If you would rather drive it from a terminal, run the server that ships with the plugin — this
downloads nothing:

```bash
node <plugin>/login-runner.mjs
```

Replace `<plugin>` with the installed plugin directory. Claude can tell you where that is. The runner
passes the same scope list and tool allow-list as `.mcp.json`, so a terminal sign-in consents to
exactly what the server can use.

A newly added account won't show up until the plugin's server restarts, which happens on its own
between turns in Cowork, or when you restart Claude Code. If an account you just added seems
missing, ask again in a moment rather than signing in a second time.

### Expect one failure on the first account in each new tenant

The first sign-in against a Microsoft tenant that has never seen this app usually fails with:

```
AADSTS650051: ... service principal name is already present for the tenant
```

This is a race inside Entra while it provisions the application, not a misconfiguration. **Start a
fresh sign-in and do it again — the second attempt succeeds.** Don't reuse the old code: that
failure ends the flow, and reusing the code returns `authorization_declined`.

## Use it

Once more than one account is signed in, every tool requires an `account` argument, and Claude sees
the list of available accounts in the tool description. Ask in plain language:

- "What's unread across all my accounts from the last three days?"
- "Draft a reply in the council account to the email from the planning team."
- "What's on my calendar tomorrow in each account?"

Claude can draft but cannot send — see Permissions below.

## Permissions

Sign-in requests these delegated permissions. Only the first two allow any write.

| Permission | Why |
|---|---|
| `Mail.ReadWrite` | read, search, and create drafts |
| `Calendars.ReadWrite` | read calendars and create or update events |
| `Calendars.Read.Shared` | read calendars shared with the user |
| `Mail.Read.Shared` | read shared mailboxes the user has access to |
| `Chat.Read`, `ChatMessage.Read` | list and read Teams chats |
| `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All` | list joined teams and channels, read channel messages |
| `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All` | list Teams meetings and read their transcripts |
| `Sites.Read.All` | search SharePoint sites, read their lists, list items and files |
| `Files.Read`, `Files.Read.All` | read OneDrive and SharePoint files |
| `People.Read` | Microsoft Search ranks results by the people the user works with |

`ChannelMessage.Read.All` and `OnlineMeetingTranscript.Read.All` need administrator consent in every
tenant, not only in tenants that block user consent. If your tenant allows user consent for the rest,
the sign-in still stops at those two until an administrator grants them.

### What Claude can and cannot do here

The tool surface is restricted to an explicit allow-list, of which exactly one tool modifies
anything that already exists. Claude **can** read and search mail, read calendars, create drafts and
replies, create or update calendar events, and read Teams chats, channel messages, meeting
transcripts, SharePoint sites, lists and files, OneDrive files and shared mailboxes. Claude **cannot**:

- send mail, reply, or forward — drafts only, sent by a human from Outlook
- delete or move mail, folders, calendars or events
- share a calendar with anyone
- post to a Teams chat or channel, or react to a message
- upload, rename, move, share or delete a file
- write to a SharePoint list or a shared mailbox

That list is not politeness, it is the reason those permissions are safe to grant. Claude reads email
written by anyone who can reach the mailbox, and a message can contain text aimed at influencing it.
Nothing it could be talked into doing is destructive or leaves the tenant.

The app is published by **Softeria AS**, a Microsoft verified publisher (verified 2025-06-05).

### If you see "Need admin approval"

Most managed tenants disable user consent to applications entirely. An administrator can confirm
with:

```bash
az rest --method get --url "https://graph.microsoft.com/v1.0/policies/authorizationPolicy"
```

If `defaultUserRolePermissions.permissionGrantPoliciesAssigned` contains no app-consent policy (only
the `...-for-team` and `...-for-chat` entries, or nothing), then **no ordinary user in that tenant
can consent to any app** and every sign-in will hit this wall until an administrator acts.

There are two ways to unblock it. Prefer the first.

#### Recommended: a per-user grant

Grants access to **one named person**, limited to the permissions above. Nobody else in the
tenant is affected, and it is undone by deleting a single row. Requires **Cloud Application
Administrator** or higher.

```powershell
# Microsoft Graph PowerShell
Connect-MgGraph -Scopes "DelegatedPermissionGrant.ReadWrite.All"

$clientSp   = (Get-MgServicePrincipal -Filter "appId eq '084a3e9f-a9f4-43f7-89f9-d229cf97853e'").Id
$graphSp    = (Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'").Id
$principal  = (Get-MgUser -UserId "person@example.gov.au").Id

New-MgOauth2PermissionGrant -ClientId $clientSp -ConsentType Principal -PrincipalId $principal `
  -ResourceId $graphSp `
  -Scope "Mail.ReadWrite Calendars.ReadWrite Calendars.Read.Shared Mail.Read.Shared Chat.Read ChatMessage.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All OnlineMeetings.Read OnlineMeetingTranscript.Read.All Sites.Read.All Files.Read Files.Read.All People.Read openid profile offline_access"
```

Sign-in then completes with no consent prompt. To revoke, delete that grant.

#### Alternative: tenant-wide admin consent

**Entra ID → Enterprise applications → All applications →** search **"MS 365 MCP Server" → Security →
Permissions → Grant admin consent**.

Two things to understand before choosing this:

- **It grants the app's full declared permission set**, not only the permissions above. The
  `--allowed-scopes` flag narrows what *this* client requests at sign-in; it cannot narrow what a
  tenant-wide consent grants. Read the list on that screen first.
- **Consent is not access control.** Afterwards anyone in the tenant can use the app. To limit that,
  set **Properties → Assignment required → Yes** and assign only the intended users under **Users and
  groups**.

### If sign-in is blocked outright

A message that the sign-in method isn't allowed means the tenant blocks device code flow via
Conditional Access. Microsoft recommends organisations block it as anti-phishing hardening, so this
is a legitimate policy, not a fault. Raise it with that tenant's administrator — there is no
client-side workaround.

## Managing accounts

Ask Claude — `list-accounts`, `select-account` and `remove-account` are available to it:

> Which Microsoft 365 accounts are signed in?

> Remove the Campbelltown account.

Removing an account deletes the local token only. To revoke access properly, the tenant
administrator should also remove the app's grant for that user in Entra ID; a local delete does not
stop any other machine.


## What this plugin runs, and how to verify it

The plugin **never downloads code at runtime**. There is no `npx`, no package fetch, and nothing to
install beyond Node itself. The Microsoft 365 server ships in `vendor/` as a single pre-built file,
alongside `keytar` (a native module, so it cannot be bundled).

Because a 4.6 MB build artefact cannot meaningfully be read, every vendored file is checksummed:

```bash
npm run verify
```

To confirm the bundle really is the upstream server, rebuild it and compare — it is produced from
the pinned `@softeria/ms-365-mcp-server` version by `npm run build:vendor`, and the hashes should
match `vendor/SHA256SUMS`.

**Pin the marketplace to a commit**, not a branch, so an upstream change cannot alter what runs on
your machine without you choosing it. Installing this plugin means executing code from this
repository, so treat write access to it as you would any production credential.

## Access, and how to revoke it

Once several accounts are added, one machine holds refresh tokens for every connected mailbox,
across every tenant. That is normal for a desktop tool, but it means a compromise of that laptop
exposes all of them rather than one. Keep it to machines you would trust with the mailboxes
themselves.

To remove access:

```bash
node vendor/ms365-server.mjs --remove-account <id>
```

For a full revocation, the tenant administrator should also remove the app's grant for that user in
Entra ID — deleting the local token only stops this machine, not any other.

## Where tokens are stored

Tokens live in an AES-256-GCM encrypted file in your user profile — on Windows,
`%APPDATA%\ms-365-mcp-server\.token-cache.json`. The encryption key goes to the OS credential store.
Nothing is stored on any server, and no tokens leave your machine except to Microsoft.

If you are running somewhere the user profile isn't persistent between sessions and you find
yourself signing in repeatedly, point the cache at durable storage:

```
MS365_MCP_TOKEN_CACHE_PATH
MS365_MCP_SELECTED_ACCOUNT_PATH
```

Do not point these inside the plugin directory — it is replaced on upgrade, which would delete
every stored token.
