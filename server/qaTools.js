import { randomUUID } from 'node:crypto';
import { redact } from './secrets.js';
import { isEngineId } from './browserEngines.js';
import { verifyRuntimeIdentity } from './runtimeIdentity.js';
import {modeDiscoveryRequired,validateModeFinding} from './modeDiscovery.js';

/**
 * report_finding: the structured defect tool used by SQA (QA mode runs on the
 * QA engine in server/qa/). Also exports the runtime-integrity helpers used
 * when reconciling historical QA reports.
 */

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
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

export function createQaTools(session, runStore) {
	const reportFinding = {
		name: 'report_finding',
		description: 'Files one confirmed defect found while testing the site. Call once per distinct defect, as soon as you have confirmed it. Never include credentials or other secrets in any field.',
		category: 'qa',
		parametersSchema: {
			type: 'object',
			properties: {
				...(modeDiscoveryRequired(session)?{mode_evidence_id:{type:'string',description:'Intact receipt ID containing the actual failed host assertion.'},assertion_name:{type:'string',description:'Exact failed assertion name in that receipt.'}}:{}),
				title: { type: 'string', description: 'One line naming the defect, written from the user\'s point of view.' },
				severity: { type: 'string', enum: SEVERITIES, description: 'User impact: critical blocks the core flow, high breaks an important flow, medium is a real but survivable defect, low is polish, info is an observation.' },
				category: { type: 'string', description: 'Area of the defect, e.g. authentication, forms, navigation, console, network, accessibility, layout, performance, content.' },
				url: { type: 'string', description: 'The page URL where the defect appears.' },
				engine: { type: 'string', enum: ['chromium', 'firefox', 'webkit'], description: 'The browser engine the defect was found on. Omit on single-engine runs; always set it when the finding only reproduces on one engine.' },
				steps: { type: 'array', items: { type: 'string' }, description: 'The exact steps to reproduce, in order.' },
				expected: { type: 'string', description: 'What should have happened.' },
				actual: { type: 'string', description: 'What actually happened.' },
				evidence: { type: 'string', description: 'Supporting detail: a console error, a status code, the text of an error message.' },
				control_ids: {
					type: 'array', maxItems: 12, items: { type: 'string' },
					description: 'SQA mode only: every scoped control whose objective this confirmed defect disproves. Required for SQA findings; each linked control must be recorded as fail.'
				}
			},
			required: ['title', 'severity', 'expected', 'actual']
		},
		async run(input) {
			if(modeDiscoveryRequired(session)){
				try{const binding=validateModeFinding(session,input||{});const existing=session.findings.find(f=>f.evidence===binding.evidence);if(existing)return {success:true,finding_id:existing.id,total_findings:session.findings.length};input={...input,...binding};}
				catch(error){return {success:false,error:error.message};}
			}
			if (!validInput(input) || !['title', 'expected', 'actual'].every(field => hasText(input[field]))) {
				return { success: false, error: 'report_finding requires nonempty title, expected, and actual strings.' };
			}
			if (!SEVERITIES.includes(input.severity)) {
				return { success: false, error: 'report_finding requires a valid severity: critical, high, medium, low, or info.' };
			}
			let controlIds;
			if (session.mode === 'sqa') {
				if (!Array.isArray(input.control_ids) || input.control_ids.length === 0 || input.control_ids.length > 12) {
					return { success: false, error: 'SQA report_finding requires 1-12 scoped control_ids whose objective the defect disproves.' };
				}
				controlIds = [...new Set(input.control_ids)];
				if (controlIds.length !== input.control_ids.length || controlIds.some(controlId => (
					typeof controlId !== 'string' || !session.sqa?.scope?.applicableControlIds?.includes(controlId)
				))) {
					return { success: false, error: 'SQA finding control_ids must be unique control IDs in this assessment scope.' };
				}
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
				...(controlIds ? { controlIds } : {}),
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
				...(controlIds ? { control_ids: controlIds } : {}),
				total_findings: session.findings.length
			};
		}
	};

	return [reportFinding];
}
