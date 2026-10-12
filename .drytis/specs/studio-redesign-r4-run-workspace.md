# Studio Redesign R4 · Run workspace (composer, feed, live stage, chips, report)

Ticket: #13959. Builds on R1–R3 + U1–U2.

## Goal
Studio treatment for the core working area: agent feed/log panel, composer, live-browser stage chrome, status/timer/token chips, report tabs, quick-actions toolbar.

## Files
- `public/styles.css` — terminal-layer selectors for: chat/feed panel, `.composer`, textarea, send button, chips (`#timer-chip`, `#token-chip`, status chips), tab bar (Activity/Plan/Findings/Report), report cards, viewer/live-stage chrome, quick-actions toolbar.
- No HTML/JS structure changes unless a seam test pins something broken.

## Acceptance criteria
- [ ] Feed/log panel: Studio light surface, sans body text, mono kept only for code/terminal motifs.
- [ ] Composer: white surface, zinc border, 8px+ radius, blue focus ring, Geist sans text.
- [ ] Chips (timer/token/status): alpha-tinted Studio pills with consistent radius.
- [ ] Tab bar: Studio underline/active-accent style, no terminal arrow motifs.
- [ ] Report cards and findings rows: white cards, zinc borders, status colors (success/warn/danger) as Studio alpha chips.
- [ ] Quick-actions toolbar already Studio from R2 — regression only.
- [ ] No clipped/overlapping text in the workspace at 1440×900 (DOM measurement).
- [ ] Seam tests (finalUiPolish, founderUi, bugsUi) stay green; full verify ≥ 849 pass / 0 fail.

## Tests
- Full `npm run verify`; headless signed-in screenshots at 1440×900 light + dark.
