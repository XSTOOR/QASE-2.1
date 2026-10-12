# SMTP setup for password-reset emails — QASE-2.1 (ticket #15673)

Administrators can configure **two** sender connections through environment variables; exactly
one is active at a time. Both use identical semantics, and either one delivers reset emails to
**any** registered recipient address — Gmail, Outlook, Yahoo, company domains, anything the user
registered with. Users never see or choose senders; the Forgot Password panel is a single email
field.

> How SMTP works: a sender's relay account (its domain) is completely independent of the
> **recipient's** domain — a Gmail sender can deliver to Outlook inboxes and vice versa. That is
> why only ONE active sender is ever needed; the second is an admin convenience/failover option.

## Primary sender — Gmail (QASE_MAIL_*)

| Variable | Value | Notes |
|---|---|---|
| `QASE_MAIL_HOST` | `smtp.gmail.com` | Gmail's submission host. |
| `QASE_MAIL_PORT` | `587` (STARTTLS) | Gmail supports 465 too; 587 is standard. |
| `QASE_MAIL_USER` | `your.sender@gmail.com` | The sending Gmail account. |
| `QASE_MAIL_PASSWORD` | Gmail **App Password** (16 chars) | NOT the account password. Requires 2-Step Verification on the account; generate at Google Account → Security → 2-Step Verification → App passwords. **Secret.** |
| `QASE_MAIL_FROM` | `Qase <your.sender@gmail.com>` | Should match the Gmail account or delivery is rejected. |
| `QASE_MAIL_MODE` | `smtp` | Optional — auto-set when host is configured. |

## Secondary sender — company / Microsoft 365 (QASE_MAIL2_*)

| Variable | Value | Notes |
|---|---|---|
| `QASE_MAIL2_HOST` | `smtp.office365.com` | Set. Replace with your company mail gateway / Exchange relay hostname if IT directs one. |
| `QASE_MAIL2_PORT` | `587` (STARTTLS) | Set. Microsoft requires STARTTLS on 587; 465 is not offered for client submission. |
| `QASE_MAIL2_USER` | e.g. `qase-notifications@yourcompany.com` | A licensed mailbox or relay account. **You enter.** |
| `QASE_MAIL2_FROM` | `Qase <no-reply@yourcompany.com>` | An address your relay accepts sending from. **You enter.** |
| `QASE_MAIL2_AUTH_METHOD` | `login` (default) or `xoauth2` | **Confirm with your company which is approved.** |
| `QASE_MAIL2_PASSWORD` | mailbox/relay credential | For `login` auth. **Secret — you enter.** |
| `QASE_MAIL2_CLIENT_ID` | app registration (application) id | For `xoauth2` auth (below). |
| `QASE_MAIL2_CLIENT_SECRET` | app registration secret value | For `xoauth2`. **Secret — you enter.** |
| `QASE_MAIL2_REFRESH_TOKEN` | pre-provisioned refresh token | For `xoauth2`. **Secret — you enter.** |

### Microsoft OAuth2 (XOAUTH2) — when basic SMTP AUTH is disabled

If your tenant has basic authentication disabled (the Microsoft default for many tenants),
username/password will be rejected. The app already implements OAuth2 XOAUTH2 — set
`QASE_MAIL2_AUTH_METHOD=xoauth2` and provide:

1. **App registration** in Entra ID (Azure AD) with the **`SMTP.Send`** application permission
   (Office 365 Exchange Online API) granted with **admin consent**.
2. Its **application (client) id** → `QASE_MAIL2_CLIENT_ID`, and a **client secret** →
   `QASE_MAIL2_CLIENT_SECRET`.
3. A **refresh token** provisioned for the sending mailbox with the
   `https://outlook.office.com/SMTP.Send` scope → `QASE_MAIL2_REFRESH_TOKEN`.
   Access tokens are minted and rotated automatically from the refresh token; nothing expires
   in the environment.

The primary sender also supports `QASE_MAIL_AUTH_METHOD=xoauth2` with the matching
`QASE_MAIL_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN` variables, should you ever move the
Gmail side to OAuth2 too (Gmail app passwords remain simpler and are fine for `login`).

## Active sender selection

| Variable | Value | Notes |
|---|---|---|
| `QASE_MAIL_SENDER` | `primary` (default) or `secondary` | Selects which connection sends reset emails. Defaults to `primary`; if only the secondary is configured, it is used automatically. |

All variables are already registered in the project's **Environment Variables** — admins only
fill in values. Passwords (`QASE_MAIL_PASSWORD`, `QASE_MAIL2_PASSWORD`) are stored as secrets:
masked in read-backs, never in the repo, chat, or logs. `.env` is regenerated from these records
on every deploy/restart.

## Verifying before Done (#15673)

Once **both** senders are configured, live verification runs per sender:
1. Set `QASE_MAIL_SENDER=primary` (restart) → verify: **real email delivery** to a registered
   address (check the inbox), **password reset + login** with the new password, **old-password
   rejection**, **reset-link reuse rejection**.
2. Set `QASE_MAIL_SENDER=secondary` (restart) → repeat all four checks with a different
   registered address (ideally on another provider — e.g. request from a Gmail address, deliver
   via the company sender).

#15673 stays open until both senders pass all four checks.

## Behavior guaranteed by the implementation (unchanged)

- Credentials are read **only** from `QASE_MAIL_*` / `QASE_MAIL2_*` env vars; never logged,
  never returned by the API, never committed. No sender configuration appears anywhere in the UI.
- Reset links appear **only** in the delivered email — never in UI responses or logs (message
  bodies are never logged; failures log a redacted one-liner: sender name + subject + error code).
- Production refuses mock mode (`NODE_ENV=production` + mock → mail dropped with a redacted log
  line) so a missing SMTP config can never leak reset links or crash auth flows.
- Sending fails soft: a broken relay yields `delivered: false` with an error code, never a crash
  of the auth flow.
