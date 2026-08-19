# m365-multi

Work across several Microsoft 365 accounts in one Claude session — read and search mail, draft and
send replies, read and write calendars — without disconnecting and reconnecting between accounts.

Claude's built-in Microsoft 365 connector binds to one Microsoft identity at a time. This plugin
runs [`@softeria/ms-365-mcp-server`](https://github.com/softeria/ms-365-mcp-server) locally instead,
which keeps a token per account and adds an `account` argument to every tool. Sign in once per
account and they all stay available.

Scope is deliberately mail and calendar only. No files, SharePoint, or Teams.

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

Run this **once per account**. It prints a URL and a short code — open the URL, enter the code, and
sign in as the account you want to add. Repeat for each mailbox.

```bash
npx -y @softeria/ms-365-mcp-server@0.145.0 --preset outlook --allowed-scopes "Mail.ReadWrite Mail.Send Calendars.ReadWrite User.Read" --login
```

Then confirm what's registered:

```bash
npx -y @softeria/ms-365-mcp-server@0.145.0 --list-accounts
```

Restart Claude after adding accounts so the tool descriptions pick up the new list.

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

Drafts are created, not sent, unless you ask for a send.

## Permissions

Sign-in requests exactly four delegated permissions:

| Permission | Why |
|---|---|
| `Mail.ReadWrite` | read, search, and create drafts |
| `Mail.Send` | send a message when you ask for one |
| `Calendars.ReadWrite` | read and create events |
| `User.Read` | identify which account is which |

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

Grants access to **one named person**, limited to the four permissions above. Nobody else in the
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
  -Scope "Calendars.ReadWrite Mail.ReadWrite Mail.Send User.Read openid profile offline_access"
```

Sign-in then completes with no consent prompt. To revoke, delete that grant.

#### Alternative: tenant-wide admin consent

**Entra ID → Enterprise applications → All applications →** search **"MS 365 MCP Server" → Security →
Permissions → Grant admin consent**.

Two things to understand before choosing this:

- **It grants the app's full declared permission set**, not only the four permissions above. The
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

```bash
npx -y @softeria/ms-365-mcp-server@0.145.0 --list-accounts
```

```bash
npx -y @softeria/ms-365-mcp-server@0.145.0 --remove-account <id>
```

```bash
npx -y @softeria/ms-365-mcp-server@0.145.0 --logout
```

`--logout` clears every account. To remove just one, use `--remove-account` with an id from
`--list-accounts`.

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
