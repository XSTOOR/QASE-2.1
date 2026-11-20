/**
 * Founder review: the business lenses a product is judged on, the signals the
 * host measures for each, and the advice used when no reasoning model is
 * available. Lens weights reflect how strongly each area decides whether a
 * visitor becomes a user and stays: first impression, conversion and
 * activation weigh most.
 */
export { PRODUCT_CATEGORIES } from '../sqa/catalog.js';

export const LENSES = [
	{ id: 'value_prop', name: 'First impression & value proposition', weight: 14, question: 'Within 5 seconds, does a first-time visitor understand what this is, who it is for and why it beats the alternative?' },
	{ id: 'trust', name: 'Trust & credibility', weight: 10, question: 'Would a stranger trust this product with their time, data and money?' },
	{ id: 'onboarding', name: 'Onboarding & activation', weight: 13, question: 'How quickly and easily does a new user reach the first moment of value?' },
	{ id: 'conversion', name: 'Conversion & pricing', weight: 13, question: 'Is the path from interest to sign-up or purchase clear, low-friction and well priced?' },
	{ id: 'experience', name: 'Product experience & polish', weight: 12, question: 'Does the product feel finished, consistent and pleasant to use?' },
	{ id: 'mobile', name: 'Mobile experience', weight: 9, question: 'Does it work as well on a phone as on a laptop?' },
	{ id: 'performance', name: 'Speed & reliability', weight: 9, question: 'Is it fast and free of errors, broken links and dead ends?' },
	{ id: 'discoverability', name: 'Discoverability (SEO & sharing)', weight: 6, question: 'Will search engines and shared links present it well?' },
	{ id: 'retention', name: 'Engagement & retention', weight: 7, question: 'Does it give users reasons to come back and bring others?' },
	{ id: 'positioning', name: 'Competitive positioning', weight: 7, question: 'Is it clearly differentiated from the alternatives users already know?' }
];
export const LENS_IDS = LENSES.map(lens => lens.id);
export const lensName = id => LENSES.find(lens => lens.id === id)?.name ?? id;

/**
 * Measured signals: kind -> lens, title and the advice used when the host has
 * to write recommendations itself. Status per signal: good | weak | missing |
 * unknown | not_applicable.
 */
export const SIGNAL_KINDS = {
	'value.headline': { lens: 'value_prop', title: 'Clear headline above the fold', fix: 'Rewrite the hero headline to say what the product does and for whom in under 12 words (for example "<outcome> for <audience>"), with a one-line sub-headline that names the key benefit.' },
	'value.cta_above_fold': { lens: 'value_prop', title: 'Primary call to action visible without scrolling', fix: 'Put one prominent primary button ("Start free", "Book a demo"…) in the first screen on desktop and on mobile, and repeat it after each major section.' },
	'value.cta_focus': { lens: 'conversion', title: 'One clear primary action', fix: 'Reduce the first screen to one primary action and at most one secondary action; competing buttons split attention and lower conversion.' },
	'trust.social_proof': { lens: 'trust', title: 'Social proof (testimonials, reviews, logos, numbers)', fix: 'Add social proof near the top: 2–3 short testimonials with names and photos, customer logos, ratings or a usage number. Real, attributable proof only.' },
	'trust.company': { lens: 'trust', title: 'Who is behind the product (about, team, contact)', fix: 'Add an About page and a visible contact channel (email, chat or form) so visitors can see a real team behind the product.' },
	'trust.legal': { lens: 'trust', title: 'Privacy policy and terms linked', fix: 'Link a privacy policy and terms of service from the footer of every page; they are table stakes for trust and for payment providers.' },
	'trust.https': { lens: 'trust', title: 'Secure connection (HTTPS)', fix: 'Serve every page over HTTPS and redirect HTTP to HTTPS; browsers flag insecure pages and visitors leave.' },
	'conversion.pricing': { lens: 'conversion', title: 'Pricing is easy to find and understand', fix: 'Publish a pricing page linked from the main navigation with clear plans, prices and what is included; hidden pricing makes visitors assume it is expensive.' },
	'conversion.free_start': { lens: 'conversion', title: 'Low-risk way to start (free plan, trial or demo)', fix: 'Offer a low-risk start: a free plan, a free trial without a credit card, or a demo, and say so on the first screen.' },
	'onboarding.signup_friction': { lens: 'onboarding', title: 'Short sign-up', fix: 'Cut the sign-up form to the minimum (email and password, or one-click Google/Apple sign-in) and ask for everything else after the user has seen value.' },
	'onboarding.signup_found': { lens: 'onboarding', title: 'Sign-up or start path is reachable', fix: 'Make the sign-up or "get started" path reachable from every page in one click.' },
	'experience.visual_issues': { lens: 'experience', title: 'No visual defects (overlaps, broken images, hidden content)', fix: 'Fix the visual defects found (overlapping elements, broken images, invisible content); they make the product look unfinished.' },
	'experience.readability': { lens: 'experience', title: 'Readable text and accessible basics', fix: 'Raise text contrast, label form fields and add image alt text; readable products convert better and reach more people.' },
	'mobile.layout': { lens: 'mobile', title: 'Fits a phone screen without sideways scrolling', fix: 'Fix the mobile layout so nothing overflows the screen width and tap targets are at least 44×44 px.' },
	'mobile.cta': { lens: 'mobile', title: 'Primary action visible on the first mobile screen', fix: 'Show the primary call to action within the first mobile screen.' },
	'performance.speed': { lens: 'performance', title: 'Fast first load', fix: 'Bring the main content under 2.5 s: compress and lazy-load images, cut render-blocking scripts and use a CDN.' },
	'performance.errors': { lens: 'performance', title: 'No JavaScript errors or failed requests', fix: 'Fix the JavaScript errors and failed requests on the key pages; they often break buttons and forms silently.' },
	'performance.broken_links': { lens: 'performance', title: 'No broken links', fix: 'Fix or remove broken links; each dead end loses a visitor and hurts search ranking.' },
	'discoverability.meta': { lens: 'discoverability', title: 'Search title and description', fix: 'Give every key page a unique title (50–60 characters) and meta description (120–160 characters) that state the value proposition.' },
	'discoverability.sharing': { lens: 'discoverability', title: 'Share preview (Open Graph image and title)', fix: 'Add Open Graph and Twitter card tags (title, description, 1200×630 image) so shared links look professional.' },
	'retention.hooks': { lens: 'retention', title: 'Reasons to stay in touch (newsletter, content, community, app)', fix: 'Give visitors a reason to come back: a newsletter or updates sign-up, useful content (blog, guides), a community or mobile apps.' }
};
export const SIGNAL_KIND_IDS = Object.keys(SIGNAL_KINDS);

/** Score a lens from measured signals when no reasoning model is available (0–10). */
export function heuristicLensScore(lens, signals) {
	const relevant = signals.filter(signal => SIGNAL_KINDS[signal.kind]?.lens === lens && ['good', 'weak', 'missing'].includes(signal.status));
	if (!relevant.length) return undefined;
	const points = relevant.reduce((sum, signal) => sum + (signal.status === 'good' ? 10 : signal.status === 'weak' ? 5 : 1), 0);
	return Math.round(points / relevant.length);
}

export const VERDICTS = [
	{ id: 'ready', min: 80, label: 'Ready to grow', line: 'The product makes a strong case to new users. Focus on the growth levers below.' },
	{ id: 'polish', min: 60, label: 'Needs polish', line: 'The core is there, but several gaps will cost sign-ups. Fix the "now" items before spending on acquisition.' },
	{ id: 'not_ready', min: 40, label: 'Not ready to scale', line: 'Important basics are missing. Visitors are likely to leave before they understand or trust the product.' },
	{ id: 'major_gaps', min: 0, label: 'Major gaps', line: 'The product does not yet explain itself, earn trust or convert. Start with the top priorities.' }
];
export const verdictFor = score => score === null || score === undefined ? { id: 'not_assessed', label: 'Not assessed', line: 'Nothing could be assessed.' } : VERDICTS.find(item => score >= item.min);
