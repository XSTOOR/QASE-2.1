/**
 * Visual review: the reasoning model inspects screenshots (and animation
 * filmstrips captured during interactions) for defects a human tester would
 * notice at a glance — overlapping or misaligned elements, cut-off text,
 * broken images, unreadable areas, inconsistent spacing, elements that jump
 * or end in a wrong state during an animation.
 */
import { candidate } from './findings.js';

const PROMPT = `You are reviewing screenshots of a website for VISUAL DEFECTS that a user would notice.
Report only clear, concrete defects you can see, for example:
- elements overlapping each other, text colliding, content hidden behind other elements
- text cut off, truncated mid-word, or overflowing its container/button
- broken or missing images, empty placeholders, icons that failed to load
- layout broken at this viewport: misaligned columns, elements off-screen, horizontal overflow, huge gaps
- unreadable text (very low contrast, text over busy images)
- for animation filmstrips (frames in time order): elements flying in from the wrong place, flicker, content jumping, a menu/panel that appears behind content, ends half-transparent or misplaced
Do NOT report design preferences, missing features, or anything you are unsure about.
Answer with JSON only: {"issues":[{"title":"…","severity":"high|medium|low","category":"layout|visual|animation|responsive|content|accessibility","location":"where on screen / which element","actual":"what is wrong","expected":"what it should look like","confidence":0.0-1.0}]}. Use {"issues":[]} when nothing is clearly wrong.`;

const image = bytes => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } });

/**
 * shots: [{ url, viewport, label, bytes }]; filmstrips: [{ url, label, frames: [bytes] }]
 */
export async function reviewVisuals({ models, shots, filmstrips, save, signal, deadline, maxCalls = 10, known = [] }) {
	const out = [];
	let calls = 0;
	const ask = async (content, context) => {
		if (calls >= maxCalls || Date.now() >= deadline || !models.visionAvailable()) return;
		calls++;
		const result = await models.json([
			{ role: 'system', content: PROMPT },
			{ role: 'user', content: [{ type: 'text', text: `${context}\nAlready known from automated checks (do not repeat): ${known.slice(0, 25).join('; ') || 'none'}` }, ...content] }
		], { maxTokens: 1500, signal, purpose: 'visual review' });
		return Array.isArray(result?.issues) ? result.issues.slice(0, 6) : [];
	};
	for (const shot of shots) {
		const issues = await ask([image(shot.bytes)], `Page: ${shot.url}\nViewport: ${shot.viewport}`);
		if (!issues) break;
		let artifactId;
		for (const issue of issues) {
			if (!issue?.title || !issue?.actual || Number(issue.confidence) < 0.5) continue;
			artifactId ??= await save(shot.bytes, `${shot.viewport}: ${shot.url}`);
			out.push(candidate({ source: 'visual', detector: 'visual.review', category: issue.category, severity: issue.severity === 'high' ? 'high' : issue.severity === 'low' ? 'low' : 'medium',
				confidence: Math.min(0.75, Number(issue.confidence) || 0.6), title: issue.title, url: shot.url, viewport: shot.viewport,
				actual: `${issue.actual}${issue.location ? ` (location: ${issue.location})` : ''}`, expected: issue.expected,
				steps: [`Open ${shot.url} at the ${shot.viewport} viewport`, issue.location ? `Look at ${issue.location}` : 'Look at the page'],
				fix: 'Inspect the highlighted area in the screenshot, find the CSS rule or component causing it, and verify the fix at every breakpoint.', artifactId, data: { key: issue.title } }));
		}
	}
	for (const strip of filmstrips) {
		if (strip.frames.length < 2) continue;
		const issues = await ask(strip.frames.map(image), `Animation filmstrip, ${strip.frames.length} frames ~100–450 ms after clicking: ${strip.label}\nPage: ${strip.url}`);
		if (!issues) break;
		let artifactId;
		for (const issue of issues) {
			if (!issue?.title || !issue?.actual || Number(issue.confidence) < 0.55) continue;
			artifactId ??= await save(strip.frames.at(-1), `Animation: ${strip.label}`);
			out.push(candidate({ source: 'visual', detector: 'visual.animation', category: 'animation', severity: issue.severity === 'high' ? 'high' : issue.severity === 'low' ? 'low' : 'medium',
				confidence: Math.min(0.75, Number(issue.confidence) || 0.6), title: issue.title, url: strip.url, viewport: strip.label.split(' · ')[0],
				actual: issue.actual, expected: issue.expected, steps: [`Open ${strip.url}`, `Trigger: ${strip.label.split(' · ').slice(1).join(' · ')}`, 'Watch the animation'],
				fix: 'Review the transition/keyframes for this component: start and end states, transform origin, z-index during the animation and the final state classes.', artifactId, data: { key: issue.title } }));
		}
	}
	return { candidates: out, calls };
}
