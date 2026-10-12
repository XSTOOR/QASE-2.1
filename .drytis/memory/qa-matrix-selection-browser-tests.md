# QA matrix selection — browser test rounds 1 & 2 (QASE-2.1 preview)

Round 1 (2026-10-08): FAIL 3/6 — Select All kept 37,238 stale deselectedEnvIds (count stuck at 6); device-row click hit a version chip and mutated selection; device Deselect All left 175/176 deviceKeys.

Round 2 (post-fix, same day): PASS 5/5 —
- Select All Devices + Select All Browsers from clean zero state → "37,244 of 37,244 selected · will run as 19 batches"; store deselectedEnvIds cleared to 0.
- Legacy broken-state injection (fake deviceKeys + fake-1/fake-2 overrides) + bulk Select All → still 37,244; fake overrides harmless.
- Scope via explicit "View" button: banner "← Back to all devices", summary shows GLOBAL count first then "— viewing: Apple iPhone 15 … 222 of its configurations selected". Exit restores full tree (with search cleared), count unchanged.
- Devices "Deselect All" truly empties deviceKeys (176→0). 3 devices (iPhone 15, Galaxy S24, Pixel 9) × {chrome, firefox} → summary 280 (Chrome 51/8602 + Firefox 54/9108); all 3 device checkboxes checked in DOM.
- DuckDuckGo family checkbox disabled, reason: "DuckDuckGo is a mobile-only browser with no Linux desktop build and no automation channel — no local execution provider can run it."
- Console: 0 errors, 0 warnings.

Testing tips: dialog opens via "Start standard QA run" nav button; summary line matched via /available configurations selected/ leaf nodes; family checkboxes are the ones whose label ends "/N selected" (per-family totals: chrome 8602, edge 8602, firefox 9108, opera 8096, brave 2530, safari 306); device checkboxes have aria-label "Select <device>"; device rows render lazily — use the search box to bring hidden devices into DOM. Bulk button order in DOM: [Select All Browsers, Deselect All, Select All Devices, Deselect All].
