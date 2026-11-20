/**
 * Fixed vocabularies for compliance SQA.
 *
 * The agent researches frameworks online; these lists only give its output a
 * stable shape: product categories, the measured-evidence kinds the host can
 * collect, and a small labelled baseline used when online research is not
 * possible (so a run still produces a useful, honest report).
 */

export const PRODUCT_CATEGORIES = Object.freeze({
	education: 'Education / e-learning (courses, schools, tutoring, LMS)',
	healthcare: 'Healthcare / health data / wellness',
	finance: 'Finance / banking / payments / insurance / fintech',
	ecommerce: 'E-commerce / marketplace / retail',
	saas: 'Business software / SaaS / B2B tools',
	ai: 'AI product / generative AI service',
	media: 'Media / publishing / content / streaming',
	social: 'Social network / community / user-generated content',
	government: 'Government / public sector service',
	travel: 'Travel / hospitality / booking',
	other: 'Other / general website'
});

/** Evidence the host measures itself; requirements may reference these kinds. */
export const EVIDENCE_KINDS = Object.freeze({
	'a11y.images_alt': 'Images have text alternatives (WCAG 1.1.1)',
	'a11y.form_labels': 'Form fields have labels (WCAG 1.3.1, 3.3.2)',
	'a11y.contrast': 'Text contrast meets 4.5:1 / 3:1 (WCAG 1.4.3)',
	'a11y.control_names': 'Buttons and links have accessible names (WCAG 4.1.2)',
	'a11y.lang': 'Page language is declared (WCAG 3.1.1)',
	'a11y.zoom': 'Users can zoom to 200% (WCAG 1.4.4)',
	'a11y.touch_targets': 'Touch targets are at least 24×24 px (WCAG 2.5.8)',
	'a11y.headings': 'Pages have a main heading (WCAG 1.3.1, 2.4.6)',
	'a11y.page_title': 'Pages have descriptive titles (WCAG 2.4.2)',
	'a11y.reflow': 'Content reflows at 320 px width without horizontal scrolling (WCAG 1.4.10)',
	'sec.https': 'Served over HTTPS, HTTP redirects to HTTPS',
	'sec.hsts': 'HSTS header',
	'sec.csp': 'Content-Security-Policy',
	'sec.clickjacking': 'Framing protection (X-Frame-Options / frame-ancestors)',
	'sec.nosniff': 'X-Content-Type-Options: nosniff',
	'sec.cookie_flags': 'Session cookies are Secure, HttpOnly and SameSite',
	'sec.exposed_files': 'No exposed .env/.git/backup files',
	'sec.vulnerable_libraries': 'No client libraries with known vulnerabilities',
	'sec.client_secrets': 'No secrets in client-side code',
	'sec.password_transport': 'Passwords are only sent over HTTPS',
	'sec.injection': 'No reflected XSS / SQL error / open redirect found by safe probes',
	'privacy.policy_link': 'A privacy policy is linked from the site',
	'privacy.terms_link': 'Terms of service are linked from the site',
	'privacy.cookie_banner': 'A cookie consent notice is shown',
	'privacy.cookie_reject': 'Non-essential cookies can be rejected as easily as accepted',
	'privacy.tracking_before_consent': 'No tracking cookies or trackers load before consent',
	'privacy.contact_info': 'A contact / grievance channel is published',
	'privacy.accessibility_statement': 'An accessibility statement is published',
	'privacy.children_notice': 'Child-directed features have an age / parental-consent notice',
	'privacy.form_notice': 'Forms that collect personal data link to the privacy notice'
});

const BASE = {
	wcag: { name: 'WCAG 2.2 Level AA', publisher: 'W3C', url: 'https://www.w3.org/TR/WCAG22/', kind: 'accessibility' },
	owasp: { name: 'OWASP Top 10 (2021) / ASVS Level 1 (external checks)', publisher: 'OWASP', url: 'https://owasp.org/Top10/', kind: 'security' },
	gdpr: { name: 'EU GDPR and ePrivacy (cookie consent)', publisher: 'European Union', url: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj', kind: 'privacy' },
	dpdp: { name: 'India Digital Personal Data Protection Act, 2023', publisher: 'Government of India (MeitY)', url: 'https://www.meity.gov.in/data-protection-framework', kind: 'privacy' },
	ccpa: { name: 'California CCPA / CPRA', publisher: 'State of California', url: 'https://oag.ca.gov/privacy/ccpa', kind: 'privacy' },
	coppa: { name: 'COPPA (Children’s Online Privacy Protection Rule)', publisher: 'US FTC', url: 'https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa', kind: 'privacy' },
	ferpa: { name: 'FERPA (student education records)', publisher: 'US Department of Education', url: 'https://studentprivacy.ed.gov/ferpa', kind: 'privacy' },
	ada: { name: 'ADA Title II / III web accessibility (DOJ guidance)', publisher: 'US Department of Justice', url: 'https://www.ada.gov/resources/web-guidance/', kind: 'accessibility' },
	hipaa: { name: 'HIPAA Privacy and Security Rules', publisher: 'US HHS', url: 'https://www.hhs.gov/hipaa/index.html', kind: 'privacy' },
	pci: { name: 'PCI DSS v4.0.1 (externally observable requirements)', publisher: 'PCI Security Standards Council', url: 'https://www.pcisecuritystandards.org/document_library/', kind: 'security' },
	euaiact: { name: 'EU AI Act transparency obligations (Art. 50)', publisher: 'European Union', url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj', kind: 'ai' }
};

/** Baseline requirements, each decidable from measured evidence. */
const BASE_REQUIREMENTS = {
	wcag: [
		['1.1.1', 'Non-text content has text alternatives', ['a11y.images_alt'], 'high'],
		['1.3.1 / 3.3.2', 'Form inputs have labels or instructions', ['a11y.form_labels'], 'high'],
		['1.4.3', 'Text has sufficient contrast', ['a11y.contrast'], 'medium'],
		['1.4.4', 'Text can be resized / zoomed to 200%', ['a11y.zoom'], 'medium'],
		['1.4.10', 'Content reflows at 320 CSS px', ['a11y.reflow'], 'medium'],
		['2.4.2', 'Pages have descriptive titles', ['a11y.page_title'], 'low'],
		['2.5.8', 'Target size is at least 24×24 px', ['a11y.touch_targets'], 'low'],
		['3.1.1', 'The page language is declared', ['a11y.lang'], 'medium'],
		['4.1.2', 'Controls expose a name and role', ['a11y.control_names'], 'high']
	],
	owasp: [
		['A02 Cryptographic failures', 'All traffic is encrypted (HTTPS, HSTS)', ['sec.https', 'sec.hsts', 'sec.password_transport'], 'high'],
		['A05 Security misconfiguration', 'Security headers are set (CSP, framing, nosniff)', ['sec.csp', 'sec.clickjacking', 'sec.nosniff'], 'medium'],
		['A05 Security misconfiguration', 'No sensitive files are exposed', ['sec.exposed_files'], 'critical'],
		['A06 Vulnerable components', 'Client libraries have no known vulnerabilities', ['sec.vulnerable_libraries'], 'high'],
		['A07 Identification and authentication', 'Session cookies are protected', ['sec.cookie_flags'], 'medium'],
		['A03 Injection', 'Inputs are not reflected unsafely', ['sec.injection'], 'high'],
		['A02 / A05', 'No secrets are exposed in client code', ['sec.client_secrets'], 'critical']
	],
	privacy: [
		['Transparency / notice', 'A privacy notice is published and linked', ['privacy.policy_link'], 'high'],
		['Notice at collection', 'Forms collecting personal data reference the privacy notice', ['privacy.form_notice'], 'medium'],
		['Consent for cookies', 'Non-essential cookies are not set before consent', ['privacy.tracking_before_consent'], 'high'],
		['Consent for cookies', 'Consent can be refused as easily as given', ['privacy.cookie_banner', 'privacy.cookie_reject'], 'medium'],
		['Grievance / contact', 'A contact or grievance channel is published', ['privacy.contact_info'], 'medium']
	],
	children: [
		['Parental consent', 'Child-directed features carry an age / parental-consent notice', ['privacy.children_notice', 'privacy.policy_link'], 'high']
	],
	statement: [
		['Accessibility statement', 'An accessibility statement or contact for accessibility issues is published', ['privacy.accessibility_statement'], 'low']
	]
};

/**
 * Baseline frameworks for a product profile, used only when online research is
 * unavailable. Every one is marked `baseline: true` in the report.
 */
export function baselineFrameworks(product = {}) {
	const regions = (product.regions ?? []).map(region => String(region).toLowerCase());
	const has = pattern => regions.some(region => pattern.test(region));
	const picks = [['wcag', 'Accessibility applies to every public website.'], ['owasp', 'Security baseline for any web application.']];
	if (has(/\b(eu|europe|uk|germany|france|spain|italy|netherlands|ireland|gdpr)\b/) || !regions.length) picks.push(['gdpr', regions.length ? 'The product targets users in Europe.' : 'No region was identified; GDPR is used as the reference privacy regime.']);
	if (has(/\b(india|in)\b/)) picks.push(['dpdp', 'The product targets users in India.']);
	if (has(/\b(us|usa|united states|america|california)\b/)) picks.push(['ccpa', 'The product targets users in the United States.']);
	if (product.audience?.children || product.category === 'education' && product.audience?.minors !== false) picks.push(['coppa', 'The product may be used by children.']);
	if (product.category === 'education' && has(/\b(us|usa|united states|america)\b/)) picks.push(['ferpa', 'US education product handling student records.'], ['ada', 'US education services must be accessible.']);
	if (product.category === 'healthcare' && has(/\b(us|usa|united states|america)\b/)) picks.push(['hipaa', 'US health data.']);
	if (product.dataHandled?.includes?.('payments') || ['finance', 'ecommerce'].includes(product.category)) picks.push(['pci', 'The product takes card payments.']);
	if (product.category === 'ai' || product.features?.includes?.('ai')) picks.push(['euaiact', 'The product offers AI features to users.']);
	return picks.map(([id, why]) => ({ id: `F-${id}`, ...BASE[id], applicability: why, mandatory: !['owasp', 'wcag'].includes(id) || id === 'wcag' && ['education', 'government'].includes(product.category), baseline: true }));
}

/** Baseline requirements for baseline frameworks (each tied to measured evidence). */
export function baselineRequirements(frameworks) {
	const out = [];
	for (const framework of frameworks) {
		const key = framework.id.replace(/^F-/, '');
		const sets = key === 'wcag' || key === 'ada' ? [...BASE_REQUIREMENTS.wcag, ...BASE_REQUIREMENTS.statement]
			: key === 'owasp' || key === 'pci' ? BASE_REQUIREMENTS.owasp
				: key === 'coppa' ? BASE_REQUIREMENTS.children
					: ['gdpr', 'dpdp', 'ccpa', 'ferpa', 'hipaa'].includes(key) ? BASE_REQUIREMENTS.privacy : [];
		for (const [clause, title, kinds, severity] of sets) {
			out.push({ frameworkId: framework.id, clause, title, check: `Measured: ${kinds.map(kind => EVIDENCE_KINDS[kind]).join('; ')}.`, method: 'automated', evidenceKinds: kinds, severity });
		}
	}
	return out;
}

/** Requirements for a researched framework the agent did not break down (by kind/name). */
export function fallbackRequirementsFor(framework) {
	const name = `${framework.name} ${framework.kind}`.toLowerCase();
	const key = /coppa|child|kids|minor/.test(name) ? 'coppa'
		: /pci|payment card/.test(name) ? 'pci'
			: framework.kind === 'accessibility' || /wcag|accessib|ada\b|section 508|en 301 549|rpwd|gigw/.test(name) ? 'wcag'
				: framework.kind === 'security' || /owasp|security|iso 27001|soc 2|cert-in/.test(name) ? 'owasp'
					: framework.kind === 'privacy' || /gdpr|privacy|data protection|dpdp|ccpa|ferpa|hipaa|pdpa|lgpd|pipeda/.test(name) ? 'gdpr' : undefined;
	if (!key) return [];
	return baselineRequirements([{ ...framework, id: `F-${key}` }]).map(item => ({ ...item, frameworkId: framework.id }));
}

/** Fix guidance for failed measured evidence. */
export const EVIDENCE_FIX = {
	'a11y.images_alt': 'Add meaningful alt text to informative images and alt="" to decorative ones.',
	'a11y.form_labels': 'Give every field a visible <label for> (or aria-labelledby); placeholders are not labels.',
	'a11y.contrast': 'Darken text or lighten backgrounds to reach 4.5:1 (3:1 for large text).',
	'a11y.control_names': 'Give icon-only buttons and links an accessible name (visible text or aria-label).',
	'a11y.lang': 'Declare the page language, e.g. <html lang="en">.',
	'a11y.zoom': 'Remove user-scalable=no and maximum-scale=1 from the viewport meta tag.',
	'a11y.touch_targets': 'Make interactive targets at least 24×24 px (44×44 px recommended).',
	'a11y.headings': 'Give every page one descriptive <h1> and a logical heading structure.',
	'a11y.page_title': 'Give every page a unique, descriptive <title>.',
	'a11y.reflow': 'Make the layout reflow at 320 CSS px: flexible widths, wrapping text, no fixed-width containers.',
	'sec.https': 'Serve every page over HTTPS and redirect HTTP to HTTPS.',
	'sec.hsts': 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains.',
	'sec.csp': 'Add a Content-Security-Policy that restricts script sources (no unsafe-inline/unsafe-eval).',
	'sec.clickjacking': 'Send Content-Security-Policy: frame-ancestors \'self\' (or X-Frame-Options: DENY).',
	'sec.nosniff': 'Send X-Content-Type-Options: nosniff.',
	'sec.cookie_flags': 'Mark session cookies Secure, HttpOnly and SameSite=Lax or Strict.',
	'sec.exposed_files': 'Block public access to .env, .git and backup files and rotate any exposed secrets.',
	'sec.vulnerable_libraries': 'Upgrade the vulnerable client libraries to a patched version.',
	'sec.client_secrets': 'Remove secrets from client code, rotate them, and call the service from the server.',
	'sec.password_transport': 'Only submit credentials to HTTPS endpoints.',
	'sec.injection': 'Encode output for its context and use parameterised queries; validate redirect targets against an allowlist.',
	'privacy.policy_link': 'Publish a privacy notice (what data, why, legal basis, retention, rights, contact) and link it from every page footer.',
	'privacy.terms_link': 'Publish terms of service and link them from the footer and sign-up.',
	'privacy.cookie_banner': 'Show a consent notice before setting non-essential cookies.',
	'privacy.cookie_reject': 'Offer "Reject all" with the same prominence as "Accept all".',
	'privacy.tracking_before_consent': 'Load analytics and advertising tags only after the visitor opts in (consent mode / tag manager consent triggers).',
	'privacy.contact_info': 'Publish a contact or grievance channel (e-mail, form or named officer) for privacy and support requests.',
	'privacy.accessibility_statement': 'Publish an accessibility statement with the conformance target and a way to report barriers.',
	'privacy.children_notice': 'Add a children’s privacy section: age limits, verifiable parental consent, and how parents can review or delete data.',
	'privacy.form_notice': 'Show a short privacy notice with a link next to forms that collect personal data.'
};
