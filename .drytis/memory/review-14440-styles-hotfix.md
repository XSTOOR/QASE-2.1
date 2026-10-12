# Review of hotfix #14440 (unstyled MODES drawer + sidebar overlap after DEV merge 78e3cd5)

Round 2 (verification after fixes) — uncommitted diff on public/index.html + public/styles.css.

## Verdict: round-1 issues resolved; 1 residual (pre-existing) truncated-fragment cluster remains.

## Round-1 findings → resolution
1. **Mobile dead band (round-1 top WARN)** — FIXED. The appended ≤720px `.cli-theme .app` rule (styles.css ~9933) now declares **4 tracks**: `minmax(300px,auto) 62px minmax(680px,82dvh) minmax(700px,88dvh)`, matching the pinned grid-row placements at ~8298 (.runs→1, .feature-dock→2, .chat→3, .viewer→4). Live probe at 390×844 both schemes: computed rows 491/62/692/743; dock bottom 598 → chat top 604 (gap 6px); page height 2273 (was 2676 with the dead band; 2074 pre-hotfix — slight growth from row-1 auto-sizing, acceptable). Cascade correct: same 720px media, later position (9933 > 8291), higher specificity (.cli-theme .app vs .app) — wins cleanly on both axes, no conflict with the base `292px 62px …` template.
2. **Truncated declarations** — PARTIALLY FIXED. All `ding:`/`der-color:`/`kground:` fragments repaired (grep = 0). **8 remain** that the dev's grep pattern missed: `or:var(--accent)` at 5611, 5857, 6116, 6308, 6369 (truncates `color:` on ::before pseudo-elements of .chat-id h1, .chat-target, .modal-head h2, .entry-eyebrow, .entry-cta) and `der:1px solid var(--border-strong)` at 8696, 8700, 8708 (truncates `border:` on .feedback-filters input, .feedback-filter-row select, .feedback-row-status). All 8 pre-exist in HEAD (5+3 there too); NOT introduced by this diff. Effect: ::before prompts render in inherited text color, feedback form controls lose borders. Cosmetic; separate ticket candidate.

## Standing facts (re-confirmed round 2)
- Suite: 924 tests / 904 pass / 0 fail / 20 skipped (reproduced independently both rounds).
- dialog:not([open]){display:none!important} safe — all modals native <dialog>, JS uses showModal()/close() only. 0 zombie dialogs live at both viewports/schemes.
- Mobile auth-gates the UI: probes must register via #auth-switch/#auth-email/#auth-password/#auth-display/#auth-submit then wait for #auth-gate[hidden] (see .fix-sweep.mjs).
- Dark dock = --surface-1 (rgb(26,26,26)); --surface undefined in tokens was the original white-dock bug.
- finalUiPolish.test.js pins base .panel-foot 4-col grid; hotfix layers .cli-theme rules above it — accepted.
