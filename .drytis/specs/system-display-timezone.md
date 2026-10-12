# System Timezone for Feedback Timestamps (QASE ⇄ Telegram match)

Ticket: #15975
Branch: MANOJ

## Problem
`Submitted On` for a feedback record is rendered in three different timezones:
- report tab: viewer browser zone (`public/app.js` renderReportFeedbackSection, `toLocaleString()`)
- md/PDF reports: server zone = UTC (`server/report.js:157`, `server/reportPdf.js:218`)
- Telegram notification: user-profile timezone (default `UTC` for users who never set one)

An IST submission at 06:25 PM therefore shows as 12:55 PM in Telegram. There is
no system-wide display timezone configuration.

## Fix — one authoritative display timezone
1. New env `QASE_DISPLAY_TIMEZONE` (IANA; default `Asia/Kolkata`; invalid → fallback `Asia/Kolkata` + WARN log). Registered through the env-key tool, never hardcoded in source defaults beyond the documented default.
2. New `server/displayTime.js`:
   - `resolveDisplayTimeZone(environment)` — validate IANA, fallback + warn.
   - `formatFeedbackTimestamp(epochMs, zone)` — `13-Oct-2026 06:25 PM IST` style (dd-MMM-yyyy hh:mm AM/PM + zone label; `Asia/Kolkata` → `IST`, otherwise Intl short offset).
   - shared by telegramNotifier, report.js, reportPdf.js, app.js API responses.
3. Telegram dispatch context: `submittedAtTimeZone = resolveDisplayTimeZone(environment)` (system zone; no longer the per-user profile default of UTC).
4. md/PDF + report tab: same server-rendered string via the same helper. The feedback GET responses carry the formatted value so the browser never re-formats from its own zone.
5. Timestamp authority unchanged: still the single `record.submittedAt` from the saved record; refresh/delivery-delay cannot change it. Invalid/missing timestamp renders `—`.

## Files
- server/displayTime.js (new)
- server/telegramNotifier.js (use formatFeedbackTimestamp; zone suffix)
- server/app.js (dispatch zone source; feedback API responses carry formatted submittedOn)
- server/report.js, server/reportPdf.js (formatted timestamps)
- public/app.js (report tab uses server-provided formatted string)
- tests: server/displayTime.test.js; updates in telegramNotifier.test.js, feedbackNotifyApi.test.js

## Acceptance
- [ ] Telegram Submitted On equals QASE display time for the same feedback record
- [ ] Midnight/IST-boundary crossing renders the correct date
- [ ] Browser in a different zone than server shows the same string (server-rendered)
- [ ] Refresh keeps the value stable; delayed delivery keeps the original time
- [ ] Invalid QASE_DISPLAY_TIMEZONE falls back safely (never a crash / never a wrong offset)
- [ ] Existing feedback/report/Telegram behavior intact; no token exposure
