import { randomUUID } from 'node:crypto';
import { createTenantContext } from '../tenancy.js';
import { candidate } from './findings.js';
import { checkResponse, diagnosticPolicy, readDiagnosticConfig } from './runtimePolicy.js';

const networkCode = value => String(value).match(/\b(?:ERR|NS_ERROR)_[A-Z_]+\b/)?.[0] ?? 'transport failure';
const sameDocument = (url, origin, path) => {
	try { const u = new URL(url); return u.origin === origin && (path.includes('#') ? u.pathname + u.hash : u.pathname) === path; } catch { return false; }
};
const sameOrigin = (url, origin) => { try { return new URL(url).origin === origin; } catch { return false; } };
const pendingReason = 'Request still pending when page observation ended';

export function createRuntimeDiagnostics({ session, projectId = createTenantContext().projectId, rawConfig, history, context = () => ({}), onCandidate = () => {} }) {
	let config;
	let configError = false;
	try { config = readDiagnosticConfig(rawConfig); } catch { config = {}; configError = true; }
	const policy = diagnosticPolicy(session, config);
	const blocked = new WeakSet();
	const activeRequests = new WeakMap();
	const rules = (config.contracts ?? []).filter(r => r.origin === policy.origin);
	const state = history ?? { events: [], dropped: 0, issues: [], pages: 0 };
	const enabled = config.enabled !== false;
	const issue = reason => { if (!state.issues.includes(reason)) state.issues.push(reason); };
	if (history?.events.some(e => e.state === 'pending' && !e.reason)) issue('Earlier browser session ended with unfinished requests');
	if (configError) issue('Invalid diagnostic configuration; contract checks unavailable');
	const sessions = new WeakMap();
	state.observedContracts ??= [];
	const seenContracts = new Set(state.observedContracts);
	state.checkedResponses ??= [];
	const responseContractIds = rules.filter(r => r.statuses || r.contentType || r.fields || r.values).map(r => r.id);
	function observed(rule) {
		if (rule && !seenContracts.has(rule.id)) { seenContracts.add(rule.id); state.observedContracts.push(rule.id); }
	}

	const tasks = new Set();
	const limit = config.maxEvents ?? 1000;
	const maxLog = 400;
	const remember = (items, item) => { if (items.length < maxLog) items.push(item); };
	function record(type, page, fields) {
		const event = { id: randomUUID(), type, ts: Date.now(), classification: 'Informational', pageUrl: policy.url(page.url()), ...fields };
		if (enabled) {
			while (state.events.length >= limit) { state.events.shift(); state.dropped++; }
			state.events.push(event);
		}
		return event;
	}
	function finding(event, classification, reason, rule) {
		event.classification = classification;
		event.reason = reason;
		const categories = { 'Verified Runtime Defect': 'console', 'Navigation Defect': 'navigation' };
		const item = candidate({
			detector: 'runtime.' + classification.toLowerCase().replaceAll(' ', '_'), category: categories[classification] ?? 'network',
			severity: rule.severity ?? 'medium', confidence: 1, title: rule.id + ' — ' + reason, url: event.pageUrl,
			expected: 'Meet the approved expectation for ' + rule.id, actual: reason, selector: rule.control,
			evidence: [event.id, ...(event.related ?? []), event.method, event.url, event.status && 'HTTP ' + event.status,
				event.durationMs != null && event.durationMs + ' ms', event.networkEvidence, event.runtimeEvidence,
				event.expected?.visible && 'Missing visible element ' + event.expected.visible, event.expected?.destination && 'Expected destination ' + event.expected.destination].filter(Boolean).join(' · '), steps: ['Open ' + event.pageUrl, 'Exercise ' + (rule.control ?? rule.endpoint), 'Check the recorded response and expected result'],
			artifactId: event.artifactId, data: { key: rule.id, eventId: event.id }
		});
		item.scenarioId = event.scenarioId;
		onCandidate(item);
	}
	function attach(page, log, inflight) {
		if (sessions.has(page)) return sessions.get(page);
		const browserSessionId = randomUUID();
		state.pages++;
		const meta = () => ({ browserSessionId, ...context(), ...(active ? active.meta : {}) });
		const subscriptions = [];
		const requests = new WeakMap();
		const initiators = [];
		let cdp;
		const supplements = [];
		const runtimeEvents = [];
		function matchException(event, details) {
			return event.message === details.message && Math.abs(event.ts - details.ts) < 1000;
		}
		function chromeException({ timestamp, exceptionDetails: d }) {
			const description = String(d.exception?.description ?? d.text ?? '').split('\n')[0];
			const message = policy.message(description.replace(/^(?:Uncaught(?: \(in promise\))?\s*)?(?:\w*Error:\s*)?/, ''));
			const frame = d.stackTrace?.callFrames?.[0];
			const detail = { message, ts: timestamp, source: policy.url(d.url ?? frame?.url), line: d.lineNumber, column: d.columnNumber };
			const matches = runtimeEvents.filter(event => matchException(event, detail));
			if (matches.length === 1) matches[0].chromeLocation = { source: detail.source, line: detail.line, column: detail.column };
			else {
				supplements.push(detail);
				if (supplements.length > 30) supplements.shift();
			}
		}
		function chromeRequest(params) {
			const top = params.initiator?.stack?.callFrames?.[0];
			initiators.push({ method: params.request.method, url: policy.url(params.request.url), at: params.wallTime * 1000,
				type: params.initiator?.type, source: policy.url(top?.url), line: top?.lineNumber, column: top?.columnNumber });
			if (initiators.length > 200) initiators.shift();
		}
		async function useCDP(session) {
			if (!enabled) return;
			cdp = session;
			cdp.on('Network.requestWillBeSent', chromeRequest);
			cdp.on('Runtime.exceptionThrown', chromeException);
			try { await cdp.send('Runtime.enable'); } catch { issue('Chrome exception locations unavailable'); }
			try { await cdp.send('Network.enable'); }
			catch { issue('Chrome initiator information unavailable'); }
		}
		const unfinished = new Set();
		const backgroundEndpoints = new Set();
		let active;
		let previousUrl = policy.url(page.url());
		let lastMessage;
		function listen(name, fn) {
			const wrapped = (...args) => {
				try { fn(...args); } catch { issue('Browser event or masking failed'); }
			};
			page.on(name, wrapped);
			subscriptions.push([name, wrapped]);
		}
		function recordMessage(type, fields) {
			const attribution = meta();
			const sig = JSON.stringify([type, page.url() === 'about:blank', policy.url(page.url()), attribution, fields]);
			if (lastMessage?.sig === sig && state.events.at(-1) === lastMessage.event) {
				lastMessage.event.count++;
				lastMessage.event.lastTs = Date.now();
				return lastMessage.event;
			}
			const event = record(type, page, { ...attribution, ...fields, count: 1 });
			lastMessage = { sig, event };
			return event;
		}
		listen('console', msg => {
			const loc = msg.location();
			const fields = { level: msg.type(), text: policy.message(msg.text()), source: policy.url(loc.url), line: loc.lineNumber, column: loc.columnNumber };
			const event = recordMessage('console', fields);
			if (event.count === 1 && ['error','warning'].includes(fields.level)) remember(log.console, { type: fields.level, text: fields.text, location: fields.source, ts: event.ts });
		});
		listen('pageerror', error => {
			const stack = String(error.stack ?? '').split('\n').slice(1, 9).flatMap(line => {
				const match = line.match(/((?:https?|chrome-extension|moz-extension):\/\/[^\s()]+):(\d+):(\d+)\)?$/);
				return match ? [{ source: policy.url(match[1]), line: Number(match[2]), column: Number(match[3]) }] : [];
			});
			const errorType = ['TypeError','ReferenceError','SyntaxError','RangeError','Error'].includes(error.name) ? error.name : 'Exception';
			const event = recordMessage('runtime', { errorType, message: policy.message(error.message), stack });
			const supplement = supplements.filter(detail => matchException(event, detail));
			if (supplement.length === 1) {
				const { source, line, column } = supplement[0];
				event.chromeLocation = { source, line, column };
			}
			if (event.count === 1) runtimeEvents.push(event);
			if (runtimeEvents.length > 30) runtimeEvents.shift();
			if (event.count === 1) remember(log.pageErrors, { message: event.message, stack: stack.map(f => f.source + ':' + f.line + ':' + f.column).join('\n'), ts: event.ts });
			if (active?.rule?.script && stack[0]?.source === policy.url(active.rule.origin + active.rule.script) &&
				active.rule.errorMessage && error.message === active.rule.errorMessage) active.exception = event;
		});
		listen('request', req => {
			const now = Date.now();
			if (inflight.size < 500) inflight.set(req, now);
			if (unfinished.size >= 500) { issue('Concurrent request limit reached'); return; }
			const parent = requests.get(req.redirectedFrom());
			const entryUrl = req.isNavigationRequest() && page.url() === 'about:blank' ? req.url() : page.url();
			const eligible = enabled ? rules.filter(r => sameDocument(entryUrl, r.origin, r.page) && sameDocument(req.url(), r.origin, r.endpoint) && req.method() === r.method) : [];
			for (const r of eligible) if (r.control && !active) backgroundEndpoints.add(r.id);
			const rule = eligible.find(r => active?.rule === r) ?? eligible.find(r => !r.control);
			if (rule && !rule.control) observed(rule);
			if (active) { activeRequests.set(req, active); if (blocked.has(req)) active.blocked = true; }
			const event = record('network', page, { ...meta(), party: sameOrigin(req.url(), policy.origin) ? 'first-party' : 'external', url: policy.url(req.url()), method: /^(GET|POST|HEAD|PUT|PATCH|DELETE|OPTIONS)$/.test(req.method()) ? req.method() : 'OTHER',
				resourceType: req.resourceType(), state: 'pending', redirectedFrom: parent?.event.id,
				association: active ? 'potential' : undefined, contract: rule?.id });
			if (entryUrl !== page.url()) event.pageUrl = policy.url(entryUrl);
			const entry = { event, rule, threshold: rule?.slowMs ?? config.thresholdsMs?.[event.resourceType] };
			requests.set(req, entry);
			unfinished.add(entry);
			if (active && rule === active.rule && rule) {
				let main = false;
				try { main = req.frame() === page.mainFrame(); } catch { /* A worker or early navigation cannot prove attribution. */ }
				if (main && active.requests.length < 32) active.requests.push(event);
			}
		});
		listen('response', resp => {
			const req = resp.request();
			const entry = requests.get(req);
			if (!entry) return;
			entry.response = resp;
			Object.assign(entry.event, { status: resp.status(), responseAt: Date.now() });
			// The legacy detectors consume the same sanitized stream.
			remember(log.responses, { url: entry.event.url, method: entry.event.method, status: resp.status(), resourceType: req.resourceType(), ts: entry.event.responseAt, eventId: entry.event.id, expected: entry.rule?.statuses?.includes(resp.status()) });
		});
		function finish(req, failed) {
			inflight.delete(req);
			const entry = requests.get(req);
			if (!entry || !unfinished.delete(entry)) return;
			const { event, response, rule } = entry;
			const refused = blocked.has(req);
			const startTime = req.timing().startTime;
			const matches = initiators.filter(i => i.url === event.url && i.method === event.method && Math.abs(i.at - startTime) < 5);
			if (matches.length === 1) {
				const { type, source, line, column } = matches[0];
				event.initiator = { type, source, line, column, association: 'timing match' };
			}
			event.endAt = Date.now();
			const timing = req.timing();
			event.durationMs = timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : event.endAt - event.ts;
			event.state = failed ? 'failed' : 'finished';
			const threshold = entry.threshold;
			if (threshold && event.durationMs > threshold) {
				event.performance = { classification: 'Performance Observation', thresholdMs: threshold, durationMs: event.durationMs };
			}
			if (refused) {
				event.classification = 'Expected Behavior';
				event.reason = 'Request blocked by QASE test permissions';
				return;
			}
			if (failed) {
				event.error = networkCode(req.failure()?.errorText);
				if (event.error === 'ERR_TOO_MANY_REDIRECTS') {
					event.classification = 'Inconclusive';
					event.reason = 'Browser exceeded its redirect limit; inspect the linked redirect chain';
					return;
				}
				event.classification = /ABORT|CANCEL|BLOCKED_BY_CLIENT/.test(event.error) ? 'Informational' : /INTERNET_DISCONNECTED|NETWORK_CHANGED/.test(event.error) ? 'Environment Issue' : 'Inconclusive';
				event.reason = event.classification === 'Environment Issue' ? 'Browser reported a connectivity change' : event.classification === 'Informational' ? 'Cancelled or blocked; impact unverified' : 'Transport failure; application impact unknown';
				if (rule?.statuses?.includes(event.status) && event.status >= 400) {
					event.classification = 'Expected Behavior';
					event.reason = 'Received expected negative status; body transfer did not finish';
					if (!rule.fields && !rule.values && !rule.contentType && !state.checkedResponses.includes(rule.id)) state.checkedResponses.push(rule.id);
				}
				if (event.classification === 'Inconclusive') remember(log.failedRequests, { url: event.url, method: event.method, resourceType: event.resourceType, failure: event.error, ts: event.endAt });
				return;
			}
			if (event.status >= 400) {
				const expected = rule?.statuses?.includes(event.status);
				event.classification = expected ? 'Expected Behavior' : 'Inconclusive';
				event.reason = expected ? 'Matches approved negative response' : 'HTTP error; functional impact unverified';
			}
			if (!enabled) return;
			if (tasks.size >= 64) { issue('Response metadata backlog exceeded'); return; }
			const task = (async () => {
				const size = await req.sizes().catch(() => undefined);
				if (size) { event.requestBytes = size.requestBodySize; event.responseBytes = size.responseBodySize; }
				if (!rule || !response) return;
				const check = await checkResponse(response, rule);
				if (!check.gap && responseContractIds.includes(rule.id) && !state.checkedResponses.includes(rule.id)) state.checkedResponses.push(rule.id);
				if (check.violation) finding(event, 'API Response Defect', check.violation, rule);
				if (check.gap) { event.validationGap = check.gap; issue(check.gap); }
			})().catch(() => issue('Response validation unavailable')).finally(() => tasks.delete(task));
			tasks.add(task);
		}
		listen('requestfinished', req => finish(req, false));
		listen('requestfailed', req => finish(req, true));
		listen('framenavigated', frame => {
			if (frame !== page.mainFrame()) return;
			const event = record('navigation', page, { ...meta(), previousUrl });
			previousUrl = event.pageUrl;
		});
		listen('crash', () => issue('Browser page crashed'));
		function close() {
			cdp?.off('Network.requestWillBeSent', chromeRequest);
			cdp?.off('Runtime.exceptionThrown', chromeException);
			supplements.length = runtimeEvents.length = 0;
			initiators.length = 0;
			for (const entry of unfinished) {
				entry.event.reason = pendingReason;
				entry.event.classification = 'Inconclusive';
				entry.event.observedMs = Date.now() - entry.event.ts;
				if (entry.threshold && entry.event.observedMs > entry.threshold) entry.event.performance = {
					classification: 'Performance Observation', thresholdMs: entry.threshold, pendingMs: entry.event.observedMs
				};
				if (entry.rule) issue('Contract request was pending when observation ended');
			}
			unfinished.clear();
			inflight.clear();
			for (const [name, fn] of subscriptions) page.off(name, fn);
			subscriptions.length = 0;
		}
		listen('close', close);
		async function action({ stepId, name, ref, element, run, executed }) {
			if (active || !enabled) return run();
			const meta = { stepId: stepId || context().stepId, interactionId: randomUUID(), action: name, element: /^e?\d+$/.test(ref) ? ref : undefined };
			const matching = [];
			for (const rule of rules) {
				if (rule.control && (rule.action ?? 'click') === name && element && sameDocument(page.url(), rule.origin, rule.page) &&
					await element.evaluate((el, selector) => el.matches(selector), rule.control).catch(() => { issue('Action selector unavailable'); return false; })) matching.push(rule);
			}
			const rule = matching.length === 1 ? matching[0] : undefined;
			if (matching.length > 1) issue('Ambiguous action contracts');
			const current = { meta, rule, requests: [] };
			const event = record('interaction', page, { ...context(), ...meta, browserSessionId, contract: rule?.id });
			current.event = event;
			active = current;
			try {
				let visible = rule?.visible && page.locator(rule.visible);
				if (visible && rule.expectedText !== undefined) {
					const exactText = String(rule.expectedText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					visible = visible.filter({ hasText: new RegExp('^' + exactText + '$') });
				}
				const before = visible ? await visible.isVisible().catch(() => { issue('Initial DOM state unavailable'); return undefined; }) : undefined;
				const mutation = () => page.evaluate(() => typeof window.__qaseLastMutation === 'number' ? performance.timeOrigin + window.__qaseLastMutation : null).catch(() => null);
				const beforeMutation = rule ? await mutation() : null;
				const result = await run();
				event.executed = Boolean(executed(result));
				event.returnedAt = Date.now();
				if (!event.executed || !rule) return result;
				observed(rule);
				if (current.blocked) { event.classification = 'Expected Behavior'; event.reason = 'QASE blocked a request during the action'; return result; }
				if (!visible && !rule.destination) return result;
				event.beforeVisible = before;
				let met;
				try {
					if (visible) await visible.waitFor({ state: 'visible', timeout: rule.timeoutMs });
					if (rule.destination) await page.waitForURL(u => u.origin === rule.origin && u.pathname + u.hash === rule.destination, { timeout: rule.timeoutMs });
					met = true;
				} catch (error) {
					if (error.name !== 'TimeoutError' || page.isClosed()) { issue('Final DOM or destination observation unavailable'); return result; }
					met = false;
				}
				event.expectationMet = met;
				event.checkedAt = Date.now();
				event.expected = { visible: rule.visible, destination: rule.destination, timeoutMs: rule.timeoutMs };
				if (current.blocked) { event.classification = 'Inconclusive'; event.reason = 'QASE permissions restricted this action'; return result; }
				event.related = [...current.requests.map(r => r.id), ...(current.exception ? [current.exception.id] : [])];
				const afterMutation = await mutation();
				if (beforeMutation != null && afterMutation != null) event.mutationObserved = afterMutation > beforeMutation;
				const net = current.requests.length === 1 && !backgroundEndpoints.has(rule.id) ? current.requests[0] : undefined;
				if (!met && (current.requests.length > 1 || backgroundEndpoints.has(rule.id))) {
					event.classification = 'Inconclusive';
					event.reason = 'Repeated or background traffic prevents unique attribution';
					return result;
				}
				if (net) {
					net.association = 'matched action contract';
					if (net.endAt) event.msFromNetworkEndToCheck = Math.max(0, event.checkedAt - net.endAt);
					event.networkEvidence = [net.method, net.url, net.status && 'HTTP ' + net.status, net.durationMs != null && net.durationMs + ' ms'].filter(Boolean).join(' ');
				}
				if (current.exception) event.runtimeEvidence = current.exception.errorType + ' at ' + current.exception.stack[0]?.source;
				if (met || visible && before !== false || net?.classification === 'Expected Behavior') return result;
				// A verified API contract failure already has its own candidate. Link the UI evidence.
				await Promise.allSettled([...tasks]);
				if (net?.classification === 'API Response Defect') { net.related = [event.id]; event.reason = 'See the linked API contract defect'; return result; }
				if (current.exception) finding(event, 'Verified Runtime Defect', 'Expected UI state missing after the configured handler error', rule);
				else if (net?.state === 'finished' && net.status >= 400) finding(event, 'Verified Network Defect', 'Matched request failed and the expected UI state was missing', rule);
				else if (net && net.state === 'finished' && net.status >= 200 && net.status < 300) finding(event, 'UI and Network Mismatch', 'Matched successful response without the required visible result', rule);
				else if (rule.destination && !current.requests.length) finding(event, 'Navigation Defect', 'Verified action did not reach the approved destination', rule);
				else { event.classification = 'Inconclusive'; event.reason = 'Could not uniquely attribute the missing result'; }
				return result;
			} catch (error) {
				event.classification = 'Inconclusive';
				event.reason = 'Action or observation did not complete';
				throw error;
			} finally { active = undefined; }
		}
		const handle = { action, close, useCDP, hasStatusContract: req => Boolean(requests.get(req)?.rule?.statuses), receipt(artifactId) {
			if (active && artifactId) active.event.artifactId = artifactId;
		} };
		sessions.set(page, handle);
		return handle;
	}
	return {
		attach, policy, state, issue, enabled,
		markBlocked(request) { blocked.add(request); const action = activeRequests.get(request); if (action) action.blocked = true; },
		action(page, options) { return sessions.get(page)?.action(options) ?? options.run(); },
		async flush() { await Promise.allSettled([...tasks]); },
		snapshot() {
			return { ...state, responseContractIds, observedContracts: [...seenContracts], unobservedContracts: rules.filter(rule => !seenContracts.has(rule.id)).map(rule => rule.id),
				projectId, runId: session.id, testCaseId: session.testCaseId ?? session.testCaseSnapshot?.id,
				reason: !enabled ? 'Excluded by operator configuration' : undefined,
				status: !enabled ? 'Skipped' : !state.pages ? 'Failed' : state.issues.length || state.dropped || (rules.some(rule => !seenContracts.has(rule.id)) || responseContractIds.some(id => !state.checkedResponses.includes(id))) ? 'Partially Completed' : 'Completed' };
		}
	};
}
