# UX U2 — App Shell & Navigation IA

Ticket: #13990. After R2 (#13957) which reskinned the shell; U2 reorganizes
navigation INTO it. Also fixes the observed feature-dock rail clipping.

## Problem

- Feature-dock (right vertical rail, 56-58px) holds modes QA/SQA/Founder/Bugs
  + device chip, with clipped labels at narrow widths (observed in R2 screenshots).
- Nav actions (Settings, Environments, Device Matrix, Test cases, Bulk runs,
  My account, Sign out) live in a 2-column footer wrap — reachable but cramped
  and unordered.
- Quick Actions strip is a separate floating toolbar with no hierarchy.

## Approach (no routing changes — single-page view switching)

1. **Sidebar nav section** above the footer: grouped list with a "Workspace"
   group (Test cases, Device Matrix, Bulk runs, Environments) — clicking opens
   the SAME dialogs the foot buttons open today (no behavior change, ids kept).
   Foot buttons REMAIN (seam tests + JS pin them); visually they become the
   account row (My account / Sign out / Settings) only, via CSS hiding of the
   duplicated nav entries? — NO: foot-btn ids are load-bearing; instead the
   sidebar nav entries are NEW buttons that call the same openers.
2. **Feature-dock**: keep DOM + pinned grid rules; fix clipped labels via
   proper text-overflow/ellipsis and min-width handling; restyle chips.
3. **Top-bar**: workspace-chrome gains a contextual title slot (existing
   workspace-command span) showing current mode.

## Constraints

- founderUi.test.js pins `<nav class="feature-dock" aria-label="Qase features">`
  literal + dock grid columns (58px@≥1281, 56px@1101-1280, fixed bottom @≤1100).
  Do not remove/reorder those blocks.
- finalUiPolish.test.js pins foot grid rules, media blocks, ids.
- All existing ids kept; new elements get NEW ids (nav-*) wired in app.js.

## Acceptance

- [ ] Sidebar nav reaches Test cases / Device Matrix / Bulk runs / Environments
      in one click, account row below
- [ ] Feature-dock labels no longer clip at 1440/1280/1100 widths
- [ ] Every existing surface still opens exactly as before
- [ ] npm run verify green; headless signed-in check: nav clicks open dialogs
