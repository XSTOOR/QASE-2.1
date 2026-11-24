/**
 * The QASE capability registry: every testing category the QA engine knows,
 * with when it applies, what access it needs, which executor (unit) runs it,
 * its safety class, the evidence it produces, its pass/fail criteria, how it
 * recovers, and how deeply QASE supports it today.
 *
 *   support: executed    — run in the browser with evidence
 *            partial     — run, but covers only part of the category (the note says which)
 *            unsupported — not run; `prerequisite` says what would make it runnable
 *
 * Nothing here is application specific: applicability is decided from the
 * application graph the engine builds while exploring.
 */

const GROUPS = {
	functional: { tools: ['Playwright browser', 'crawler', 'DOM observation'], evidence: ['page URL', 'HTTP status', 'screenshot', 'console/network log'], recovery: 'Reload the page once; a second failure is recorded as a finding or as inconclusive.' },
	auth: { tools: ['Playwright browser', 'credential vault', 'signed-out context'], evidence: ['sign-in steps (never the password)', 'final URL', 'session indicators', 'HTTP status of protected routes'], recovery: 'Re-authenticate once on session expiry; MFA/CAPTCHA pause for a person.' },
	layout: { tools: ['DOM geometry audit', 'screenshots', 'reasoning-model visual review'], evidence: ['element selector', 'bounding boxes', 'screenshot'], recovery: 'Re-measure after fonts and images settle.' },
	motion: { tools: ['interaction runner', 'animation filmstrips', 'reduced-motion context'], evidence: ['filmstrip frames', 'timing', 'element state before/after'], recovery: 'Reload between controls so one broken control cannot hide the next.' },
	a11y: { tools: ['DOM accessibility audit', 'keyboard driver'], evidence: ['element selector', 'computed role/name', 'focus order'], recovery: 'Retry once after the page settles.' },
	performance: { tools: ['Performance API', 'PerformanceObserver', 'network log'], evidence: ['LCP/CLS/long-task timings', 'transfer sizes', 'heap samples'], recovery: 'Measure on a fresh load.' },
	security: { tools: ['header/cookie audit', 'non-destructive probes', 'guarded fetch'], evidence: ['request and response excerpt', 'header values'], recovery: 'Probes are read-only and idempotent; a timeout is inconclusive, never a pass.' },
	network: { tools: ['network emulation', 'request log', 'WebSocket observer'], evidence: ['request list', 'emulated condition', 'page state'], recovery: 'Restore the network and reload.' },
	state: { tools: ['history navigation', 'reload', 'storage inspection'], evidence: ['state before/after', 'storage keys (never values that look secret)'], recovery: 'Start from a fresh load of the page.' },
	content: { tools: ['DOM metadata audit', 'manifest fetch'], evidence: ['meta tags', 'manifest', 'robots/sitemap response'], recovery: 'Read-only; refetch once.' },
	dom: { tools: ['DOM structure audit', 'MutationObserver', 'Web Animations API', 'interaction runner'], evidence: ['element selector', 'element counts', 'mutation counts', 'reference that does not resolve'], recovery: 'Re-measure on a fresh load after the page settles.' }
};

const SAFETY = { read: 'read-only', probe: 'non-destructive probe', write: 'writes data — needs owner authorization', destructive: 'destructive — never run against production without authorization', human: 'needs a person (security control)' };

/**
 * Compact table: [id, name, group, units, detectors, options].
 * detectors match promoted findings to the category (exact id or a prefix ending in '.').
 * options: applies (graph feature or predicate name), access ('public' | 'signed_in' | 'role'),
 *          safety, support, prerequisite, pass, fail, note.
 */
const TABLE = [
	// Functional (1–22)
	['page_load', 'Pages load', 'functional', ['observe', 'page_audit'], ['page.unreachable', 'page.blank_page', 'page.http_error_page'], { pass: 'Every discovered page returns 2xx/3xx and renders content.', fail: 'A page fails to load, is blank, or returns 5xx.' }],
	['navigation', 'Navigation menus', 'functional', ['page_audit', 'interactions'], ['motion.dead_control', 'page.broken_anchor'], { applies: 'navigation', pass: 'Navigation links and controls lead somewhere and respond.', fail: 'A navigation control does nothing or points to a missing anchor.' }],
	['internal_links', 'Internal links', 'functional', ['links'], ['links.broken'], { pass: 'Every internal link resolves (2xx/3xx).', fail: 'An internal link returns 4xx/5xx.' }],
	['external_links', 'External links', 'functional', ['links'], ['links.broken'], { applies: 'external_links', pass: 'External links resolve.', fail: 'An external link is dead.' }],
	['deep_links', 'Deep links and direct routes', 'functional', ['page_audit'], ['page.unreachable', 'page.http_error_page'], { pass: 'Each route opens directly from its URL.', fail: 'A route only works when reached by clicking.' }],
	['redirects', 'Redirect handling', 'functional', ['page_audit', 'redirects'], ['security.open_redirect', 'security.https_redirect_missing'], { pass: 'Redirects land on in-scope pages.', fail: 'A redirect loops, leaves scope or is open.' }],
	['search', 'Search', 'functional', ['search'], ['search.', 'security.reflected_xss'], { applies: 'search', pass: 'Search accepts terms, shows results or an empty state, and survives unusual input.', fail: 'Search errors, shows broken output, or reflects input unsafely.' }],
	['filtering', 'Filtering', 'functional', ['search'], ['search.filter_'], { applies: 'filter', pass: 'Each filter option loads without error.', fail: 'A filter option errors or breaks the page.' }],
	['sorting', 'Sorting', 'functional', ['search'], ['search.sort_'], { applies: 'sort', pass: 'Sort controls load without error.', fail: 'A sort control errors.' }],
	['pagination', 'Pagination', 'functional', ['search'], ['search.pagination_', 'page.http_error_page'], { applies: 'pagination', pass: 'Every reachable results page loads.', fail: 'A results page errors or is unreachable.' }],
	['tables', 'Data tables', 'functional', ['page_audit', 'viewports'], ['page.horizontal_overflow', 'page.text_clipped'], { applies: 'table', pass: 'Tables render and fit their viewport or scroll inside a container.', fail: 'A table overflows the page or clips content.' }],
	['form_validation', 'Form validation', 'functional', ['forms'], ['forms.no_validation', 'forms.silent_rejection'], { applies: 'forms', pass: 'Empty and invalid input is rejected with a visible message.', fail: 'A form accepts empty input or rejects it silently.' }],
	['required_fields', 'Required fields', 'functional', ['forms'], ['forms.no_validation'], { applies: 'forms', pass: 'Required fields are enforced.', fail: 'Required data can be left empty.' }],
	['input_formats', 'Input formats (email, number, date)', 'functional', ['forms'], ['forms.invalid_email_accepted'], { applies: 'forms', pass: 'Malformed email/number/date input is rejected.', fail: 'Malformed input is accepted.' }],
	['file_upload', 'File upload controls', 'functional', ['forms'], ['forms.upload_'], { applies: 'upload', support: 'partial', note: 'The control and its accepted types are inspected; no file is uploaded without write authorization.', pass: 'Upload inputs declare accepted types and are labelled.', fail: 'An upload input accepts any file type with no guidance.' }],
	['create_records', 'Create records', 'functional', [], [], { applies: 'forms', safety: 'write', support: 'unsupported', prerequisite: 'Owner authorization for writes on a test environment (launch with writes allowed).' }],
	['update_records', 'Update records', 'functional', [], [], { applies: 'forms', safety: 'write', support: 'unsupported', prerequisite: 'Owner authorization for writes on a test environment.' }],
	['delete_records', 'Delete records', 'functional', [], [], { safety: 'destructive', support: 'unsupported', prerequisite: 'Explicit authorization for destructive tests and a disposable test environment.' }],
	['workflows', 'Multi-step user journeys', 'functional', ['explore'], ['agent.exploration'], { pass: 'The planned journeys complete without observed defects.', fail: 'A journey step fails or shows wrong data.' }],
	['not_found', 'Not-found handling', 'functional', ['links', 'page_audit'], ['links.broken'], { pass: 'Missing pages answer 404 with a helpful page.', fail: 'Missing pages answer 200 or crash.' }],
	['server_errors', 'Server errors', 'functional', ['page_audit', 'search'], ['page.http_error_page', 'security.stack_trace'], { pass: 'No route answers 5xx.', fail: 'A route answers 5xx or shows a stack trace.' }],
	['empty_states', 'Empty states', 'functional', ['search'], ['search.empty_state'], { applies: 'search', pass: 'A search with no matches explains it.', fail: 'No-result pages are blank or broken.' }],

	// Authentication and authorization (23–38)
	['auth_detection', 'Sign-in detection', 'auth', ['observe'], [], { pass: 'Sign-in entry points (forms, links, identifier steps, SSO) were identified or ruled out.', fail: 'n/a — detection always reports what it saw.' }],
	['login', 'Sign in with the test account', 'auth', ['signin'], ['auth.signin_failed'], { applies: 'auth', pass: 'The authorized account signs in and the session is verified.', fail: 'Valid credentials do not produce a verified session.' }],
	['multi_step_login', 'Multi-step sign-in', 'auth', ['signin'], [], { applies: 'identifier_step', pass: 'The identifier step leads to a password step and a verified session.', fail: 'The identifier step dead-ends.' }],
	['login_errors', 'Wrong-password messaging', 'auth', [], [], { applies: 'auth', safety: 'probe', support: 'unsupported', prerequisite: 'Owner approval to submit a wrong password (it can trigger account lockout).' }],
	['session_verification', 'Session verification', 'auth', ['signin'], [], { applies: 'auth', access: 'signed_in', pass: 'After sign-in a protected page loads without being sent back to sign-in.', fail: 'The session is not honoured.' }],
	['session_persistence', 'Session persistence', 'auth', ['persistence'], ['state.session_lost'], { applies: 'auth', access: 'signed_in', pass: 'The session survives reload and new tabs.', fail: 'Reloading signs the user out.' }],
	['session_expiry', 'Session expiry and re-authentication', 'auth', ['signin'], [], { applies: 'auth', access: 'signed_in', support: 'partial', note: 'Expiry is detected when a protected page redirects to sign-in during testing; QASE re-authenticates and retries.', pass: 'Expired sessions redirect to sign-in and the user can sign in again.', fail: 'An expired session shows errors instead of sign-in.' }],
	['logout', 'Sign-out control', 'auth', ['observe'], [], { applies: 'auth', access: 'signed_in', support: 'partial', note: 'The sign-out control is located; it is not clicked, so the test session is kept.', pass: 'A sign-out control is present in the signed-in area.', fail: 'No sign-out control exists.' }],
	['protected_routes', 'Protected routes redirect', 'auth', ['authz'], ['authz.'], { applies: 'protected', access: 'signed_in', pass: 'Signed-in pages redirect a signed-out visitor to sign-in (or answer 401/403).', fail: 'A signed-in page is readable signed out.' }],
	['authorization', 'Signed-out access control', 'auth', ['authz'], ['authz.protected_page_public'], { applies: 'protected', access: 'signed_in', pass: 'No signed-in-only content is served to a signed-out context.', fail: 'Signed-in content is served without a session.' }],
	['roles', 'Role-based access', 'auth', ['roles'], ['authz.role_'], { applies: 'roles', access: 'signed_in', support: 'partial', note: 'Checks how the signed-in role is refused on restricted pages; testing other roles needs one test account per role.', pass: 'Restricted pages refuse the role clearly (403 or explanation).', fail: 'A restricted page crashes or leaks content to the wrong role.' }],
	['idor', 'Object-level authorization (IDOR)', 'auth', [], [], { safety: 'probe', support: 'unsupported', prerequisite: 'Two test accounts with separate data, and owner approval.' }],
	['password_reset', 'Password reset', 'auth', [], [], { applies: 'auth', safety: 'write', support: 'unsupported', prerequisite: 'A test mailbox and approval to send reset emails.' }],
	['signup', 'Account creation', 'auth', [], [], { safety: 'write', support: 'unsupported', prerequisite: 'Owner authorization to create accounts on a test environment.' }],
	['mfa', 'Multi-factor authentication', 'auth', [], [], { applies: 'challenge', safety: 'human', support: 'unsupported', prerequisite: 'A person completes the second factor; QASE never bypasses it.' }],
	['captcha', 'CAPTCHA handling', 'auth', [], [], { applies: 'challenge', safety: 'human', support: 'unsupported', prerequisite: 'A person completes the CAPTCHA; QASE never bypasses it.' }],
	['sso', 'Single sign-on (OAuth)', 'auth', [], [], { applies: 'sso', safety: 'human', support: 'unsupported', prerequisite: 'A test identity at the provider and approval to leave the target origin.' }],

	// Layout and visual (39–56)
	['text_overlap', 'Overlapping text', 'layout', ['page_audit', 'viewports'], ['page.text_overlap', 'page.text_obscured'], { pass: 'No text box overlaps another.', fail: 'Text overlaps text.' }],
	['obscured_controls', 'Obscured controls', 'layout', ['page_audit', 'viewports'], ['page.control_obscured', 'page.blocking_overlay'], { pass: 'Every visible control can be clicked.', fail: 'An element covers a control.' }],
	['text_clipping', 'Clipped text', 'layout', ['page_audit', 'viewports'], ['page.text_clipped', 'page.clipped_by_container', 'page.text_overflow_box'], { pass: 'No text is cut off.', fail: 'Text is clipped by its container.' }],
	['horizontal_overflow', 'Horizontal overflow', 'layout', ['page_audit', 'viewports'], ['page.horizontal_overflow', 'page.scrollbar_shift'], { pass: 'Pages fit the viewport width.', fail: 'The page scrolls sideways.' }],
	['broken_images', 'Broken images', 'layout', ['page_audit'], ['page.broken_image'], { pass: 'Every image loads.', fail: 'An image fails to load.' }],
	['image_distortion', 'Distorted images', 'layout', ['page_audit'], ['page.distorted_image'], { pass: 'Images keep their aspect ratio.', fail: 'An image is stretched or squashed.' }],
	['stacking', 'Stacking order (z-index)', 'layout', ['interactions'], ['motion.opens_behind'], { applies: 'menus', pass: 'Menus and dialogs open above the content.', fail: 'A menu or dialog opens behind content.' }],
	['offscreen', 'Off-screen popups', 'layout', ['interactions'], ['motion.opens_offscreen'], { applies: 'menus', pass: 'Opened menus stay inside the viewport.', fail: 'A menu opens off screen.' }],
	['responsive_mobile', 'Mobile layout', 'layout', ['viewports'], ['page.'], { pass: 'Key pages pass the layout audit at mobile width.', fail: 'A layout defect appears at mobile width.' }],
	['responsive_tablet', 'Tablet layout', 'layout', ['viewports'], ['page.'], { pass: 'Key pages pass the layout audit at tablet width.', fail: 'A layout defect appears at tablet width.' }],
	['responsive_desktop', 'Desktop layout', 'layout', ['page_audit'], ['page.'], { pass: 'Pages pass the layout audit at desktop width.', fail: 'A layout defect appears at desktop width.' }],
	['broken_text', 'Broken rendered text', 'layout', ['page_audit'], ['page.broken_text', 'page.text'], { pass: 'No "undefined", "NaN", "[object Object]" or template text is shown.', fail: 'Broken data is rendered as text.' }],
	['placeholder_copy', 'Placeholder copy', 'layout', ['page_audit'], ['page.placeholder_copy'], { pass: 'No lorem ipsum or placeholder text ships.', fail: 'Placeholder copy is visible.' }],
	['loading_states', 'Loading states', 'layout', ['page_audit', 'slow_network'], ['network.stuck_loading'], { pass: 'Loading indicators resolve to content or an error message.', fail: 'A loading indicator never resolves.' }],
	['visual_review', 'AI visual review', 'layout', ['visual'], ['visual.review'], { pass: 'The reasoning model found no visual defect in the screenshots.', fail: 'A visual defect was confirmed.' }],
	['dark_mode', 'Dark colour scheme', 'layout', ['dark_mode'], ['scheme.'], { pass: 'With a dark colour-scheme preference, text stays readable.', fail: 'Text becomes unreadable in dark mode.' }],
	['cross_browser', 'Other browser engines', 'layout', [], [], { support: 'unsupported', prerequisite: 'Firefox/WebKit browsers installed for QASE (QASE_QA_ENGINES); this run used one engine.' }],

	// Motion and interaction (57–68)
	['menus', 'Menus and toggles', 'motion', ['interactions'], ['motion.dead_control', 'motion.aria_expanded_stale', 'motion.expanded_without_content'], { applies: 'menus', pass: 'Every toggle opens and closes its content and updates aria-expanded.', fail: 'A toggle does nothing or misreports its state.' }],
	['dialogs', 'Dialogs', 'motion', ['interactions'], ['motion.escape_does_not_close', 'motion.focus_not_moved'], { applies: 'dialogs', pass: 'Dialogs open, take focus and close with Escape.', fail: 'A dialog traps the user or ignores Escape.' }],
	['accordions', 'Accordions and disclosures', 'motion', ['interactions'], ['motion.expanded_without_content', 'motion.slow_animation'], { applies: 'accordion', pass: 'Disclosures reveal content promptly.', fail: 'A disclosure opens empty or slowly.' }],
	['animation_timing', 'Animation timing', 'motion', ['interactions'], ['motion.slow_animation', 'motion.animation_unfinished'], { applies: 'menus', pass: 'Animations finish within 600 ms and end in a stable state.', fail: 'An animation is slow or never finishes.' }],
	['animation_smoothness', 'Animation smoothness', 'motion', ['interactions'], ['motion.janky_animation', 'motion.layout_animation'], { applies: 'menus', pass: 'Animations do not drop frames or animate layout properties.', fail: 'An animation is janky.' }],
	['reduced_motion', 'Reduced-motion preference', 'motion', ['reduced_motion'], ['motion.reduced_motion_ignored'], { pass: 'Animations stop when the user prefers reduced motion.', fail: 'Motion continues under prefers-reduced-motion.' }],
	['hover_menus', 'Hover submenus', 'motion', ['hover'], ['motion.submenu_hover_gap'], { applies: 'menus', pass: 'Submenus stay open while the pointer moves into them.', fail: 'A submenu closes in the gap.' }],
	['layout_shift', 'Layout shift while loading', 'motion', ['page_audit'], ['page.layout_shift'], { pass: 'CLS ≤ 0.1.', fail: 'Content jumps while loading (CLS > 0.1).' }],
	['scroll_reveal', 'Scroll-reveal content', 'motion', ['page_audit'], ['page.hidden_content'], { pass: 'Content revealed on scroll becomes visible.', fail: 'Content stays hidden.' }],
	['animation_filmstrips', 'Animation filmstrip review', 'motion', ['visual'], ['visual.animation'], { applies: 'menus', pass: 'Filmstrips show clean start and end states.', fail: 'A frame shows a broken intermediate state.' }],
	['carousels', 'Carousels and sliders', 'motion', ['interactions'], ['motion.'], { applies: 'carousel', support: 'partial', note: 'Carousel controls are clicked like other toggles; autoplay timing is not measured.', pass: 'Carousel controls respond.', fail: 'Carousel controls do nothing.' }],
	['drag_drop', 'Drag and drop', 'motion', [], [], { applies: 'draggable', safety: 'write', support: 'unsupported', prerequisite: 'Write authorization (drag-and-drop usually saves a change).' }],

	// Accessibility (69–86)
	['alt_text', 'Image alternative text', 'a11y', ['page_audit'], ['page.image_alt_missing'], { pass: 'Informative images have alt text.', fail: 'An image has no alt text.' }],
	['contrast', 'Colour contrast', 'a11y', ['page_audit', 'dark_mode'], ['page.low_contrast'], { pass: 'Text meets WCAG AA contrast.', fail: 'Text is below 4.5:1 (3:1 large).' }],
	['form_labels', 'Form labels', 'a11y', ['page_audit', 'forms'], ['page.field_no_label'], { applies: 'forms', pass: 'Every field has a label.', fail: 'A field has no accessible label.' }],
	['accessible_names', 'Accessible names', 'a11y', ['page_audit'], ['page.control_no_name', 'page.control'], { pass: 'Every control has an accessible name.', fail: 'A control has no name.' }],
	['document_language', 'Document language', 'a11y', ['page_audit', 'i18n'], ['page.missing_lang'], { pass: '<html lang> is set.', fail: 'No document language.' }],
	['zoom', 'Pinch zoom allowed', 'a11y', ['page_audit'], ['page.zoom_disabled'], { pass: 'Zoom is not disabled.', fail: 'The viewport disables zoom.' }],
	['touch_targets', 'Touch target size', 'a11y', ['page_audit', 'viewports'], ['page.small_touch_targets'], { pass: 'Touch targets are at least 24×24 px.', fail: 'Targets are too small.' }],
	['keyboard_navigation', 'Keyboard navigation', 'a11y', ['keyboard'], ['keyboard.no_focus', 'keyboard.unreachable'], { pass: 'Tab reaches the main controls.', fail: 'Controls cannot be reached with Tab.' }],
	['focus_visible', 'Visible focus', 'a11y', ['keyboard'], ['keyboard.focus_invisible'], { pass: 'Focused elements show a visible indicator.', fail: 'Focus is invisible.' }],
	['keyboard_trap', 'Keyboard traps', 'a11y', ['keyboard'], ['keyboard.trap'], { pass: 'Focus moves on and never gets stuck.', fail: 'Focus is trapped.' }],
	['escape_key', 'Escape closes overlays', 'a11y', ['interactions'], ['motion.escape_does_not_close'], { applies: 'dialogs', pass: 'Escape closes menus and dialogs.', fail: 'Escape does nothing.' }],
	['headings', 'Heading structure', 'a11y', ['keyboard'], ['keyboard.no_h1', 'keyboard.heading_skip'], { pass: 'One h1 and no skipped heading levels.', fail: 'Headings are missing or skip levels.' }],
	['landmarks', 'Landmarks', 'a11y', ['keyboard'], ['keyboard.no_main'], { pass: 'The page has a main landmark.', fail: 'No main landmark.' }],
	['duplicate_ids', 'Duplicate IDs', 'a11y', ['page_audit'], ['page.duplicate_ids'], { pass: 'Element IDs are unique.', fail: 'IDs repeat (labels and ARIA references break).' }],
	['skip_link', 'Skip link', 'a11y', ['keyboard'], ['keyboard.no_skip_link'], { applies: 'navigation', pass: 'The first Tab stop is a skip link (or the page has little navigation).', fail: 'Long navigation has no skip link.' }],
	['screen_reader', 'Screen-reader output', 'a11y', [], [], { support: 'unsupported', prerequisite: 'A real assistive-technology run (VoiceOver/NVDA); the DOM audit covers names, roles and labels.' }],
	['media_captions', 'Captions for media', 'a11y', ['media'], ['media.no_captions'], { applies: 'media', pass: 'Videos have caption tracks.', fail: 'A video has no captions.' }],
	['autoplay', 'Auto-playing media', 'a11y', ['media'], ['media.autoplay_sound'], { applies: 'media', pass: 'No media autoplays with sound.', fail: 'Media autoplays with sound.' }],

	// Performance (87–98)
	['lcp', 'Largest contentful paint', 'performance', ['page_audit', 'performance'], ['page.slow_load', 'perf.slow_lcp'], { pass: 'LCP ≤ 2.5 s on a fresh load.', fail: 'LCP above 2.5 s.' }],
	['ttfb', 'Server response time', 'performance', ['performance'], ['perf.slow_ttfb'], { pass: 'TTFB ≤ 800 ms.', fail: 'TTFB above 800 ms.' }],
	['long_tasks', 'Main-thread long tasks', 'performance', ['page_audit'], ['page.long_tasks'], { pass: 'No long-task burst blocks input.', fail: 'Long tasks block the main thread.' }],
	['page_weight', 'Page weight', 'performance', ['page_audit'], ['page.heavy_page'], { pass: 'Transfer size under the heavy-page threshold.', fail: 'The page is very heavy.' }],
	['failed_requests', 'Failed requests', 'performance', ['page_audit'], ['page.failed_request'], { pass: 'No request fails while loading.', fail: 'A request fails (4xx/5xx/network).' }],
	['caching', 'Caching headers', 'performance', ['performance'], ['perf.no_cache_static'], { pass: 'Static assets are cacheable.', fail: 'Static assets have no caching.' }],
	['compression', 'Text compression', 'performance', ['performance'], ['perf.uncompressed'], { pass: 'Large text responses are compressed.', fail: 'Large text is served uncompressed.' }],
	['image_optimization', 'Image optimization', 'performance', ['performance'], ['perf.oversized_image'], { pass: 'Images are not far larger than displayed.', fail: 'An image is much larger than its display size.' }],
	['memory', 'Memory growth', 'performance', ['memory'], ['perf.memory_growth'], { support: 'partial', note: 'JS heap is sampled across repeated loads in Chromium; native leaks are not measured.', pass: 'Heap returns near baseline after repeated loads.', fail: 'Heap grows steadily.' }],
	['load_testing', 'Load testing', 'performance', [], [], { safety: 'destructive', support: 'unsupported', prerequisite: 'Explicit authorization and a non-production environment (QASE never load-tests production).' }],
	['stress_testing', 'Stress and spike testing', 'performance', [], [], { safety: 'destructive', support: 'unsupported', prerequisite: 'Explicit authorization and a non-production environment.' }],
	['render_blocking', 'Render-blocking resources', 'performance', ['performance'], ['perf.render_blocking'], { pass: 'Few render-blocking scripts in <head>.', fail: 'Many synchronous scripts block rendering.' }],

	// Security (99–122)
	['security_headers', 'Security headers', 'security', ['security_origin'], ['security.nosniff_missing', 'security.referrer_policy_missing'], { pass: 'Baseline security headers are present.', fail: 'A baseline header is missing.' }],
	['csp', 'Content Security Policy', 'security', ['security_origin'], ['security.csp_missing', 'security.csp_weak'], { pass: 'A CSP is set without unsafe wildcards.', fail: 'No CSP, or an unsafe one.' }],
	['hsts', 'HSTS and HTTPS redirect', 'security', ['security_origin'], ['security.hsts_missing', 'security.https_redirect_missing'], { pass: 'HTTPS is enforced.', fail: 'HTTPS is not enforced.' }],
	['clickjacking', 'Clickjacking protection', 'security', ['security_origin'], ['security.clickjacking'], { pass: 'Framing is restricted.', fail: 'The site can be framed.' }],
	['cookies', 'Cookie flags', 'security', ['security_origin'], ['security.cookie_flags'], { pass: 'Session cookies are HttpOnly, Secure and SameSite.', fail: 'A cookie lacks a protective flag.' }],
	['cors', 'CORS policy', 'security', ['security_origin'], ['security.cors_reflection'], { pass: 'Origins are not reflected with credentials.', fail: 'Any origin is allowed with credentials.' }],
	['exposed_files', 'Exposed files', 'security', ['security_origin'], ['security.exposed_file', 'security.source_map'], { pass: 'No .env, .git or source maps are served.', fail: 'A sensitive file is served.' }],
	['client_secrets', 'Secrets in client code', 'security', ['page_audit'], ['security.client_secret'], { pass: 'No keys or tokens in shipped JavaScript.', fail: 'A secret is exposed in the client.' }],
	['vulnerable_libraries', 'Vulnerable libraries', 'security', ['page_audit'], ['security.vulnerable_library'], { pass: 'No library with a known vulnerable version.', fail: 'A known-vulnerable library is loaded.' }],
	['version_disclosure', 'Version disclosure', 'security', ['security_origin'], ['security.version_disclosure'], { pass: 'Server versions are not advertised.', fail: 'Server software versions are disclosed.' }],
	['reflected_xss', 'Reflected XSS', 'security', ['injection', 'search'], ['security.reflected_xss'], { pass: 'Probe markup is escaped everywhere it is reflected.', fail: 'Probe markup is reflected unescaped.' }],
	['dom_xss', 'DOM XSS', 'security', ['injection'], ['security.dom_xss'], { pass: 'URL input never reaches a DOM sink unescaped.', fail: 'URL input executes in the DOM.' }],
	['sql_errors', 'SQL error disclosure', 'security', ['injection'], ['security.sql_error'], { pass: 'Quote probes cause no database error.', fail: 'A probe exposes a database error.' }],
	['open_redirect', 'Open redirects', 'security', ['redirects'], ['security.open_redirect'], { pass: 'Redirect parameters cannot send users off-site.', fail: 'A redirect parameter leads off-site.' }],
	['csrf', 'CSRF protection', 'security', ['page_audit'], ['security.csrf_token_missing'], { applies: 'forms', pass: 'State-changing forms carry a CSRF token or SameSite protection.', fail: 'A form has no CSRF protection.' }],
	['mixed_content', 'Mixed content', 'security', ['page_audit'], ['security.mixed_content', 'security.insecure_form_action', 'security.password_over_http'], { pass: 'HTTPS pages load nothing over HTTP.', fail: 'Insecure content is loaded or submitted.' }],
	['tabnabbing', 'Reverse tab-nabbing', 'security', ['page_audit'], ['security.reverse_tabnabbing'], { applies: 'external_links', pass: 'target=_blank links use noopener.', fail: 'A link opens a page that can control this one.' }],
	['debug_output', 'Debug output and stack traces', 'security', ['page_audit', 'injection'], ['security.stack_trace'], { pass: 'No stack traces are shown.', fail: 'A stack trace is exposed.' }],
	['storage_secrets', 'Tokens in browser storage', 'security', ['storage'], ['storage.secret_in_storage'], { pass: 'No password or long-lived secret in localStorage.', fail: 'A secret is readable by any script.' }],
	['security_txt', 'security.txt', 'security', ['security_origin'], ['security.security_txt_missing'], { pass: 'A security contact is published.', fail: 'No security.txt.' }],
	['brute_force', 'Brute-force protection', 'security', [], [], { applies: 'auth', safety: 'destructive', support: 'unsupported', prerequisite: 'Explicit authorization (repeated wrong sign-ins can lock accounts).' }],
	['auth_bypass', 'Authentication bypass testing', 'security', [], [], { applies: 'auth', safety: 'destructive', support: 'unsupported', prerequisite: 'A penetration-testing authorization and scope agreement.' }],
	['dependency_audit', 'Server dependency audit', 'security', [], [], { support: 'unsupported', prerequisite: 'Access to the application source or lockfiles.' }],
	['tls', 'TLS configuration', 'security', ['security_origin'], ['security.hsts_missing'], { support: 'partial', note: 'HTTPS enforcement is checked; cipher suites and certificate chain need a TLS scanner.', pass: 'The site is served over HTTPS.', fail: 'The site is served over plain HTTP.' }],

	// Network and API (123–129)
	['api_errors', 'API errors', 'network', ['page_audit'], ['page.failed_request', 'page.console_error', 'page.page_error'], { pass: 'API calls made by pages succeed.', fail: 'An API call fails while the page loads.' }],
	['offline', 'Offline behaviour', 'network', ['offline'], ['network.offline_'], { pass: 'Going offline shows a message or cached content, never a broken page with JS errors.', fail: 'Offline use throws errors or blanks the page.' }],
	['slow_network', 'Slow network', 'network', ['slow_network'], ['network.'], { pass: 'The page becomes usable on a slow connection within the time budget.', fail: 'The page never becomes usable.' }],
	['websockets', 'WebSocket connections', 'network', ['websocket'], ['network.websocket_'], { applies: 'websocket', pass: 'Sockets connect and stay open without errors.', fail: 'A socket errors or closes immediately.' }],
	['api_contracts', 'API contract testing', 'network', [], [], { support: 'unsupported', prerequisite: 'An OpenAPI/GraphQL schema for the target API.' }],
	['third_party', 'Third-party failure resilience', 'network', ['offline'], ['network.third_party_'], { applies: 'third_party', support: 'partial', note: 'Third-party requests are blocked once; only crashes are judged.', pass: 'The page still renders when third-party scripts fail.', fail: 'A third-party failure breaks the page.' }],
	['webhooks', 'Webhooks and integrations', 'network', [], [], { safety: 'write', support: 'unsupported', prerequisite: 'A test integration endpoint and write authorization.' }],

	// State and data (130–134)
	['reload_state', 'State after reload', 'state', ['persistence'], ['state.reload_'], { pass: 'Reloading shows the same page without errors.', fail: 'Reloading loses the page or errors.' }],
	['back_forward', 'Back and forward navigation', 'state', ['history'], ['state.history_'], { pass: 'Back and forward restore the previous pages.', fail: 'Back/forward breaks or shows the wrong page.' }],
	['url_state', 'State in the URL', 'state', ['search'], ['search.state_lost'], { applies: 'filter', pass: 'Filters and search terms survive in the URL.', fail: 'Applied filters are lost on reload.' }],
	['storage_usage', 'Browser storage usage', 'state', ['storage'], ['storage.'], { pass: 'Storage is used without errors.', fail: 'Storage access throws errors.' }],
	['data_integrity', 'Saved-data integrity', 'state', [], [], { safety: 'write', support: 'unsupported', prerequisite: 'Write authorization to save and re-read test data.' }],

	// DOM integrity and idle behaviour (141–149)
	['dom_nesting', 'Valid element nesting', 'dom', ['page_audit'], ['page.invalid_nesting', 'page.form_in_form', 'page.orphan_list_item'], { pass: 'No control inside another control, no nested forms, list items inside lists.', fail: 'Controls or forms are nested, or list items sit outside a list.' }],
	['dom_references', 'ID references resolve', 'dom', ['page_audit'], ['page.broken_aria_reference'], { pass: 'Every aria-labelledby, aria-describedby, aria-controls and label for= points to an element on the page.', fail: 'A reference points to an id that does not exist.' }],
	['dom_hidden_focus', 'Hidden content is not focusable', 'dom', ['page_audit'], ['page.aria_hidden_focusable'], { pass: 'Nothing inside aria-hidden content can take keyboard focus.', fail: 'Keyboard focus reaches content hidden from screen readers.' }],
	['dom_roles', 'Valid ARIA roles', 'dom', ['page_audit'], ['page.invalid_role'], { pass: 'Every role attribute is a real WAI-ARIA role.', fail: 'An element uses a role that does not exist.' }],
	['dom_size', 'DOM size and depth', 'dom', ['page_audit'], ['page.excessive_dom'], { pass: 'Under 3,000 elements, depth under 40, no parent with more than 200 children.', fail: 'The DOM is large or deep enough to slow every interaction.' }],
	['dom_idle_stability', 'DOM stays still when idle', 'dom', ['dom_idle'], ['page.idle_dom_churn'], { pass: 'An untouched page makes fewer than 40 DOM changes a second.', fail: 'The page keeps rewriting its DOM with nobody using it.' }],
	['dom_leaks', 'No DOM leaks from repeated use', 'dom', ['interactions'], ['motion.dom_leak'], { applies: 'menus', pass: 'Opening and closing a control returns the page to the same element count.', fail: 'Each open and close adds elements that are never removed.' }],
	['dom_after_interaction', 'DOM stays valid after interactions', 'dom', ['interactions'], ['motion.dom_invalid_after_open'], { applies: 'menus', pass: 'Opened menus and dialogs keep ids unique and references resolvable.', fail: 'Opening a control creates duplicate ids or references to missing elements.' }],
	['idle_animations', 'Animations stop when not visible', 'motion', ['dom_idle'], ['page.offscreen_animation', 'page.idle_animation_loop'], { pass: 'No infinite animation runs on hidden or off-screen elements, and no animation loop runs while nothing moves.', fail: 'Animations keep running where nobody can see them.' }],
	// Content, SEO, PWA, i18n, platform (135–140)
	['seo_meta', 'Title and meta description', 'content', ['seo'], ['page.missing_title', 'seo.'], { pass: 'Every page has a unique title and a description.', fail: 'Titles or descriptions are missing or duplicated.' }],
	['seo_indexing', 'Robots, canonical and sitemap', 'content', ['seo'], ['seo.robots_', 'seo.canonical_', 'seo.sitemap_'], { pass: 'robots.txt/sitemap are consistent and no page is accidentally noindex.', fail: 'Indexing is blocked by mistake.' }],
	['pwa', 'Web app manifest and service worker', 'content', ['pwa'], ['pwa.'], { applies: 'manifest', pass: 'The manifest is valid with name, icons and start_url.', fail: 'The manifest is invalid or incomplete.' }],
	['i18n', 'Language and locale', 'content', ['i18n'], ['i18n.'], { pass: 'Declared language matches the content and no translation keys leak.', fail: 'Untranslated keys or a wrong language attribute.' }],
	['permissions', 'Permission prompts', 'content', ['permissions'], ['permissions.'], { pass: 'No permission is requested on page load without a user action.', fail: 'The page asks for location/notifications on load.' }],
	['payments', 'Payments and checkout', 'content', [], [], { applies: 'checkout', safety: 'destructive', support: 'unsupported', prerequisite: 'A payment sandbox and explicit authorization (QASE never pays on production).' }]
];

const DEFAULT_ACCESS = { auth: 'public' };

export const CAPABILITIES = Object.freeze(TABLE.map(([id, name, group, units, detectors, options = {}], index) => {
	const base = GROUPS[group];
	const support = options.support ?? (units.length ? 'executed' : 'unsupported');
	return Object.freeze({
		number: index + 1, id, name, group,
		units, detectors,
		applies: options.applies ?? 'always',
		access: options.access ?? DEFAULT_ACCESS[group] ?? 'public',
		tools: base.tools,
		strategy: units.length ? `Run by ${units.join(' + ')} and matched to findings from ${detectors.length ? detectors.join(', ') : 'the executor result'}.` : 'Not run by QASE.',
		safety: SAFETY[options.safety ?? (group === 'security' ? 'probe' : 'read')],
		evidence: base.evidence,
		pass: options.pass ?? 'No defect was confirmed by the executor.',
		fail: options.fail ?? 'A verified finding maps to this category.',
		recovery: base.recovery,
		support,
		note: options.note,
		prerequisite: options.prerequisite
	});
}));

export const CAPABILITY_COUNT = CAPABILITIES.length;
export const COVERAGE_STATES = ['passed', 'failed', 'blocked', 'inconclusive', 'not_applicable', 'unsupported', 'not_executed'];

/** Graph-driven applicability: returns { applicable, reason }. */
export function applicability(capability, graph) {
	const features = graph?.features ?? {};
	const key = capability.applies;
	if (key === 'always') return { applicable: true };
	const checks = {
		auth: () => Boolean(graph?.auth?.detected),
		identifier_step: () => Boolean(graph?.auth?.identifierStep),
		protected: () => Boolean(graph?.auth?.detected && (features.protected ?? 0) > 0) || Boolean(graph?.auth?.detected && graph?.auth?.signedIn),
		roles: () => (features.restricted ?? 0) > 0,
		challenge: () => Boolean(graph?.auth?.challenge),
		sso: () => (graph?.auth?.sso?.length ?? 0) > 0
	};
	const applicable = checks[key] ? checks[key]() : (features[key] ?? 0) > 0;
	return applicable ? { applicable: true } : { applicable: false, reason: `No ${key.replace(/_/g, ' ')} was found in the application.` };
}

const matches = (detector, patterns) => patterns.some(pattern => pattern.endsWith('.') || pattern.endsWith('_') ? String(detector ?? '').startsWith(pattern) : detector === pattern);

/**
 * Coverage state for every category, from the plan's unit outcomes and the
 * verified findings. Never "passed" unless an executor for it actually ran.
 *   units: Map unitKind → { executed, errored, notExecuted, reasons[] }
 */
export function capabilityCoverage({ graph, units, findings = [], dismissed = [], signedIn = false, viewportsTested = [] }) {
	return CAPABILITIES.map(capability => {
		const row = { number: capability.number, id: capability.id, name: capability.name, group: capability.group, support: capability.support, safety: capability.safety };
		const fail = findings.filter(item => matches(item.detector, capability.detectors) && unitMatchesViewport(capability, item, viewportsTested));
		// Applicability first: "unsupported" means the app has it and QASE cannot run it here.
		const applies = applicability(capability, graph);
		if (!applies.applicable) return { ...row, state: 'not_applicable', reason: applies.reason };
		if (capability.support === 'unsupported') return { ...row, state: 'unsupported', reason: capability.prerequisite };
		if (capability.access === 'signed_in' && !signedIn) return { ...row, state: 'blocked', reason: graph?.auth?.blockedReason ?? 'Needs a signed-in session; no verified session was available.' };
		const outcomes = capability.units.map(kind => units.get(kind)).filter(Boolean);
		const executed = outcomes.some(item => item.executed > 0);
		if (fail.length) return { ...row, state: 'failed', findings: fail.length, findingIds: fail.slice(0, 10).map(item => item.id), reason: capability.fail, note: capability.note };
		if (!executed && capability.group === 'auth' && graph?.auth?.detected && !graph.auth.signedIn && graph.auth.blockedReason) return { ...row, state: 'blocked', reason: graph.auth.blockedReason };
		if (!executed) {
			const errored = outcomes.some(item => item.errored > 0);
			const reasons = outcomes.flatMap(item => item.reasons ?? []);
			return { ...row, state: errored ? 'inconclusive' : 'not_executed', reason: reasons[0] ?? (outcomes.length ? 'The scenario was planned but did not run (time budget or stop).' : 'No scenario for this category was planned for this application.') };
		}
		const doubted = dismissed.filter(item => matches(item.detector, capability.detectors)).length;
		return { ...row, state: 'passed', reason: capability.pass, note: capability.note, ...(doubted ? { dismissed: doubted } : {}) };
	});
}

function unitMatchesViewport(capability, item, viewports) {
	if (capability.id === 'responsive_mobile') return (item.viewports ?? []).includes('mobile') && viewports.includes('mobile');
	if (capability.id === 'responsive_tablet') return (item.viewports ?? []).includes('tablet') && viewports.includes('tablet');
	if (capability.id === 'responsive_desktop') return (item.viewports ?? []).includes('desktop');
	return true;
}

export function summarizeCoverage(rows) {
	return Object.fromEntries(COVERAGE_STATES.map(state => [state, rows.filter(row => row.state === state).length]));
}
