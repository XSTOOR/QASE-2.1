/**
 * AI exploration: the reasoner proposes steps and JEV selects browser actions from a small,
 * safe tool set to test real user flows and report functional problems that
 * rule-based detectors cannot judge (wrong results, broken flows, confusing
 * states, logic errors).
 *
 * Safety: navigation is limited to the target scope by the browser layer,
 * writes are blocked during interaction, and controls with destructive labels
 * are refused here. Bounded by steps and time; a model failure ends only this
 * phase, never the run.
 */
import { isJourneyAction, selectJourneyAction } from './journeyAction.js';
import { UNTRUSTED_CONTENT_RULE } from '../untrustedContent.js';
import { candidate } from './findings.js';
import { formOutcomeObserver } from './formOutcome.js';
import { dismissOverlays, openOverlays } from './overlays.js';
import { screenSignature, appeared, toggled } from './uiCrawl.js';

const ACTIONS = new Set(['click', 'type', 'select', 'press', 'navigate', 'back', 'scroll']);
const DESTRUCTIVE = /\b(delete|remove|destroy|erase|log ?out|sign ?out|unsubscribe|deactivate|pay|purchase|buy now|checkout|place order|transfer|close account)\b/i;

const TOOLS = [
	{ name: 'click', description: 'Press an element by its ref from the latest observation or screenshot marks (a tap on touch devices).', parameters: { type: 'object', properties: { ref: { type: 'string' }, expect: { type: 'string', description: 'What you expect to happen, in one short sentence. QASE shows it next to the RESULT so you can check it.' } }, required: ['ref', 'expect'] } },
	{ name: 'type', description: 'Type text into a field (replaces its value). Set submit=true to press Enter afterwards. Follow the write permission for this journey.', parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' }, expect: { type: 'string', description: 'What you expect to happen, in one short sentence. QASE shows it next to the RESULT so you can check it.' } }, required: ['ref', 'text', 'expect'] } },
	{ name: 'select', description: 'Choose an option in a <select> by its visible label.', parameters: { type: 'object', properties: { ref: { type: 'string' }, option: { type: 'string' }, expect: { type: 'string', description: 'What you expect to happen, in one short sentence. QASE shows it next to the RESULT so you can check it.' } }, required: ['ref', 'option'] } },
	{ name: 'press', description: 'Press a keyboard key (Tab, Enter, Escape, ArrowDown…).', parameters: { type: 'object', properties: { key: { type: 'string' }, expect: { type: 'string', description: 'What you expect to happen, in one short sentence. QASE shows it next to the RESULT so you can check it.' } }, required: ['key'] } },
	{ name: 'navigate', description: 'Open a URL on the site under test.', parameters: { type: 'object', properties: { url: { type: 'string' }, expect: { type: 'string', description: 'What you expect to happen, in one short sentence. QASE shows it next to the RESULT so you can check it.' } }, required: ['url'] } },
	{ name: 'scroll', description: 'Scroll the page.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] } }, required: ['direction'] } },
	{ name: 'back', description: 'Go back in history.', parameters: { type: 'object', properties: {} } },
	{ name: 'look', description: 'Take a fresh screenshot of the viewport (with control marks). A screenshot already arrives after every action, so use this only when the page may have changed by itself (loading, animation, timers).', parameters: { type: 'object', properties: {} } },
	{ name: 'report_issue', description: 'Report one confirmed defect you observed. Only report what you saw happen, with exact steps.', parameters: { type: 'object', properties: {
		title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
		category: { type: 'string', enum: ['functional', 'navigation', 'forms', 'layout', 'visual', 'animation', 'dom', 'responsive', 'accessibility', 'content', 'security', 'performance'] },
		steps: { type: 'array', items: { type: 'string' } }, expected: { type: 'string' }, actual: { type: 'string' }, evidence: { type: 'string' }
	}, required: ['title', 'severity', 'category', 'steps', 'expected', 'actual'] } },
	{ name: 'finish', description: 'Stop exploring and summarize what you tested.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } }
].map(tool => ({ type: 'function', function: tool }));

const systemPrompt = saveTarget => `You are QASE, a senior QA engineer testing a live website in a real browser.
Goal: find REAL defects a user would hit — broken flows, wrong results, dead ends, error states, confusing or inconsistent behaviour, missing feedback, broken search/filter/sort, pagination, cart or counters that do not update, wrong totals, links to wrong places, UI that breaks after an interaction, visual glitches after state changes.
Automated detectors already cover static layout, contrast, headers, console errors and simple toggles; focus on behaviour and user journeys.
Rules:
- Work like a tester: pick a realistic journey, execute it step by step, check every result against what a user would expect.
- Try edge cases: empty input, very long input, special characters (e.g. Ünïcödé, 😀, <b>x</b>), zero/negative numbers, rapid repeated clicks, back/forward navigation, reload mid-flow.
- ${saveTarget ? `The owner authorized one synthetic record in the planned record creation form. First submit it empty, correct the required input with a clearly marked QASE test value, then submit once and inspect the receipt. Do not repeat a write with an uncertain outcome. Do not change accounts, send messages, buy items or modify existing records.` : "This journey is read-only. Do not perform writes."} Navigations to other websites (Sign in with Google/GitHub, SSO, payment providers) are blocked too. A blocked request is NOT a defect, and neither is what the page shows because of it: "Failed to fetch", a generic network error, a spinner that never ends, a button stuck in a loading state. After a blocked request, judge only independent behaviour: client-side validation, labels, feedback before submitting, layout, navigation within the site.
- When a tool result says a request was blocked, do not report the page's reaction to it.
- Never try to sign in with guessed credentials, attack the site, or perform destructive actions. If you are signed in, stay signed in (do not click sign out).
- Report each defect once with report_issue, with exact reproducible steps. Do not report things you did not observe. Do not report missing features or style opinions.
- Explore systematically, like a new user learning the product: open each section from the navigation (sidebars and icon rails count: buttons with labels such as "Projects" or "Settings"), then its sub-features (tabs, menus, filters, toggles, settings panes, item details, empty states). Check every result.
- After every action you get: the RESULT (what changed on the page), a fresh observation (controls with refs, visible text) and a screenshot on which every control is outlined in red with its ref tag above it (set-of-marks). Use the screenshot to see what really happened and to find controls, above all icon buttons with no label: read the red tag of the box you mean and use that ref. Never guess a ref from its number or position in the list.
- Reason before every action, in one or two short sentences in your reply: what you see now, which control you will use and why, what you expect. Put that expectation in the action's expect argument.
- Then check the result against your expectation before doing anything else. If it matches, move on. If it does not, work out why: a defect (report it with what you expected and what happened), the wrong element (pick the right one on the screenshot), or a state you misread (look again). Never move on from a surprise without explaining it.
- For each browser turn propose the next step for the planned journey. When two different actions could both advance it, propose them as alternatives for JEV. JEV selects at most one for execution. Never batch dependent steps or combine browser proposals with findings or finish. Once the screen changes, QASE skips the rest of that turn's actions, because they were planned for the old screen.
- Elements marked (covered) are behind a pop-up: close the pop-up first (QASE already closes tours and banners it recognises).
- If an action fails, try another way (a different element, scrolling it into view, keyboard) instead of repeating it.
- Finish only when the journey goal is covered; summarise what you exercised and what you could not reach.`;

/**
 * An element's OWN label: aria-label, else its text without the text of
 * controls nested inside it (a chat row's hover Reply/Delete buttons belong to
 * those buttons, so the row is not mistaken for a destructive action).
 */
export async function elementLabel(locator) {
	return locator.evaluate(element => {
		if (element.getAttribute('aria-label')) return element.getAttribute('aria-label').trim().slice(0, 60);
		const nested = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=menuitem],[role=tab]';
		let own = '';
		if (element.querySelector(nested)) {
			const clone = element.cloneNode(true);
			for (const child of clone.querySelectorAll(nested)) child.remove();
			own = clone.textContent;
		}
		return String(own || element.innerText || element.value || element.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 60);
	}, undefined, { timeout: 1500 }).catch(() => '');
}

const observations = new WeakMap();
const nextPageRef = new WeakMap();

// Snapshot only menus associated with the clicked control. Other content on
// the page may change independently (e.g. rotating headlines).
function visibleMenuItems(control) {
	const panels = new Set((control.getAttribute('aria-controls') || '').split(/\s+/)
		.filter(Boolean).map(id => document.getElementById(id)).filter(Boolean));
	const item = control.closest('li');
	if (item) for (const panel of item.querySelectorAll(':scope > ul, :scope > [role=menu]')) panels.add(panel);
	const labels = [];
	for (const panel of panels) {
		for (const el of panel.querySelectorAll('a[href], button, [role=menuitem]')) {
			if (el === control || !el.getClientRects().length || el.closest('[hidden], [aria-hidden=true]')) continue;
			if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
			const label = (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 80);
			if (label) labels.push(label);
		}
	}
	return labels;
}

/** Tags interactive elements and returns a compact observation. */
export async function observe(page, log) {
	const previousHandle = observations.get(page);
	await previousHandle?.dispose().catch(() => {});
	observations.delete(page);
	const firstRef = nextPageRef.get(page) ?? 0;
	nextPageRef.set(page, firstRef + 500);
	const handle = await page.evaluateHandle(first => {
		// Refs are stable: an element keeps its ref across observations, so a ref the
		// model read earlier still names the same element (or reports it is gone),
		// never a different control that happens to take its number.
		let next = first;
		const identities = window.__qaseElementRefs ??= new WeakMap();
		const controls = new Map();
		let count = 0;
		const items = [];
		const nameOf = element => {
			const labelled = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.innerText ?? '').join(' ');
			const svgTitle = element.querySelector?.('svg title')?.textContent ?? '';
			const img = element.querySelector?.('img[alt]')?.getAttribute('alt') ?? '';
			const tooltip = element.getAttribute('data-tooltip') || element.getAttribute('data-tip') || element.getAttribute('data-title') || element.getAttribute('data-original-title') || '';
			const fieldLabel = element.labels?.[0]?.innerText ?? '';
			// A row or card that contains its own buttons is named by its own text.
			let own = '';
			if (!element.getAttribute('aria-label') && element.querySelector('a[href],button,input,select,textarea,[role=button],[role=link],[role=menuitem]')) {
				const clone = element.cloneNode(true);
				for (const child of clone.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link],[role=menuitem]')) child.remove();
				own = clone.textContent;
			}
			return String(element.getAttribute('aria-label') || labelled || own.trim() || element.innerText || element.value || fieldLabel || element.placeholder || element.title || element.alt || svgTitle || img || tooltip || '').replace(/\s+/g, ' ').trim().slice(0, 70);
		};
		// Controls that were not in the previous observation are marked NEW and listed first,
		// so features revealed by the last action are never cut off by the list limit.
		const previous = window.__qasePrevKeys ? new Set(window.__qasePrevKeys) : undefined;
		const seenKeys = [];
		for (const element of document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],summary,[contenteditable=true]')) {
			const r = element.getBoundingClientRect();
			const s = getComputedStyle(element);
			if (r.width < 2 || r.height < 2 || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) continue;
			if (count++ >= 500) break;
			let id = identities.get(element);
			if (!id) { id = `e${next++}`; identities.set(element, id); }
			if (element.getAttribute('data-qase-ref') !== id) element.setAttribute('data-qase-ref', id);
			const name = nameOf(element);
			const landmark = element.closest('nav,header,footer,main,aside,form,[role=navigation]');
			const region = landmark && landmark.localName !== 'main' ? ` [in ${(landmark.getAttribute('aria-label') || landmark.localName).slice(0, 50)}]` : '';
			const identity = () => JSON.stringify([nameOf(element), element.getAttribute('role'), element.getAttribute('href'), element.type]);
			const observedIdentity = identity();
			controls.set(id, () => element.isConnected && identity() === observedIdentity && element.closest('nav,header,footer,main,aside,form,[role=navigation]') === landmark ? element : null);
			const inView = r.bottom > 0 && r.top < innerHeight;
			const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)); const cy = Math.min(innerHeight - 1, Math.max(0, r.top + Math.min(r.height / 2, 20)));
			const hit = inView ? document.elementFromPoint(cx, cy) : null;
			const covered = inView && hit && hit !== element && !element.contains(hit) && !hit.contains(element);
			const key = `${element.tagName}:${name}`;
			const fresh = Boolean(previous) && !previous.has(key);
			seenKeys.push(key);
			// Unnamed icon controls get their place on screen, to match the marks on the screenshot.
			const where = !name && inView ? ` [no label · icon at x${Math.round(cx)},y${Math.round(cy)} · see its mark on the screenshot]${region}` : region;
			items.push({ rank: (fresh ? 0 : 10) + (covered ? 4 : 0) + (inView ? 0 : 2), line: `${fresh ? 'NEW ' : ''}${id} ${element.tagName.toLowerCase()}${element.type && element.tagName === 'INPUT' ? `[${element.type}]` : ''}${element.getAttribute('role') ? `(${element.getAttribute('role')})` : ''} "${name}"${where}${element.tagName === 'A' ? ` → ${element.getAttribute('href')?.slice(0, 80)}` : ''}${element.disabled ? ' [disabled]' : ''}${element.getAttribute('aria-expanded') ? ` [expanded=${element.getAttribute('aria-expanded')}]` : ''}${element.checked ? ' [checked]' : ''}${'value' in element && element.value && element.tagName !== 'BUTTON' ? ` value="${String(element.value).slice(0, 40)}"` : ''}${inView ? '' : ' (off-screen)'}${covered ? ' (covered)' : ''}` });
		}
		const text = (document.body?.innerText ?? '').replace(/\n{2,}/g, '\n').slice(0, 2500);
		window.__qasePrevKeys = seenKeys;
		const ranked = items.map((item, index) => ({ ...item, index })).sort((a, b) => a.rank - b.rank || a.index - b.index);
		const shown = ranked.slice(0, 140).sort((a, b) => a.rank - b.rank || a.index - b.index).map(item => item.line);
		if (ranked.length > 140) shown.push(`(${ranked.length - 140} more controls further down or covered — scroll to reach them)`);
		return { controls, summary: { url: location.href, title: document.title, items: shown, text, scroll: `${Math.round(scrollY)}/${document.documentElement.scrollHeight - innerHeight}` } };
	}, firstRef).catch(() => undefined);
	if (handle) observations.set(page, handle);
	const snapshot = await handle?.evaluate(state => state.summary).catch(() => undefined)
		?? { url: page.url(), title: '', items: [], text: '(page could not be read)' };
	const overlays = (await openOverlays(page)).filter(item => item.modal);
	const errors = [...(log.pageErrors ?? []).slice(-3).map(error => `JS error: ${error.message}`), ...(log.console ?? []).filter(item => item.type === 'error').slice(-3).map(item => `console: ${item.text}`)];
	return `URL: ${snapshot.url}\nTitle: ${snapshot.title}\nScroll: ${snapshot.scroll}\n${overlays.length ? `Open pop-up(s): ${overlays.map(item => `"${item.text.slice(0, 80)}"${item.close ? ` (close with "${item.close}")` : ''}`).join('; ')}\n` : ''}${errors.length ? `Recent errors:\n${errors.join('\n')}\n` : ''}Interactive elements:\n${snapshot.items.join('\n')}\n\nVisible text:\n${snapshot.text}`;
}

export async function explore({ browser, profile, startUrl, models, knownIssues = [], maxSteps = 30, callLimit = Infinity, observeForms = false, saveTarget, deadline, signal, blockedWrites, save, onStep = () => {}, focus, goal, signedIn = false, pages = [], untested = [], exercised = new Set() }) {
	const out = [];
	const summary = { steps: 0, finished: false, summary: '', visited: new Set(), loopWarnings: 0, loopStopped: false, trail: [] };
	let consecutiveLooks = 0;
	let replans = 0;
	let lastRef; let lastLabel = '';
	let clickReceipt;
	let clickStep;
	const settleQuietly = () => browser.settle?.(page, { quietMs: 400 }).catch(() => {});
	let actionsSinceLook = 99;
	let urlAtLook = '';
	// Loop detection: the same action on the same element and page, repeated, means the
	// model is stuck. It is told so (with what it repeated); a third warning ends the journey.
	const signatures = new Map();
	let samePageSteps = 0;
	let lastUrl;
	if (!models.reasonerAvailable()) return { candidates: out, summary: { ...summary, skipped: 'reasoner unavailable' } };
	const { page, log } = await browser.openPage(profile);
	const forms = observeForms ? formOutcomeObserver(page, save, saveTarget) : undefined;
	if (forms) summary.formOutcomes = forms.outcomes;
	browser.setActivePage(page);
	const trail = [];
	// Requests QASE refused at each step: issues observed right after a refusal are harness side-effects.
	const refusals = [];
	const offsiteBlocked = () => browser.blocked?.().offsite_navigation ?? 0;
	try {
		await page.exposeBinding('__qaseReceiveClick', ({ frame }, step, receipt) => {
			if (frame === page.mainFrame() && clickStep && step === clickStep && !clickReceipt && typeof receipt?.matched === 'boolean') {
				clickReceipt = { matched: receipt.matched, tag: String(receipt.tag).slice(0, 30), ref: String(receipt.ref || '').slice(0, 30) };
			}
		});
		await browser.goto(page, startUrl, log).catch(() => {});
		const SYSTEM = systemPrompt(saveTarget);
		const messages = [
			{ role: 'system', content: `${SYSTEM}\n${UNTRUSTED_CONTENT_RULE}` },
			{ role: 'user', content: `Site under test: ${startUrl}\nViewport: ${profile.label}\nSession: ${signedIn ? 'signed in with the owner\'s test account' : 'not signed in'}\n${goal ? `Journey to test now (from the test plan): ${goal}\n` : ''}${untested.length ? `Feature areas mapped but not yet exercised in this run (cover the ones that belong to this journey):\n${untested.slice(0, 25).map(item => `- ${item}`).join('\n')}\n` : ''}${focus ? `Owner's focus: ${focus}\n` : ''}${pages.length ? `Pages already found by the crawler: ${pages.slice(0, 25).join(', ')}\n` : ''}Already reported by automated checks (do not repeat): ${knownIssues.slice(0, 40).join('; ') || 'none'}\n\nCurrent page:\n${await observe(page, log)}` }
		];
		while (summary.steps < maxSteps && Date.now() < deadline && models.reasonerAvailable() && (models.state?.reasoner?.calls ?? 0) < callLimit) {
			signal?.throwIfAborted();
			// Keep the context small: older observations are trimmed, and only the latest
			// screenshot is sent (older ones describe screens that no longer exist).
			let latestImage = -1;
			for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user' && Array.isArray(messages[i].content)) { latestImage = i; break; }
			for (let i = 2; i < messages.length; i++) {
				if (i < messages.length - 8 && messages[i].role === 'tool' && messages[i].content.length > 300) messages[i] = { ...messages[i], content: `${messages[i].content.slice(0, 200)}\n[older observation trimmed]` };
				if (i !== latestImage && messages[i].role === 'user' && Array.isArray(messages[i].content)) messages[i] = { role: 'user', content: '[older screenshot trimmed]' };
			}
			const reply = await models.chat(messages, { tools: TOOLS, maxTokens: 2048, signal, purpose: 'exploration', callLimit });
			if (!reply) break;
			messages.push({ role: 'assistant', content: reply.text || null, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}) });
			if (!reply.toolCalls.length) {
				messages.push({ role: 'user', content: 'Continue testing with a tool call, or call finish.' });
				summary.steps++;
				continue;
			}
			let selection;
			if (reply.toolCalls.some(isJourneyAction)) {
				selection = await selectJourneyAction({models,calls:reply.toolCalls,goal:goal ?? focus,signal,deadline,
					describe: ref => observations.get(page)?.evaluate((state,id) => {
						const el = state.controls.get(id)?.();
						if (!el) return undefined;
						return {kind:el.localName,label:el.getAttribute('aria-label') || el.labels?.[0]?.innerText || (['button','a','summary'].includes(el.localName) ? el.innerText : '')};
					},ref).catch(() => undefined)});
				if (selection.blocked) { summary.actionGap = selection.blocked; break; }
				if (selection.replan) {
					for (const call of reply.toolCalls) messages.push({role:'tool',tool_call_id:call.id,content:'No action taken. JEV requested a revised step.'});
					if (++replans >= 2) { summary.actionGap = 'JEV requested a different step twice. No further action was taken.'; break; }
					messages.push({role:'user',content:'Plan a different step from this fresh observation:\n' + await observe(page, log)});
					continue;
				}
				replans = 0;
			}
			let screenshot;
			let acted = false;
			let screenChanged = false;
			for (const call of reply.toolCalls) {
				if (selection && selection.call !== call) {
					messages.push({role:'tool',tool_call_id:call.id,content:'Skipped. A different browser action was selected for this turn.'});
					continue;
				}
				let args = {};
				try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* invalid arguments become an error result */ }
				const name = call.function?.name;
				// Actions planned for a screen that has since changed would act on stale
				// assumptions (and refs): every tool call still gets an answer, but they do not run.
				if (screenChanged && name !== 'report_issue' && name !== 'finish') {
					messages.push({ role: 'tool', tool_call_id: call.id, content: 'Skipped: the screen changed after your previous action in this turn. Look at the new observation and screenshot, then decide again.' });
					continue;
				}
				summary.steps++;
				clickStep = undefined;
				clickReceipt = undefined;
				let result;
				try {
					result = await dispatch(name, args, call.id);
				} catch (error) {
					result = `Error: ${String(error.message).split('\n')[0].slice(0, 200)}`;
				}
				const acting = ACTIONS.has(name);
				if (result?.image) { screenshot = result.image; result = 'Screenshot (with control marks) attached below.'; }
				else if (acting) {
					acted = true;
					const text = String(result);
					if (/^RESULT: (?!nothing visible changed)/m.test(text)) screenChanged = true;
					// Reasoning loop: the model's own expectation, next to what happened.
					if (args.expect && text.startsWith('RESULT:')) result = `You expected: ${String(args.expect).slice(0, 200)}\n${text}\nCheck: does the RESULT and the screenshot match what you expected? If not, explain why before your next action.`;
				}
				consecutiveLooks = name === 'look' ? consecutiveLooks + 1 : 0;
				if (name !== 'look') actionsSinceLook++;
				// Reviewable trail: what the agent did and the first line of what it saw.
				summary.trail.push(`${summary.steps}. ${name}${args.ref ? ` ${lastLabel && lastRef === args.ref ? `"${lastLabel}" (${args.ref})` : args.ref}` : ''}${args.url ? ` ${args.url}` : ''}${args.text ? ` "${String(args.text).slice(0, 40)}"` : ''}${args.key ? ` ${args.key}` : ''}${name === 'report_issue' ? ` "${String(args.title ?? '').slice(0, 80)}"` : ''}${name === 'finish' ? ` "${String(args.summary ?? '').slice(0, 160)}"` : ''}${args.expect ? ` — expecting ${String(args.expect).slice(0, 90)}` : ''} → ${(String(result).split('\n').find(line => line.startsWith('RESULT:')) ?? String(result).split('\n').find(line => line && !line.startsWith('('))) ?.slice(0, 160) ?? ''} @ ${page.url().replace(/^https?:\/\/[^/]+/, '')}`);
				messages.push({ role: 'tool', tool_call_id: call.id, content: String(result).slice(0, 6000) });
				if (name === 'click') {
					const receiver = clickReceipt ? `${clickReceipt.tag} ${clickReceipt.ref || '(unmarked)'}` : 'unverified';
					summary.trail[summary.trail.length - 1] += ` · click recipient: ${receiver}`;
				}
				if (selection) summary.trail[summary.trail.length - 1] += ' · selected by JEV';
				onStep({ name, args, selectedBy:selection ? 'JEV' : undefined, url: page.url(), line: summary.trail.at(-1), thought: String(reply.text ?? '').trim().slice(0, 400) });
				if (saveTarget && forms?.outcomes.some(outcome => outcome.attempted)) {
					summary.saveAttempted = true;
					summary.finished = forms.outcomes.some(outcome => outcome.receipt);
					summary.summary = summary.finished ? 'The corrected submission produced a verified receipt.' : 'The corrected submission was attempted. Its receipt could not be verified.';
					break;
				}
				if (name === 'finish') { summary.finished = true; summary.summary = String(args.summary ?? '').slice(0, 2000); break; }
				const loop = detectLoop(name, args, page.url());
				if (loop) {
					summary.loopWarnings++;
					if (summary.loopWarnings >= 3) { summary.loopStopped = true; break; }
					messages.push({ role: 'user', content: `Loop detected: ${loop}. Do not repeat it. Choose a different feature or page${goal ? ' that serves the goal' : ''}, or call finish if the goal is covered.` });
				}
			}
			if (summary.finished || summary.loopStopped || summary.saveAttempted) break;
			// Vision after every action: the model sees what its action did, with each
			// control's ref drawn on the screenshot, before it decides the next step.
			if (!screenshot && acted && models.visionAvailable()) {
				screenshot = await (browser.markedScreenshot ? browser.markedScreenshot(page) : page.screenshot({ type: 'jpeg', quality: 55 })).catch(() => undefined);
				if (screenshot) { actionsSinceLook = 0; urlAtLook = page.url(); }
			}
			if (screenshot) messages.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot of the current viewport after your last action. Red boxes are the controls; the red tag above each box is its ref.' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot.toString('base64')}` } }] });
		}
		if (replans && !summary.finished && !summary.actionGap) summary.actionGap = 'The planner did not produce an executable revised action before the journey ended.';
	} finally {
		await page.close().catch(() => {});
	}
	return { candidates: out, summary: { ...summary, visited: [...summary.visited] } };

	function detectLoop(name, args, url) {
		if (['look', 'report_issue'].includes(name)) return undefined;
		const key = `${name}:${args.ref ?? args.url ?? args.key ?? args.text ?? args.direction ?? ''}@${String(url).split('#')[0]}`;
		const count = (signatures.get(key) ?? 0) + 1;
		signatures.set(key, count);
		samePageSteps = url === lastUrl ? samePageSteps + 1 : 0;
		lastUrl = url;
		if (count >= 3) { signatures.set(key, 0); return `"${name}" on ${args.ref ?? args.url ?? 'the same target'} was repeated ${count} times on ${url}`; }
		if (samePageSteps >= 10) { samePageSteps = 0; return `10 actions in a row stayed on ${url} without leaving it`; }
		return undefined;
	}

	async function dispatch(name, args, stepId) {
		const monitored = (element, run) => ACTIONS.has(name) && log?.runtime ? log.runtime.action({
			stepId, name, ref: args.ref, element, run,
			executed: result => name === 'click' ? clickReceipt?.matched === true : /^RESULT:/m.test(String(result)) && !/^Refused/.test(String(result))
		}) : run();
		if (forms && name === 'press' && args.key === 'Enter') {
			const focused = await page.evaluateHandle(() => document.activeElement);
			try { return await monitored(focused, () => forms.observe(focused, () => runTool(name, args))); }
			finally { await focused.dispose().catch(() => {}); }
		}
		if (!['click', 'type', 'select'].includes(name)) return monitored(undefined, () => runTool(name, args));
		const handle = await observations.get(page)?.evaluateHandle((state, ref) => state.controls.get(ref)?.() ?? null, args.ref).catch(() => undefined);
		const popupUrls = [];
		const recordPopup = popup => popupUrls.push(popup.url());
		try {
			const element = handle?.asElement();
			if (!element) return `Element ${args.ref} no longer exists or changed since observation. Choose again:\n${await observe(page, log)}`;
			if (name === 'click') page.on('popup', recordPopup);
			const perform = () => runTool(name, args, element, popupUrls);
			const observeForm = async () => {
				const previous = forms.outcomes.at(-1)?.artifactId;
				const result = await forms.observe(element, perform);
				const receipt = forms.outcomes.at(-1)?.artifactId;
				if (receipt && receipt !== previous) log?.runtime?.receipt(receipt);
				return result;
			};
			return await monitored(element, () => forms && (name === 'click' || name === 'type' && args.submit) ? observeForm() : perform());
		} finally {
			if (name === 'click') page.off('popup', recordPopup);
			await handle?.dispose().catch(() => {});
		}
	}

	// Listen before activating the pinned element. A browser event can arrive
	// even when Playwright subsequently times out waiting for navigation.
	async function pressObserved(element, timeout) {
		clickStep = crypto.randomUUID();
		const cleanup = await element.evaluateHandle((expected, step) => {
			const listener = event => {
				if (!event.isTrusted) return;
				const control = event.composedPath().find(node => node instanceof Element && node.matches('button,a[href],input,select,textarea,summary,[data-qase-ref],[role=button],[role=link]')) ?? event.target;
				void window.__qaseReceiveClick(step, { matched: control === expected, tag: control.localName, ref: control.getAttribute('data-qase-ref') });
			};
			window.addEventListener('click', listener, true);
			return () => window.removeEventListener('click', listener, true);
		}, clickStep);
		try {
			await browser.interact(() => browser.activate ? browser.activate(element, { timeout }, page) : element.click({ timeout }));
		} finally {
			await cleanup.evaluate(remove => remove()).catch(() => {});
			await cleanup.dispose().catch(() => {});
		}
	}

	async function runTool(name, args, element, popupUrls) {
		const describeRef = async () => (await elementLabel(element)) || args.ref;
		const blockedBefore = blockedWrites();
		const offsiteBefore = offsiteBlocked();
		const acting = ['click', 'type', 'select', 'press', 'back', 'navigate'].includes(name);
		const beforeScreen = acting ? await page.evaluate(screenSignature).catch(() => undefined) : undefined;
		const after = async () => {
			await browser.settle(page, { quietMs: 1200 });
			const cleared = await dismissOverlays(page, { includeToasts: true, cursor: (target, text) => browser.pointAt?.(page, target, text) }).catch(() => []);
			if (cleared.length) trail.push(`Close the pop-up (${cleared[0]})`);
			summary.visited.add(page.url().split('#')[0]);
			const blocked = blockedWrites() - blockedBefore;
			const offsite = offsiteBlocked() - offsiteBefore;
			refusals.push(blocked + offsite);
			const notes = [
				blocked ? `(The page sent ${blocked} write request${blocked > 1 ? 's' : ''}; QASE blocked ${blocked > 1 ? 'them' : 'it'}. Any error or loading state that follows is caused by the block.)` : '',
				offsite ? '(The page tried to leave the site, e.g. a sign-in-with or payment hand-off; QASE blocked it. A spinner or unchanged page that follows is caused by the block.)' : ''
			].filter(Boolean).join('\n');
			// What this action changed: the most useful signal for deciding the next step.
			let change = '';
			if (beforeScreen) {
				const afterScreen = await page.evaluate(screenSignature).catch(() => undefined);
				if (afterScreen) {
					const fresh = appeared(beforeScreen, afterScreen);
					const gone = appeared(afterScreen, beforeScreen);
					const flips = toggled(beforeScreen, afterScreen);
					const moved = afterScreen.url !== beforeScreen.url;
					change = !moved && !fresh.length && !gone.length && !flips.length
						? 'RESULT: nothing visible changed. If you expected a change, this may be a defect (dead control) or the wrong element; do not repeat it blindly.'
						: `RESULT: ${moved ? `URL changed to ${afterScreen.url}. ` : 'URL unchanged. '}${afterScreen.dialog && afterScreen.dialog !== beforeScreen.dialog ? `Dialog opened: "${afterScreen.dialog}". ` : ''}${flips.length ? `Expanded: ${flips.join(' | ')}. ` : ''}${fresh.length ? `Appeared: ${fresh.slice(0, 12).join(' | ')}. ` : ''}${gone.length ? `Disappeared: ${gone.slice(0, 8).join(' | ')}.` : ''}`;
				}
			}
			return `${change ? `${change}\n` : ''}${notes ? `${notes}\n` : ''}${await observe(page, log)}`;
		};
		switch (name) {
			case 'click': {
				const label = await describeRef(args.ref);
				const destination = await element.evaluate(el => el.matches('a[href]') && /^https?:$/.test(el.protocol) && el.href !== location.href ? el.href : null);
				lastRef = args.ref; lastLabel = label === args.ref ? '' : String(label).slice(0, 50);
				if (DESTRUCTIVE.test(label)) return `Refused: "${label}" looks destructive. Choose another action.`;
				trail.push(`Click "${label}"`);
				await element.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
				const menuBefore = destination ? await element.evaluate(visibleMenuItems).catch(() => null) : null;
				const startedAt = Date.now();
				await browser.pointAt?.(page, element, `Click "${label}"`);
				try {
					try {
						await pressObserved(element, 5000);
					} catch (error) {
						// Retry only a verified interception after clearing its overlay.
						if (clickReceipt || !/intercepts pointer/.test(error.message)) throw error;
						const cleared = await dismissOverlays(page, { includeToasts: true }).catch(() => []);
						if (!cleared.length) throw error;
						await pressObserved(element, 4000);
					}
				} catch (error) {
					if (clickReceipt) return `Click on "${label}" was received but its outcome is uncertain. Review this state before acting again.\n${await observe(page, log)}`;
					return `Click on "${label}" failed (${/intercepts pointer|not visible|outside of the viewport/.test(error.message) ? 'another element covers it or it is off-screen' : String(error.message).split('\n')[0].slice(0, 120)}). Choose again from this observation.\n${await observe(page, log)}`;
				}
				const result = await after();
				if (!clickReceipt?.matched) return `Click recipient for "${label}" ${clickReceipt ? 'differed from the intended control' : 'could not be verified'}.\n${result}`;
				const blockedDestination = destination && offsiteBlocked() > offsiteBefore && browser.recentBlocked?.(startedAt).some(event => event.kind === 'offsite_navigation' && event.url.split('#')[0] === destination.split('#')[0]);
				if (blockedDestination) return `RESULT: Navigation blocked by this run's site scope: ${destination}. The destination was not tested.\n${result}`;
				if (popupUrls.length) {
					if (destination && popupUrls.includes(destination) && browser.inScope(destination)) {
						exercised.add(String(label).slice(0, 60));
						return `RESULT: Link opened the expected new tab at ${destination}. Its content was not tested.\n${result}`;
					}
					return `RESULT: A new tab opened. Its destination was not verified for this control.\n${result}`;
				}
				if (destination && page.url() !== destination) {
					if (menuBefore && page.url() === beforeScreen?.url) {
						const menuAfter = await element.evaluate(visibleMenuItems).catch(() => []);
						const revealed = menuAfter.filter(item => !menuBefore.includes(item));
						if (revealed.length) return `RESULT: Submenu opened for "${label}": ${revealed.slice(0, 5).join(', ')}. The link destination was not visited.\n${result}`;
					}
					return `RESULT: Link destination unverified in this tab. Expected ${destination}, observed ${page.url()}.\n${result}`;
				}
				if (blockedWrites() === blockedBefore && offsiteBlocked() === offsiteBefore && /^RESULT: URL /.test(result)) exercised.add(String(label).slice(0, 60));
				return result;
			}
			case 'type': {
				const label = await describeRef(args.ref);
				lastRef = args.ref; lastLabel = label === args.ref ? '' : String(label).slice(0, 50);
				trail.push(`Type "${String(args.text).slice(0, 60)}" into "${label}"${args.submit ? ' and press Enter' : ''}`);
				await browser.pointAt?.(page, element, `Type "${String(args.text ?? '').slice(0, 24)}"`);
				await browser.interact(async () => {
					await element.fill(String(args.text ?? '').slice(0, 2000), { timeout: 5000 });
					if (args.submit) await element.press('Enter');
				});
				return after();
			}
			case 'select': {
				trail.push(`Select "${args.option}" in "${await describeRef(args.ref)}"`);
				await browser.interact(() => element.selectOption({ label: String(args.option) }, { timeout: 5000 }));
				return after();
			}
			case 'press':
				trail.push(`Press ${args.key}`);
				await browser.interact(() => page.keyboard.press(String(args.key).slice(0, 30)));
				return after();
			case 'navigate': {
				const url = new URL(String(args.url), page.url()).href;
				if (!browser.inScope(url)) return 'Refused: that URL is outside the site under test.';
				if (/\/(log-?out|sign-?out|delete|remove|destroy|unsubscribe)(\/|$|\?)/i.test(new URL(url).pathname)) return 'Refused: that URL would sign out or change data. Choose another page.';
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
				// Two looks in a row with nothing in between show the same screen twice.
				if (consecutiveLooks >= 2) return `You already have a screenshot of this screen. Act on it:\n${await observe(page, log)}`;
				actionsSinceLook = 0; urlAtLook = page.url();
				await settleQuietly();
				await observe(page, log); // refresh refs so the marks match the current screen
				return { image: await (browser.markedScreenshot ? browser.markedScreenshot(page, { quality: 60 }) : page.screenshot({ type: 'jpeg', quality: 60 })) };
			case 'report_issue': {
				if (!args.title || !args.actual) return 'Rejected: title and actual are required.';
				await browser.hideCursor?.(page);
				const bytes = await page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => undefined);
				const recentRefusals = refusals.slice(-4).reduce((sum, value) => sum + value, 0);
				const harness = recentRefusals && ['functional', 'content', 'forms', 'network', 'animation', 'visual'].includes(args.category)
					? `QASE blocked ${recentRefusals} request${recentRefusals === 1 ? '' : 's'} (write or off-site navigation) in the steps just before this was observed, so it may be caused by the test harness.` : undefined;
				out.push(candidate({ source: 'explorer', detector: 'agent.exploration', category: args.category, severity: args.severity, confidence: harness ? 0.3 : 0.65,
					title: args.title, url: page.url(), viewport: profile.name, expected: args.expected, actual: args.actual, evidence: args.evidence,
					steps: Array.isArray(args.steps) && args.steps.length ? args.steps : trail.slice(-8),
					artifactId: bytes ? await save(bytes, `Explorer: ${args.title}`) : undefined, data: { key: args.title, trail: trail.slice(-12), harness } }));
				return `Recorded issue ${out.length}. Continue testing.`;
			}
			case 'finish':
				return 'Finished.';
			default:
				return `Unknown tool ${name}.`;
		}
	}
}
