/**
 * AI exploration: the reasoning model drives the browser through a small,
 * safe tool set to test real user flows and report functional problems that
 * rule-based detectors cannot judge (wrong results, broken flows, confusing
 * states, logic errors).
 *
 * Safety: navigation is limited to the target scope by the browser layer,
 * writes are blocked during interaction, and controls with destructive labels
 * are refused here. Bounded by steps and time; a model failure ends only this
 * phase, never the run.
 */
import { candidate } from './findings.js';

const DESTRUCTIVE = /\b(delete|remove|destroy|erase|log ?out|sign ?out|unsubscribe|deactivate|pay|purchase|buy now|checkout|place order|transfer|close account)\b/i;

const TOOLS = [
	{ name: 'click', description: 'Click an element by its ref from the latest observation.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } },
	{ name: 'type', description: 'Type text into a field (replaces its value). Set submit=true to press Enter afterwards. Submissions are blocked from reaching the server; you will see whether the page tried to submit and how it reacted.', parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] } },
	{ name: 'select', description: 'Choose an option in a <select> by its visible label.', parameters: { type: 'object', properties: { ref: { type: 'string' }, option: { type: 'string' } }, required: ['ref', 'option'] } },
	{ name: 'press', description: 'Press a keyboard key (Tab, Enter, Escape, ArrowDown…).', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
	{ name: 'navigate', description: 'Open a URL on the site under test.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
	{ name: 'scroll', description: 'Scroll the page.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] } }, required: ['direction'] } },
	{ name: 'back', description: 'Go back in history.', parameters: { type: 'object', properties: {} } },
	{ name: 'look', description: 'Take a screenshot of the current viewport to inspect the visual state.', parameters: { type: 'object', properties: {} } },
	{ name: 'report_issue', description: 'Report one confirmed defect you observed. Only report what you saw happen, with exact steps.', parameters: { type: 'object', properties: {
		title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
		category: { type: 'string', enum: ['functional', 'navigation', 'forms', 'layout', 'visual', 'animation', 'responsive', 'accessibility', 'content', 'security', 'performance'] },
		steps: { type: 'array', items: { type: 'string' } }, expected: { type: 'string' }, actual: { type: 'string' }, evidence: { type: 'string' }
	}, required: ['title', 'severity', 'category', 'steps', 'expected', 'actual'] } },
	{ name: 'finish', description: 'Stop exploring and summarize what you tested.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } }
].map(tool => ({ type: 'function', function: tool }));

const SYSTEM = `You are QASE, a senior QA engineer testing a live website in a real browser.
Goal: find REAL defects a user would hit — broken flows, wrong results, dead ends, error states, confusing or inconsistent behaviour, missing feedback, broken search/filter/sort, pagination, cart or counters that do not update, wrong totals, links to wrong places, UI that breaks after an interaction, visual glitches after state changes.
Automated detectors already cover static layout, contrast, headers, console errors and simple toggles; focus on behaviour and user journeys.
Rules:
- Work like a tester: pick a realistic journey, execute it step by step, check every result against what a user would expect.
- Try edge cases: empty input, very long input, special characters (e.g. Ünïcödé, 😀, <b>x</b>), zero/negative numbers, rapid repeated clicks, back/forward navigation, reload mid-flow.
- Submissions are blocked by the test harness so no data is written. A blocked submission is NOT a defect; judge only the page's own behaviour (validation, feedback, state).
- Never try to sign in with guessed credentials, attack the site, or perform destructive actions.
- Report each defect once with report_issue, with exact reproducible steps. Do not report things you did not observe. Do not report missing features or style opinions.
- Use look when visual state matters. Be efficient; finish when you have covered the main journeys.`;

/** Tags interactive elements and returns a compact observation. */
async function observe(page, log) {
	const snapshot = await page.evaluate(() => {
		let ref = 0;
		const items = [];
		for (const element of document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],summary,[contenteditable=true]')) {
			const r = element.getBoundingClientRect();
			const s = getComputedStyle(element);
			if (r.width < 2 || r.height < 2 || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) continue;
			if (items.length >= 120) break;
			const id = `e${ref++}`;
			element.setAttribute('data-qase-ref', id);
			const name = String(element.getAttribute('aria-label') || element.innerText || element.value || element.placeholder || element.title || element.alt || '').replace(/\s+/g, ' ').trim().slice(0, 70);
			const inView = r.bottom > 0 && r.top < innerHeight;
			items.push(`${id} ${element.tagName.toLowerCase()}${element.type && element.tagName === 'INPUT' ? `[${element.type}]` : ''}${element.getAttribute('role') ? `(${element.getAttribute('role')})` : ''} "${name}"${element.tagName === 'A' ? ` → ${element.getAttribute('href')?.slice(0, 80)}` : ''}${element.disabled ? ' [disabled]' : ''}${element.getAttribute('aria-expanded') ? ` [expanded=${element.getAttribute('aria-expanded')}]` : ''}${element.checked ? ' [checked]' : ''}${'value' in element && element.value && element.tagName !== 'BUTTON' ? ` value="${String(element.value).slice(0, 40)}"` : ''}${inView ? '' : ' (off-screen)'}`);
		}
		const text = (document.body?.innerText ?? '').replace(/\n{2,}/g, '\n').slice(0, 2500);
		return { url: location.href, title: document.title, items, text, scroll: `${Math.round(scrollY)}/${document.documentElement.scrollHeight - innerHeight}` };
	}).catch(() => ({ url: page.url(), title: '', items: [], text: '(page could not be read)' }));
	const errors = [...(log.pageErrors ?? []).slice(-3).map(error => `JS error: ${error.message}`), ...(log.console ?? []).filter(item => item.type === 'error').slice(-3).map(item => `console: ${item.text}`)];
	return `URL: ${snapshot.url}\nTitle: ${snapshot.title}\nScroll: ${snapshot.scroll}\n${errors.length ? `Recent errors:\n${errors.join('\n')}\n` : ''}Interactive elements:\n${snapshot.items.join('\n')}\n\nVisible text:\n${snapshot.text}`;
}

export async function explore({ browser, profile, startUrl, models, knownIssues = [], maxSteps = 30, deadline, signal, blockedWrites, save, onStep = () => {}, focus }) {
	const out = [];
	const summary = { steps: 0, finished: false, summary: '', visited: new Set() };
	if (!models.reasonerAvailable()) return { candidates: out, summary: { ...summary, skipped: 'reasoner unavailable' } };
	const { page, log } = await browser.openPage(profile);
	browser.setActivePage(page);
	const trail = [];
	try {
		await browser.goto(page, startUrl, log).catch(() => {});
		const messages = [
			{ role: 'system', content: SYSTEM },
			{ role: 'user', content: `Site under test: ${startUrl}\nViewport: ${profile.label}\n${focus ? `Owner's focus: ${focus}\n` : ''}Already reported by automated checks (do not repeat): ${knownIssues.slice(0, 40).join('; ') || 'none'}\n\nCurrent page:\n${await observe(page, log)}` }
		];
		while (summary.steps < maxSteps && Date.now() < deadline && models.reasonerAvailable()) {
			signal?.throwIfAborted();
			// Keep the context small: older observations are trimmed.
			for (let i = 2; i < messages.length - 8; i++) {
				if (messages[i].role === 'tool' && messages[i].content.length > 300) messages[i] = { ...messages[i], content: `${messages[i].content.slice(0, 200)}\n[older observation trimmed]` };
				if (messages[i].role === 'user' && Array.isArray(messages[i].content)) messages[i] = { role: 'user', content: '[older screenshot trimmed]' };
			}
			const reply = await models.chat(messages, { tools: TOOLS, maxTokens: 2048, signal, purpose: 'exploration' });
			if (!reply) break;
			messages.push({ role: 'assistant', content: reply.text || null, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}) });
			if (!reply.toolCalls.length) {
				messages.push({ role: 'user', content: 'Continue testing with a tool call, or call finish.' });
				summary.steps++;
				continue;
			}
			let screenshot;
			for (const call of reply.toolCalls) {
				summary.steps++;
				let args = {};
				try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* invalid arguments become an error result */ }
				const name = call.function?.name;
				let result;
				try {
					result = await runTool(name, args);
				} catch (error) {
					result = `Error: ${String(error.message).split('\n')[0].slice(0, 200)}`;
				}
				if (result?.image) { screenshot = result.image; result = 'Screenshot attached below.'; }
				messages.push({ role: 'tool', tool_call_id: call.id, content: String(result).slice(0, 6000) });
				onStep({ name, args, url: page.url() });
				if (name === 'finish') { summary.finished = true; summary.summary = String(args.summary ?? '').slice(0, 2000); break; }
			}
			if (summary.finished) break;
			if (screenshot) messages.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot of the current viewport:' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot.toString('base64')}` } }] });
		}
	} finally {
		await page.close().catch(() => {});
	}
	return { candidates: out, summary: { ...summary, visited: [...summary.visited] } };

	async function runTool(name, args) {
		const locate = ref => page.locator(`[data-qase-ref="${String(ref).replace(/"/g, '')}"]`).first();
		const describeRef = async ref => (await locate(ref).evaluate(element => (element.getAttribute('aria-label') || element.innerText || element.value || element.placeholder || '').trim().slice(0, 60)).catch(() => '')) || ref;
		const blockedBefore = blockedWrites();
		const after = async () => {
			await browser.settle(page, { quietMs: 1200 });
			summary.visited.add(page.url().split('#')[0]);
			const blocked = blockedWrites() - blockedBefore;
			return `${blocked ? `(The page attempted ${blocked} write request${blocked > 1 ? 's' : ''}; QASE blocked ${blocked > 1 ? 'them' : 'it'}.)\n` : ''}${await observe(page, log)}`;
		};
		switch (name) {
			case 'click': {
				const label = await describeRef(args.ref);
				if (DESTRUCTIVE.test(label)) return `Refused: "${label}" looks destructive. Choose another action.`;
				trail.push(`Click "${label}"`);
				await browser.interact(() => locate(args.ref).click({ timeout: 5000 }));
				return after();
			}
			case 'type': {
				const label = await describeRef(args.ref);
				trail.push(`Type "${String(args.text).slice(0, 60)}" into "${label}"${args.submit ? ' and press Enter' : ''}`);
				await browser.interact(async () => {
					await locate(args.ref).fill(String(args.text ?? '').slice(0, 2000), { timeout: 5000 });
					if (args.submit) await locate(args.ref).press('Enter');
				});
				return after();
			}
			case 'select': {
				trail.push(`Select "${args.option}" in "${await describeRef(args.ref)}"`);
				await browser.interact(() => locate(args.ref).selectOption({ label: String(args.option) }, { timeout: 5000 }));
				return after();
			}
			case 'press':
				trail.push(`Press ${args.key}`);
				await browser.interact(() => page.keyboard.press(String(args.key).slice(0, 30)));
				return after();
			case 'navigate': {
				const url = new URL(String(args.url), page.url()).href;
				if (!browser.inScope(url)) return 'Refused: that URL is outside the site under test.';
				trail.push(`Open ${url}`);
				await browser.goto(page, url, log);
				return after();
			}
			case 'scroll':
				await page.evaluate(direction => {
					if (direction === 'top') scrollTo(0, 0);
					else if (direction === 'bottom') scrollTo(0, document.documentElement.scrollHeight);
					else scrollBy(0, (direction === 'up' ? -1 : 1) * innerHeight * 0.8);
				}, args.direction);
				return after();
			case 'back':
				trail.push('Go back');
				await page.goBack({ timeout: 15000 }).catch(() => {});
				return after();
			case 'look':
				if (!models.visionAvailable()) return 'Screenshots are not available for this model; rely on the observation text.';
				return { image: await page.screenshot({ type: 'jpeg', quality: 60 }) };
			case 'report_issue': {
				if (!args.title || !args.actual) return 'Rejected: title and actual are required.';
				const bytes = await page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
				out.push(candidate({ source: 'explorer', detector: 'agent.exploration', category: args.category, severity: args.severity, confidence: 0.65,
					title: args.title, url: page.url(), viewport: profile.name, expected: args.expected, actual: args.actual, evidence: args.evidence,
					steps: Array.isArray(args.steps) && args.steps.length ? args.steps : trail.slice(-8),
					artifactId: bytes ? await save(bytes, `Explorer: ${args.title}`) : undefined, data: { key: args.title, trail: trail.slice(-12) } }));
				return `Recorded issue ${out.length}. Continue testing.`;
			}
			case 'finish':
				return 'Finished.';
			default:
				return `Unknown tool ${name}.`;
		}
	}
}
