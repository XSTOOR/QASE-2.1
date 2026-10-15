# QASE interface identity

The supplied QASE moodboard is the visual reference. `public/qase-mark.svg` is a
scalable, code-native interpretation of its split-tail Q symbol, using cyan,
blue, and violet. It is shared by the app identity, setup flow, report breadcrumb,
sign-in header, and favicon. The sidebar wordmark uses a geometric open A.

`public/brand.css` is the shared identity layer, loaded after existing feature
styles. Feature sheets continue to own panel sizing, routing, and responsive
behavior. Do not duplicate navigation handlers or replace backend states for
visual presentation.

## Principles

- Layered charcoal and neutral-gray foundations in dark mode, with the white QASE mark
  and white primary actions with black labels. Small semantic status lights are
  green (complete), blue (running), amber (waiting/blocked), red (error), or gray
  (idle/queued/stopped). Badge text and surfaces remain neutral.
- Browser choices retain their full-color brand icons and subtle brand-tinted
  borders/backgrounds. Disabled choices remain clearly labeled unavailable.
- Primary actions share one theme palette; mode-specific `!important` foreground
  overrides are prohibited. Disabled actions use explicit, contrast-tested gray
  foreground/background pairs rather than applying whole-button transparency.
- Light mode retains cool neutral surfaces, the gradient mark, and blue actions.
- One primary action per decision point, secondary actions visually quiet.
- Consistent line icons, 7–12px corners, restrained borders, no neon glows.
- UI text uses the system/Geist stack; technical evidence retains monospace.
- Dark elevation runs from a recessed sidebar/canvas through the workspace to
  raised cards, composer, and hover surfaces. Distinguish hierarchy with value
  and spacing, not saturated borders or excessive outlines.
- Preserve status semantics: blue is navigation, not a substitute for a result.
- Visible keyboard focus and reduced-motion support are required.
- Shared text and button token pairs are contrast-tested in `public/brand.test.js`.
- Live browser previews and screenshot evidence retain their original colors;
  monochrome styling applies to QASE controls, not the application being tested.

## Verification

Run `node --test public/brand.test.js` alongside the existing UI regression tests.
Inspect the workspace, setup wizard, account page, bug backlog, model preferences,
quality review, product review, and focused results. Test light/dark appearance,
collapsed navigation, and narrow viewports without starting paid model runs.
