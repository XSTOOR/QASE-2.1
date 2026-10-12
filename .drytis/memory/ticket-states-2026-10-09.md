# Ticket states — QASE-2.1 (updated 2026-10-09T16:58Z)

- **#15685** (POST /api/sessions duplicate block + scopeSelection) — **Done**, no engineer review (customer instruction). Full verification passed: 37/37 + 23/23 tests, live 201 probes, infra audit PASS. Review report: .drytis/reviews/ticket-15685.json.
- **#15694** (stuck .qase/sessions.json.tmp-67) — **In Progress / BLOCKED pending platform maintenance**. Reopened by customer. Repair path: verified volume backup FIRST → unmount → e2fsck -fD /dev/nvme0n1 → remount → re-verify (see .drytis/reviews/ticket-15694-cleanup-report.md for full criteria). Do NOT try in-container removal again — impossible by design (dirent → deleted inode 491738, EUCLEAN).
- **#15673** (Forgot password / SMTP reset) — **In Progress, blocked on SMTP credentials**. Env keys already registered in backend (ids 52876–52881: QASE_MAIL_MODE/HOST/PORT/USER/PASSWORD/FROM → /workspace/.env; PASSWORD is_secret). Customer configures values themselves via platform env settings — never in chat. Setup instructions written: docs/smtp-password-reset-setup.md. After creds: verify (1) real email delivery, (2) successful reset + login, (3) old-password rejection, (4) token-reuse rejection → then Done.
- Also pending customer config, noticed in backend env: BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY (ids 52062/52063) are still empty.

## Board API quirk
`list_board_tickets` returns only the oldest 100 (Done) tickets — #15672/#15673/#15685/#15694 are invisible in listings, and `update_ticket`/`move_ticket` on hidden tickets intermittently fails with "Ticket #XXXXX is not on this project's board". move_ticket usually works on retry. Keep durable ticket status in .drytis/reviews/ files when the board API rejects updates.
