# Fix UI regression after DEV merge — unstyled MODES drawer + overlapping sidebar nav

## Problem
Screenshot (userDocs/image_bf6ca0ef.png) shows the workspace with:
1. A white unstyled "MODES" drawer at bottom-left (raw HTML: white bg, serif text, floating icons, "DEVICE None yet. Set" card)
2. Overlapping/duplicated sidebar navigation ("My account / Sign out" colliding with "Settings / Device Matrix / Test cases", garbled overlap, duplicated "Bulk runs")
3. Rotated "MODES"/"OF 10" labels reading as broken

Suspected cause: the #14282 DEV merge un-prefixed/removed selectors our R1–R6 + U2 work relies on (feature-dock rail, sidebar-nav, panel-foot grid).

## Work
- Diagnose missing selectors for .feature-dock / MODES drawer and sidebar footer/nav
- Restore Studio styling; no overlap or duplication
- Verify: 1440×900 + 390×844, light+dark, zero clipped/overlapping elements; npm run verify 0 fail

## Acceptance criteria
- [ ] Modes/device picker rail renders in Studio theme (no white unstyled panel), both themes
- [ ] No text overlap or duplicated nav items in the sidebar
- [ ] No clipped/overflowing elements at 1440×900 and mobile width
- [ ] Full suite passes with 0 failures
