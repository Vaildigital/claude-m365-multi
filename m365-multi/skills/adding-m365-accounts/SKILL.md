---
name: adding-m365-accounts
description: Use when the user wants to add, connect, or sign in a Microsoft 365 / Outlook account, add another mailbox, or when a Microsoft 365 tool fails because no account is signed in. Covers which sign-in tool to use and how to handle the errors Microsoft returns.
---

# Adding a Microsoft 365 account

## Use `start-login`, never `login`

Two sign-in tools are visible and they are **not** interchangeable:

| Tool | Use it? |
|---|---|
| `m365-login:start-login` | **Yes. Always.** |
| `m365:login`, `m365:verify-login` | **No. Never.** They fail silently. |

`m365:login` polls for completion inside the m365 server's own process. Cowork restarts that process
between turns, so the poll is discarded while the user is still in the browser and no token is ever
written. The sign-in appears to work, the user completes it correctly, and the account never
appears — no error is produced anywhere.

`start-login` runs the sign-in as an independent background process that outlives the restart, so it
completes whenever the user finishes.

If you have already called `m365:login` in this conversation, discard that device code, tell the
user to ignore it, and start again with `start-login`.

## The flow

1. Call `start-login`. It returns a URL and a short code.
2. Give the user both, and say which account to sign in with if that's known.
3. When they say they're done, call `login-status`.
4. On success, confirm which account was added. It appears in `list-accounts` once the m365 server
   next restarts, which happens on its own between turns — so if `list-accounts` still shows the old
   set, that is expected and not a failure. Say so rather than starting another sign-in.

Never start a second sign-in because an account hasn't appeared yet. Check `login-status` first —
duplicate flows invalidate each other's codes and cause exactly the loop the user is trying to
escape.

## Errors worth recognising

`login-status` reports these directly. What they mean:

- **`retry_needed` (AADSTS650051)** — Microsoft's service-principal race, expected on the first
  sign-in for any tenant that has never used this app. Not a misconfiguration. Call `start-login`
  again; the second attempt succeeds. Do not reuse the old code — that failure ends the flow and
  reusing it returns `authorization_declined`.
- **`admin_consent_required`** — the tenant blocks user consent to applications, so an administrator
  must act before this account can sign in. Point the user at the README section
  "If you see Need admin approval". A per-user grant is the narrow fix; tenant-wide consent is the
  blunt one.
- **`expired`** — the code timed out unused. Start a new one.
- **`declined`** — cancelled, or a consent failure ended the flow. Start a new one.

- **`retry_needed` or `admin_consent_required` on an account that used to work** — the plugin's
  scope list grew in 0.8.0 (Teams, SharePoint, OneDrive and shared mailboxes, all read-only). An
  account signed in under an earlier version keeps working for mail and calendar, but any Teams or
  SharePoint call fails with "Failed to acquire token" until that account signs in again. Say that,
  then run `start-login` for it. In a tenant that blocks user consent, the administrator's per-user
  grant has to be re-issued with the new scope list first (README, "Recommended: a per-user grant").

## When a tool says "Failed to acquire token"

The server hides the Microsoft error code. Do not tell the user the token "may have expired" and stop.
Two causes look identical from the tool result and need different answers:

- The refresh token was revoked (password change, admin session revoke) or expired. A fresh
  `start-login` fixes it.
- The tenant enforces a Conditional Access sign-in frequency on that account, so the refresh token
  dies a fixed number of hours after every sign-in. A fresh sign-in fixes it only until the next
  expiry. The user needs that tenant's administrator to exclude the app or the account from the
  policy; there is no client-side fix.

To tell them apart, run the server once in verbose mode from a terminal and read the `AADSTS` code it
logs: `AADSTS50173` is a revoke, `AADSTS70043` is sign-in frequency.

## Using accounts once added

Every tool takes an `account` argument once more than one account is signed in. Pass the address
explicitly rather than relying on the default, and when the user's request spans mailboxes, call the
tool once per account rather than assuming one covers them all. Teams, SharePoint and OneDrive tools
are per account too: a chat, site or file visible to one account is not visible to another.
