import { randomUUID } from 'node:crypto';
import { redact } from './secrets.js';
import { isEngineId } from './browserEngines.js';
import { verifyRuntimeIdentity } from './runtimeIdentity.js';

/**
 * The two tools the SDK's registry does not ship, because they are specific to
 * this surface: a structured way to file a defect, and a way to declare the run
 * finished with a verdict. Both are built per session so they can write
 * straight into the session the dashboard is rendering.
 */

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const VERDICTS = ['pass', 'pass_with_issues', 'fail', 'blocked'];
const MAX_LIST_ITEMS = 100;

function validInput(input) {
	return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function hasText(value) {
	return typeof value === 'string' && value.trim().length > 0;
}

function boundedText(value, maximum, fallback = '') {
	const text = String(value ?? fallback).trim();
	return text.length > maximum ? text.slice(0, maximum) : text;
}

function boundedList(value, maximum = 5_000) {
	return Array.isArray(value)
		? value.slice(0, MAX_LIST_ITEMS).map(item => boundedText(item, maximum)).filter(Boolean)
		: [];
}

/**
 * Phase D3 · Result integrity gate.
 *
 * Before a PASS/FAIL verdict is published, verify the run actually executed
 * against a verified device runtime. The checks, per the device-execution
 * spec: (1) test executed, (2) runtime connected, (3) device identity
 * verified, (4) browser verified, (5) OS verified, (6) required capabilities
 * available, (7) evidence belongs to this runtime session. Any failure forces
 * BLOCKED — never a silent PASS.
 *
 * REAL_DEVICE demands a full attestation. VIRTUAL_DEVICE / SIMULATED only
 * demand evidence of actual browser execution (the honest labeling still
 * applies — they are never reported as REAL DEVICE).
 */
export function runtimeIntegrity(session) {
	const facts = session?.runtimeFacts ?? null;
	const level = facts?.executionLevel ?? session?.executionLevel ?? null;
	const executed = Boolean(session?.activities ?? []).length === false
		? false
		: (session.activities ?? []).some(activity => activity.status === 'done' && String(activity.toolName ?? '').startsWith('browser_'));
	// R2 #14491: compare what the runtime OBSERVED (UA/brand/version/engine/
	// platform) against the requested selection. Any mismatch forces BLOCKED.
	const environment = session?.environmentSnapshot ?? null;
	const identity = environment || facts
		? verifyRuntimeIdentity({ runtimeFacts: facts, environment })
		: null;
	const checks = {
		executed,
		runtimeConnected: Boolean(facts || session?.deviceSessionId),
		deviceIdentityVerified: true,
		browserVerified: facts ? Boolean(facts.userAgent || facts.browser) : false,
		osVerified: facts ? Boolean(facts.os || facts.platform || session?.environmentSnapshot?.os) : false,
		capabilitiesAvailable: true,
		evidenceBelongsToSession: true,
		identityMatchesSelection: identity ? identity.ok : false
	};
	if (level === 'REAL_DEVICE') {
		const att = facts?.attestation ?? session?.attestation ?? null;
		checks.deviceIdentityVerified = Boolean(att?.device_id && att.capabilities_verified);
		checks.browserVerified = Boolean(att?.browser);
		checks.osVerified = Boolean(att?.os && att.os_version);
		checks.evidenceBelongsToSession = Boolean(att?.runtime_session_id);
	}
	const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
	const identityReason = identity && !identity.ok
		? `Runtime identity mismatch with the selected environment: ${identity.mismatches.join('; ')}.`
		: null;
	return {
		level,
		ok: failed.length === 0,
		failedChecks: failed,
		reason: identityReason ?? (failed.length ? 'Device runtime could not be verified.' : null),
		identity: identity?.identity ?? null,
		checks
	};
}

/** Attestation carried on the published report, mirroring the spec shape. */
export function attestationFor(session) {
	const facts = session?.runtimeFacts ?? null;
	const level = facts?.executionLevel ?? session?.executionLevel ?? null;
	const snap = session?.environmentSnapshot ?? {};
	return {
		execution_type: level,
		device_id: snap.deviceModelSlug ?? snap.envId ?? null,
		manufacturer: snap.platform === 'ios' || snap.platform === 'macos' ? 'Apple'
			: snap.platform === 'android' ? 'Android' : snap.platform === 'windows' ? 'Microsoft' : null,
		model: snap.device ?? null,
		os: snap.os ?? null,
		os_version: snap.osVersion ?? null,
		browser: snap.browser ?? null,
		browser_version: snap.browserVersion ?? null,
		runtime_session_id: session?.deviceSessionId ?? facts?.runtimeSessionId ?? null,
		connected_at: facts?.capturedAt ?? null,
		capabilities_verified: level === 'REAL_DEVICE'
			? Boolean(facts?.attestation?.capabilities_verified)
			: null
	};
}

export function createQaTools(session, runStore, { deviceRuntime, captureRuntimeFacts, isCancelled } = {}) {
	const reportFinding = {
		name: 'report_finding',
		description: 'Files one confirmed defect found while testing the site. Call once per distinct defect, as soon as you have confirmed it. Never include credentials or other secrets in any field.',
		category: 'qa',
		parametersSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'One line naming the defect, written from the user\'s point of view.' },
				severity: { type: 'string', enum: SEVERITIES, description: 'User impact: critical blocks the core flow, high breaks an important flow, medium is a real but survivable defect, low is polish, info is an observation.' },
				category: { type: 'string', description: 'Area of the defect, e.g. authentication, forms, navigation, console, network, accessibility, layout, performance, content.' },
				url: { type: 'string', description: 'The page URL where the defect appears.' },
				engine: { type: 'string', enum: ['chromium', 'firefox', 'webkit'], description: 'The browser engine the defect was found on. Omit on single-engine runs; always set it when the finding only reproduces on one engine.' },
				steps: { type: 'array', items: { type: 'string' }, description: 'The exact steps to reproduce, in order.' },
				expected: { type: 'string', description: 'What should have happened.' },
				actual: { type: 'string', description: 'What actually happened.' },
				evidence: { type: 'string', description: 'Supporting detail: a console error, a status code, the text of an error message.' }
			},
			required: ['title', 'severity', 'expected', 'actual']
		},
		async run(input) {
			if (!validInput(input) || !['title', 'expected', 'actual'].every(field => hasText(input[field]))) {
				return { success: false, error: 'report_finding requires nonempty title, expected, and actual strings.' };
			}
			if (!SEVERITIES.includes(input.severity)) {
				return { success: false, error: 'report_finding requires a valid severity: critical, high, medium, low, or info.' };
			}
			const severity = input.severity;
			const findingTs = Date.now();
			const finding = redact(session.id, {
				id: randomUUID(),
				ts: findingTs,
				title: boundedText(input.title, 1_000),
				severity,
				category: boundedText(input.category, 200, 'general'),
				url: boundedText(input.url ?? session.targetUrl, 8_192) || undefined,
				steps: boundedList(input.steps),
				expected: boundedText(input.expected, 20_000),
				actual: boundedText(input.actual, 20_000),
				evidence: input.evidence ? boundedText(input.evidence, 20_000) : undefined,
				engine: isEngineId(input.engine) ? input.engine : (isEngineId(session.engine) ? session.engine : undefined),
				// Every tracked bug starts open; the user moves it through the
				// lifecycle from the Bugs view.
				status: 'open',
				statusTs: findingTs,
				statusNote: ''
			});

			if (!finding.title) {
				return { success: false, error: 'report_finding requires a title.' };
			}

			const previousFindings = session.findings;
			session.findings = [...previousFindings, finding];
			try {
				await runStore.commit(session, 'finding', { finding });
			} catch (error) {
				session.findings = previousFindings;
				throw error;
			}
			return {
				success: true,
				finding_id: finding.id,
				recorded: `${severity.toUpperCase()}: ${finding.title}`,
				total_findings: session.findings.length
			};
		}
	};

const finishReport = {
	name: 'finish_qa_report',
	description: 'Ends the test run and publishes the report. Call exactly once, after every planned check is done and every defect has been filed with report_finding.',
	category: 'qa',
	parametersSchema: {
		type: 'object',
		properties: {
			verdict: { type: 'string', enum: VERDICTS, description: 'pass when nothing of substance broke, pass_with_issues when defects exist but the core flows work, fail when a core flow is broken, blocked when testing could not proceed.' },
			summary: { type: 'string', description: 'A short paragraph a product owner could read: what was tested, what state the site is in.' },
			covered: { type: 'array', items: { type: 'string' }, description: 'The areas and flows actually exercised.' },
			not_covered: { type: 'array', items: { type: 'string' }, description: 'Anything planned but skipped, and why.' },
			recommendations: { type: 'array', items: { type: 'string' }, description: 'What to fix or investigate first.' },
			security_outcomes: {
				type: 'array',
				description: 'Required when the run selected security checks. One entry per security check: pass only with concrete positive browser evidence, fail only with a filed finding, not_tested with a mandatory reason. Unavailable checks (MITM, DoS) are always not_tested with their unavailability reason.',
				items: {
					type: 'object',
					properties: {
						check: { type: 'string', enum: ['security_authentication', 'security_authorization', 'security_input_validation', 'security_sql_injection', 'security_mitm', 'security_dos'] },
						outcome: { type: 'string', enum: ['pass', 'fail', 'not_tested'] },
						reason: { type: 'string', description: 'Mandatory for not_tested; for pass/fail a one-line evidence pointer.' }
					},
					required: ['check', 'outcome']
				}
			}
		},
		required: ['verdict', 'summary']
	},
		async run(input) {
			if (session.mode === 'sqa' || session.mode === 'founder') {
				return { success: false, error: 'finish_qa_report is available only in QA mode. Use this mode\'s dedicated finalization tool.' };
			}
			if (!validInput(input) || !VERDICTS.includes(input.verdict) || !hasText(input.summary)) {
				return { success: false, error: 'finish_qa_report requires a valid verdict and a nonempty summary string.' };
			}
			for (const field of ['covered', 'not_covered', 'recommendations']) {
				if (input[field] !== undefined && (!Array.isArray(input[field]) || !input[field].every(hasText))) {
					return { success: false, error: `${field} must be an array of nonempty strings.` };
				}
			}
			// Security honesty contract: when the run selected security checks,
			// every one of them gets an explicit outcome; not_tested requires a
			// reason; unavailable checks (MITM/DoS) can never be pass/fail; a
			// pass must not contradict the findings ledger.
			const selectedSecurity = (session.selectedTests ?? []).filter(id => typeof id === 'string' && id.startsWith('security_'));
			if (selectedSecurity.length > 0) {
				const outcomes = Array.isArray(input.security_outcomes) ? input.security_outcomes : [];
				const UNAVAILABLE_REASONS = {
					security_mitm: 'Not implemented — requires an agreed, configured MITM scenario.',
					security_dos: 'Not implemented — requires an agreed, configured DoS scenario.'
				};
				const entries = new Map();
				for (const entry of outcomes) {
					if (!validInput(entry) || !selectedSecurity.includes(entry.check)
						|| !['pass', 'fail', 'not_tested'].includes(entry.outcome)) {
						return { success: false, error: 'security_outcomes entries must reference this run\'s selected security checks with an outcome of pass, fail, or not_tested.' };
					}
					if (entries.has(entry.check)) {
						return { success: false, error: `security_outcomes lists ${entry.check} more than once.` };
					}
					if (UNAVAILABLE_REASONS[entry.check] && entry.outcome !== 'not_tested') {
						return { success: false, error: `${entry.check} is not implemented and can only be not_tested with its reason.` };
					}
					if (entry.outcome === 'not_tested' && !hasText(entry.reason)) {
						return { success: false, error: `security_outcomes: ${entry.check} is not_tested and requires a reason.` };
					}
					entries.set(entry.check, entry);
				}
				const missing = selectedSecurity.filter(id => !entries.has(id));
				if (missing.length > 0) {
					return { success: false, error: `security_outcomes must include every selected security check. Missing: ${missing.join(', ')}.` };
				}
			}
			const remainingTodos = Array.isArray(session.todos)
				? session.todos.filter(item => item && item.text && item.status !== 'completed')
				: [];
			// Model-supplied flags cannot authorize skipping the host's completion gate.
			if (remainingTodos.length > 0) {
				return {
					success: false,
					error: 'finish_qa_report cannot be called until every plan item is completed. Work the remaining items, mark them completed with update_todo, then call finish_qa_report again. If a plan item genuinely cannot be executed, mark it completed with a short note explaining why it was skipped.',
					remaining_plan_items: remainingTodos.map(item => ({ text: item.text, status: item.status })),
					remaining_count: remainingTodos.length
				};
			}
			// A genuinely in-flight tool still gates publication, but an activity
			// left "running" by a crashed or restarted process can never settle —
			// so mirror the 120 s recency window the SQA and Founder finalizers
			// use instead of blocking the report forever.
			const now = Date.now();
			const activeActivities = (session.activities ?? []).filter(activity => (
				activity.status === 'running'
				&& activity.toolName !== 'finish_qa_report'
				&& Number.isFinite(Number(activity.ts))
				&& now - Number(activity.ts) < 120_000
			));
			if (activeActivities.length > 0) {
				return { success: false, error: 'QA checks are still running. Wait for their tool results before publishing.', active_activity_ids: activeActivities.map(item => item.id) };
			}
			// Phase D3 · result integrity: any failed runtime verification
			// downgrades the verdict to BLOCKED — a run whose device runtime
			// cannot be verified is never reported PASS. The downgrade happens
			// AFTER the structural gates (plan, browser evidence, coverage)
			// so a broken run still cannot publish any report at all.
			const structuralOk = (session.todos ?? []).some(item => hasText(item?.text) && item.status === 'completed')
				&& (session.activities ?? []).some(activity => activity.status === 'done' && String(activity.toolName ?? '').startsWith('browser_'))
				&& (input.covered?.length ?? 0) > 0;
			// The browser is lazy-created during the turn. Capture its live identity
			// BEFORE verifying/publishing, not only in the agent's finally block.
			if (isCancelled?.()) return { success: false, error: 'This execution was cancelled; no new report can be published.' };
			try { await captureRuntimeFacts?.(); } catch { /* Missing evidence still fails closed below. */ }
			if (isCancelled?.()) return { success: false, error: 'This execution was cancelled; no new report can be published.' };
			const integrity = runtimeIntegrity(session);
			let verdict = input.verdict;
			if (verdict !== 'blocked' && structuralOk && !integrity.ok) {
				verdict = 'blocked';
				input = {
					...input,
					not_covered: [
						...(input.not_covered ?? []),
						`Blocked: ${integrity.reason} (failed checks: ${integrity.failedChecks.join(', ')})`
					]
				};
			}
			if (verdict === 'blocked') {
				if (!input.not_covered?.length) {
					return { success: false, error: 'A blocked report must explain the unavailable checks and concrete blocking prerequisite in not_covered.' };
				}
			} else {
				if (!session.todos?.some(item => hasText(item?.text) && item.status === 'completed')) {
					return { success: false, error: 'A completed QA report requires a test plan. Create and execute the plan with update_todo before publishing.' };
				}
				if (!(session.activities ?? []).some(activity => activity.status === 'done' && String(activity.toolName ?? '').startsWith('browser_'))) {
					return { success: false, error: 'A completed QA report requires a successful browser observation from this run.' };
				}
				if (!input.covered?.length) {
					return { success: false, error: 'A completed QA report must list the areas actually exercised in covered.' };
				}
			}
			if (verdict === 'pass' && session.findings.length > 0) verdict = 'pass_with_issues';
			if (verdict === 'pass_with_issues'
				&& session.findings.some(finding => ['critical', 'high'].includes(finding.severity))) verdict = 'fail';
			const report = redact(session.id, {
				ts: Date.now(),
				verdict,
				summary: boundedText(input.summary, 20_000),
				covered: boundedList(input.covered),
				notCovered: boundedList(input.not_covered),
				// R2 #14491: runtime-authoritative identity (observed browser
				// brand/version/engine/platform) travels on every report.
				runtimeIdentity: integrity.identity ?? undefined,
				recommendations: boundedList(input.recommendations),
				targetUrl: session.targetUrl,
				findings: session.findings.length,
				securityOutcomes: Array.isArray(input.security_outcomes) && input.security_outcomes.every(validInput)
					? input.security_outcomes.map(entry => ({
						check: entry.check,
						outcome: entry.outcome,
						...(hasText(entry.reason) ? { reason: boundedText(entry.reason, 2_000) } : {})
					}))
					: undefined,
				attestation: attestationFor(session),
				bySeverity: SEVERITIES.reduce((counts, severity) => {
					counts[severity] = session.findings.filter(finding => finding.severity === severity).length;
					return counts;
				}, {})
			});

			const previousReport = session.report;
			session.report = report;
			try {
				await runStore.commit(session, 'report', { report });
			} catch (error) {
				if (previousReport === undefined) delete session.report;
				else session.report = previousReport;
				throw error;
			}
			return { success: true, published: true, verdict: report.verdict, findings: report.findings };
		}
	};

	return [reportFinding, finishReport];
}
