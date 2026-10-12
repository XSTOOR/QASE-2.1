# Phase 1 — Password minimum length 12 → 8

## Goal
Every place that enforces or mentions a 12-character minimum password now uses 8, consistently across backend validation, frontend validation, helper text, and error messages. Signup, password change, and (once Phase 2 adds it) password reset all share the single 8-char rule.

## Files to change
- `server/auth.js`
  - Line 10: `const PASSWORD_MIN_LENGTH = 12;` → `8`. This single constant backs `validatePassword()` (lines 51–56) and therefore local register (line 260), local changePassword (line 297), PG register (line 355), PG changePassword (line 353).
- `public/index.html`
  - Line 45 (`#auth-password`): `minlength="12"` → `minlength="8"`.
  - Line 51 (`#auth-password-hint`): "Use at least 12 characters when creating an account." → 8.
  - Line 1373 (`#new-password` profile form): `minlength="12"` → `minlength="8"`.
- `public/app.js`
  - Line 6653 (`renderAuthMode()`): `el.authPassword.minLength = register ? 12 : 1;` → `register ? 8 : 1`.
- `docs/auth-architecture-2026-09-10.md` line 14: "12–200 characters" → "8–200".
- Search the repo for any other literal "12" / "at least 12" password references (docs, memory notes are non-blocking but update docs).

## Tests
- `server/auth.test.js`: add boundary tests — register with 7-char password rejects (weak_password, 400); 8-char accepts; changePassword 7-char rejects / 8-char accepts; both on local and PG services.
- `scripts/test-auth-browser.mjs`: assert 7-char password shows browser validation and blocks submit; 8-char succeeds through registration.
- Existing fixtures use ≥12-char passwords — remain valid; no regressions.

## Acceptance criteria (observable in the running app)
- [ ] A user can register with an 8-character password
- [ ] A 7-character password is rejected at signup with a message stating the 8-character minimum
- [ ] A user can change their password to an 8-character password; 7-character new passwords are rejected
- [ ] Helper text on signup and change-password forms says 8 characters, not 12
- [ ] Existing ≥12-char passwords still log in fine (no re-hash or forced reset)

## Edge cases
- maxlength stays 200; no regex changes.
- Backend error message reads the constant, so it updates automatically — verify no hardcoded "12" string in messages.
- Do not lower below 8 anywhere; do not change hashing parameters.
