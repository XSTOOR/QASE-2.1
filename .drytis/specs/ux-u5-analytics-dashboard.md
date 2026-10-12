# UX U5 · Analytics dashboard (visible surface for feedback + usage analytics)

Ticket: #13993. Builds on Studio R1–R6 + U1–U4.

## Goal
The analytics API (`/api/analytics/summary`, `/api/analytics/durations`, feedback endpoints) has no visible surface. Build an in-app Analytics view: a dialog opened from the sidebar/footer showing run counts, durations aggregate, feedback summary (thumbs up/down), and top findings severity mix — Studio styled.

## Files
- `public/index.html` — new `#analytics` dialog (modal), nav entry.
- `public/app.js` — `openAnalytics()` fetch + render; nav wiring (sidebar + footer area near Quick Actions).
- `public/styles.css` — Studio cards for stat grid, bars, list rows.

## Constraints
- Read-only — no new API surface needed beyond existing GET endpoints (all return 401 for anonymous; fine).
- Operator-only feedback list stays in the existing operator panel; the dashboard shows the per-user summary + aggregates the user may access.
- Keep DOM ids unique; follow existing dialog pattern (dialog.modal + modal-head/body/foot).

## Acceptance criteria
- [ ] "Analytics" reachable from sidebar Workspace nav; dialog opens.
- [ ] Shows: completed runs count, avg/median duration, thumbs up/down totals, feedback count.
- [ ] Graceful empty state (dashed card) when no data.
- [ ] Studio styling; both themes; no clipped text at 1440×900 and 390px.
- [ ] Full verify 849+/0 fail; headless open/inspect/close cycle green.
