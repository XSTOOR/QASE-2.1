# UX U4 · Empty states & onboarding polish

Ticket: #13992. Builds on Studio R1–R6 + U1–U3.

## Goal
Every list/panel that can be empty gets a designed, guiding empty state (not a void or bare text): run list, findings tab, plan tab, bug tracker, device matrix/test cases/bulk runs tables, analytics. The welcome/get-started card (already exists) stays the anchor for the chat column.

## Files
- `public/styles.css` — `.empty` / zero-state styling (already partly Studio); unify.
- `public/app.js`, `public/*View.js` — only if an empty state is missing or renders as plain blank; keep ids/structure.

## Acceptance criteria
- [ ] Run list empty state: styled card with call-to-action ("Start your first run").
- [ ] Findings/Plan/Report tabs: friendly empty text when no run selected or run has no findings.
- [ ] Dialog tables (test cases, device matrix envs, bulk cases): designed empty rows, not blank tbody.
- [ ] No clipped text; both themes pass.
- [ ] Full verify 849+/0 fail.
