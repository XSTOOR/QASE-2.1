import { createHash } from 'node:crypto';
import {
	SQA_CATALOG,
	SQA_EVIDENCE_TYPES,
	SQA_NO_CERTIFICATION_DISCLAIMER,
	SQA_TECHNICAL_CONTROL_IDS,
	resolveSqaScope,
	validateSqaCatalog
} from './sqaCatalog.js';

export const SQA_ASSESSMENT_SCHEMA_VERSION = 1;
export const SQA_ASSESSMENT_STATUSES = Object.freeze([
	'pass', 'fail', 'blocked', 'not_assessed'
]);

const SEVERITY_WEIGHT = Object.freeze({ critical: 8, high: 5, medium: 3, low: 1 });
const STATUS_RISK_FACTOR = Object.freeze({ pass: 0, fail: 1, blocked: 0.65, not_assessed: 0.35 });

function assertPlainObject(value, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object.`);
	}
}

function assertExactKeys(value, allowed, label) {
	const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
	if (unexpected.length > 0) {
		throw new TypeError(`${label} has unsupported fields: ${unexpected.join(', ')}.`);
	}
}

function normalizeText(value, label, { required = false, maximum = 2_000 } = {}) {
	if (value === undefined || value === null) {
		if (required) throw new TypeError(`${label} is required.`);
		return undefined;
	}
	if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
	const normalized = value.trim();
	if (required && !normalized) throw new TypeError(`${label} cannot be empty.`);
	if (normalized.length > maximum) throw new TypeError(`${label} cannot exceed ${maximum} characters.`);
	return normalized || undefined;
}

function normalizeTimestamp(value, label, required = false) {
	const normalized = normalizeText(value, label, { required, maximum: 32 });
	if (normalized === undefined) return undefined;
	const parsed = Date.parse(normalized);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
		throw new TypeError(`${label} must be a canonical UTC ISO timestamp.`);
	}
	return normalized;
}

function normalizeTarget(target) {
	assertPlainObject(target, 'SQA assessment target');
	assertExactKeys(target, ['name', 'release', 'environment'], 'SQA assessment target');
	return {
		name: normalizeText(target.name, 'SQA target name', { required: true, maximum: 200 }),
		release: normalizeText(target.release, 'SQA target release', { required: true, maximum: 200 }),
		environment: normalizeText(target.environment, 'SQA target environment', { required: true, maximum: 100 })
	};
}

function normalizeEvidence(item, observationIndex, evidenceIndex) {
	const label = `SQA observation ${observationIndex} evidence ${evidenceIndex}`;
	assertPlainObject(item, label);
	assertExactKeys(item, ['type', 'reference', 'summary', 'digest', 'collectedAt'], label);
	if (!SQA_EVIDENCE_TYPES.includes(item.type)) {
		throw new TypeError(`${label}.type is invalid.`);
	}
	const digest = normalizeText(item.digest, `${label}.digest`, { maximum: 80 });
	const summary = normalizeText(item.summary, `${label}.summary`, { maximum: 1_000 });
	if (digest && !/^sha256:[0-9a-f]{64}$/.test(digest)) {
		throw new TypeError(`${label}.digest must use sha256:<64 lowercase hex characters>.`);
	}
	return {
		type: item.type,
		reference: normalizeText(item.reference, `${label}.reference`, { required: true, maximum: 512 }),
		...(summary ? { summary } : {}),
		...(digest ? { digest } : {}),
		...(item.collectedAt === undefined ? {} : { collectedAt: normalizeTimestamp(item.collectedAt, `${label}.collectedAt`, true) })
	};
}

function normalizeObservation(observation, index) {
	const label = `SQA observation ${index}`;
	assertPlainObject(observation, label);
	assertExactKeys(observation, ['controlId', 'status', 'rationale', 'evidence'], label);
	const controlId = normalizeText(observation.controlId, `${label}.controlId`, { required: true, maximum: 32 });
	if (!SQA_ASSESSMENT_STATUSES.includes(observation.status)) {
		throw new TypeError(`${label}.status is invalid.`);
	}
	const evidenceItems = observation.evidence ?? [];
	if (!Array.isArray(evidenceItems) || evidenceItems.length > 100) {
		throw new TypeError(`${label}.evidence must be an array with at most 100 items.`);
	}
	const evidence = evidenceItems.map((item, evidenceIndex) => normalizeEvidence(item, index, evidenceIndex));
	const rationale = normalizeText(observation.rationale, `${label}.rationale`, { maximum: 2_000 });
	if (['fail', 'blocked'].includes(observation.status) && !rationale) {
		throw new TypeError(`${label}.rationale is required for ${observation.status}.`);
	}
	if (observation.status === 'not_assessed' && evidence.length > 0) {
		throw new TypeError(`${label} cannot attach evidence to not_assessed.`);
	}
	return {
		controlId,
		status: observation.status,
		...(rationale ? { rationale } : {}),
		evidence
	};
}

/**
 * Validate and normalize an assessment request. Unknown fields and out-of-scope
 * observations are rejected so a typo cannot silently alter an audit result.
 */
export function validateSqaAssessmentInput(input, catalog = SQA_CATALOG) {
	validateSqaCatalog(catalog);
	assertPlainObject(input, 'SQA assessment input');
	assertExactKeys(input, ['catalogVersion', 'target', 'assessedAt', 'profiles', 'attributes', 'scopeNotes', 'observations'], 'SQA assessment input');
	if (input.catalogVersion !== undefined && input.catalogVersion !== catalog.catalogVersion) {
		throw new TypeError(`SQA catalog version ${input.catalogVersion} does not match ${catalog.catalogVersion}.`);
	}
	const scope = resolveSqaScope({ profiles: input.profiles, attributes: input.attributes }, catalog);
	const observations = input.observations ?? [];
	if (!Array.isArray(observations) || observations.length > 1_000) {
		throw new TypeError('SQA assessment observations must be an array with at most 1000 items.');
	}
	const normalizedObservations = observations.map(normalizeObservation);
	const scopeNotes = normalizeText(input.scopeNotes, 'SQA scopeNotes', { maximum: 4_000 });
	const applicableIds = new Set(scope.applicableControls.map(control => control.id));
	const seen = new Set();
	for (const observation of normalizedObservations) {
		if (!applicableIds.has(observation.controlId)) {
			throw new TypeError(`SQA observation references unknown or out-of-scope control ${observation.controlId}.`);
		}
		if (seen.has(observation.controlId)) {
			throw new TypeError(`Duplicate SQA observation for ${observation.controlId}.`);
		}
		seen.add(observation.controlId);
	}
	return {
		catalogVersion: catalog.catalogVersion,
		target: normalizeTarget(input.target),
		assessedAt: normalizeTimestamp(input.assessedAt, 'SQA assessedAt', true),
		profiles: scope.profiles,
		attributes: scope.attributes,
		...(scopeNotes ? { scopeNotes } : {}),
		observations: normalizedObservations
	};
}

function canonicalize(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function percentage(numerator, denominator) {
	return denominator === 0 ? 100 : Number(((numerator / denominator) * 100).toFixed(2));
}

function evidenceCoverage(control, evidenceItems) {
	const requirements = control.evidenceRequirements.map(requirement => {
		const actual = evidenceItems.filter(item => item.type === requirement.type).length;
		return {
			id: requirement.id,
			type: requirement.type,
			minimum: requirement.minimum,
			actual,
			satisfied: actual >= requirement.minimum,
			description: requirement.description
		};
	});
	const satisfied = requirements.filter(requirement => requirement.satisfied).length;
	return {
		required: requirements.length,
		satisfied,
		percentage: percentage(satisfied, requirements.length),
		missing: requirements.filter(requirement => !requirement.satisfied).map(requirement => requirement.id),
		requirements
	};
}

function countsFor(results) {
	return SQA_ASSESSMENT_STATUSES.reduce((counts, status) => {
		counts[status] = results.filter(result => result.status === status).length;
		return counts;
	}, {});
}

function gateStatus(results) {
	if (results.some(result => result.status === 'fail')) return 'fail';
	if (results.some(result => ['blocked', 'not_assessed'].includes(result.status))) return 'blocked';
	return 'pass';
}

function calculateRisk(results) {
	const maximum = results.reduce((sum, result) => sum + SEVERITY_WEIGHT[result.severity], 0);
	const residual = results.reduce((sum, result) => (
		sum + SEVERITY_WEIGHT[result.severity] * STATUS_RISK_FACTOR[result.status]
	), 0);
	const score = percentage(residual, maximum);
	let level = 'none';
	if (results.some(result => result.severity === 'critical' && result.status === 'fail')) level = 'critical';
	else if (results.some(result => (result.severity === 'high' && result.status === 'fail') || (result.severity === 'critical' && ['blocked', 'not_assessed'].includes(result.status)))) level = 'high';
	else if (results.some(result => (result.severity === 'medium' && result.status === 'fail') || (result.severity === 'high' && ['blocked', 'not_assessed'].includes(result.status)))) level = 'medium';
	else if (results.some(result => result.status !== 'pass')) level = 'low';
	return {
		score,
		level,
		method: 'Severity-weighted unresolved-control score; fail=100%, blocked=65%, not_assessed=35%, pass=0%.',
		bySeverity: Object.fromEntries(Object.keys(SEVERITY_WEIGHT).map(severity => [severity, {
			total: results.filter(result => result.severity === severity).length,
			unresolved: results.filter(result => result.severity === severity && result.status !== 'pass').length
		}]))
	};
}

function frameworkCoverage(results, catalog) {
	return Object.values(catalog.sources)
		.map(source => {
			const mapped = results.filter(result => result.sources.includes(source.id));
			if (mapped.length === 0) return undefined;
			const counts = countsFor(mapped);
			return {
				sourceId: source.id,
				title: source.title,
				url: source.url,
				controls: mapped.length,
				status: gateStatus(mapped),
				coverage: percentage(counts.pass + counts.fail, mapped.length),
				counts
			};
		})
		.filter(Boolean);
}

function summarizeTechnicalChecks(results) {
	const technicalIds = new Set(SQA_TECHNICAL_CONTROL_IDS);
	const technicalResults = results.filter(result => technicalIds.has(result.controlId));
	const counts = countsFor(technicalResults);
	let verdict = 'not_applicable';
	if (technicalResults.length > 0) {
		if (counts.fail > 0) verdict = 'fail';
		else if (counts.blocked > 0 || counts.not_assessed > 0) verdict = 'blocked';
		else verdict = 'pass';
	}
	return {
		applicableControls: technicalResults.length,
		...counts,
		verdict,
		passed: verdict === 'pass'
	};
}

/**
 * Evaluate an evidence-backed SQA assessment. A claimed pass is converted to
 * blocked when its required evidence types are absent. Missing controls become
 * not_assessed. The overall verdict is therefore conservative and explainable.
 */
export function evaluateSqaAssessment(input, catalog = SQA_CATALOG) {
	const normalized = validateSqaAssessmentInput(input, catalog);
	const scope = resolveSqaScope({ profiles: normalized.profiles, attributes: normalized.attributes }, catalog);
	const observations = new Map(normalized.observations.map(observation => [observation.controlId, observation]));
	const results = scope.applicableControls.map(control => {
		const observation = observations.get(control.id) ?? {
			controlId: control.id, status: 'not_assessed', evidence: []
		};
		const evidence = evidenceCoverage(control, observation.evidence);
		let status = observation.status;
		const decisionNotes = [];
		if (status === 'pass' && evidence.missing.length > 0) {
			status = 'blocked';
			decisionNotes.push(`Claimed pass lacks required evidence: ${evidence.missing.join(', ')}.`);
		}
		// A failure is conclusive with one relevant artifact; it need not satisfy the
		// complete pass contract. It must, however, match at least one evidence type
		// defined for the control. Without this check, an arbitrary browser test_result
		// could fail a documentary risk, approval, or regulatory control.
		if (status === 'fail' && evidence.satisfied === 0) {
			status = 'blocked';
			decisionNotes.push(observation.evidence.length === 0
				? 'Claimed failure lacks a referenced evidence artifact.'
				: 'Claimed failure lacks evidence matching this control contract.');
		}
		return {
			controlId: control.id,
			title: control.title,
			domain: control.domain,
			severity: control.severity,
			mandatory: control.mandatory,
			automationLevel: control.automationLevel,
			status,
			claimedStatus: observation.status,
			...(observation.rationale ? { rationale: observation.rationale } : {}),
			decisionNotes,
			evidence: observation.evidence,
			evidenceCoverage: evidence,
			sources: control.sources
		};
	});

	const counts = countsFor(results);
	const mandatoryResults = results.filter(result => result.mandatory);
	const criticalResults = results.filter(result => result.severity === 'critical');
	const evidenceBlocked = results.filter(result => result.claimedStatus === 'pass' && result.status === 'blocked');
	const mandatoryStatus = gateStatus(mandatoryResults);
	const criticalStatus = gateStatus(criticalResults);
	const conclusive = counts.pass + counts.fail;
	const gates = [
		{
			id: 'mandatory_controls',
			title: 'All mandatory controls have a conclusive passing result',
			status: mandatoryStatus,
			passed: mandatoryStatus === 'pass',
			detail: `${mandatoryResults.filter(result => result.status === 'pass').length}/${mandatoryResults.length} mandatory controls passed.`
		},
		{
			id: 'critical_risk',
			title: 'No failed or unresolved critical controls',
			status: criticalStatus,
			passed: criticalStatus === 'pass',
			detail: `${criticalResults.filter(result => result.status === 'pass').length}/${criticalResults.length} critical controls passed.`
		},
		{
			id: 'evidence_completeness',
			title: 'Every claimed pass satisfies its evidence contract',
			status: evidenceBlocked.length > 0 ? 'blocked' : 'pass',
			passed: evidenceBlocked.length === 0,
			detail: evidenceBlocked.length > 0
				? `${evidenceBlocked.length} claimed pass result(s) lack required evidence.`
				: 'Every claimed pass has the required evidence types.'
		},
		{
			id: 'conclusive_coverage',
			title: 'All applicable controls have a conclusive result',
			status: conclusive === results.length ? 'pass' : 'blocked',
			passed: conclusive === results.length,
			detail: `${conclusive}/${results.length} applicable controls are pass or fail.`
		}
	];

	let verdict = 'pass';
	if (mandatoryStatus === 'fail' || criticalStatus === 'fail') verdict = 'fail';
	else if (gates.some(gate => gate.status === 'blocked')) verdict = 'blocked';

	const normalizedForId = { ...normalized, observations: [...normalized.observations].sort((a, b) => a.controlId.localeCompare(b.controlId)) };
	const assessmentSha256 = createHash('sha256').update(canonicalize(normalizedForId)).digest('hex');
	const assessmentId = `sqa-${assessmentSha256.slice(0, 24)}`;
	const requiredEvidence = results.reduce((sum, result) => sum + result.evidenceCoverage.required, 0);
	const satisfiedEvidence = results.reduce((sum, result) => sum + result.evidenceCoverage.satisfied, 0);

	return {
		schemaVersion: SQA_ASSESSMENT_SCHEMA_VERSION,
		assessmentId,
		assessmentSha256,
		catalogVersion: catalog.catalogVersion,
		assessedAt: normalized.assessedAt,
		target: normalized.target,
		profiles: normalized.profiles,
		attributes: normalized.attributes,
		...(normalized.scopeNotes ? { scopeNotes: normalized.scopeNotes } : {}),
		verdict,
		passed: verdict === 'pass',
		summary: {
			applicableControls: results.length,
			mandatoryControls: mandatoryResults.length,
			...counts
		},
		coverage: {
			observed: percentage(results.length - counts.not_assessed, results.length),
			conclusive: percentage(conclusive, results.length),
			mandatoryPassed: percentage(mandatoryResults.filter(result => result.status === 'pass').length, mandatoryResults.length),
			evidence: percentage(satisfiedEvidence, requiredEvidence),
			requiredEvidence,
			satisfiedEvidence
		},
		// The technical smoke verdict is intentionally independent from the broad
		// assurance verdict. It can conclude from sampled browser evidence while
		// documentary, lifecycle, regulatory, and certification gates remain blocked.
		technicalSummary: summarizeTechnicalChecks(results),
		risk: calculateRisk(results),
		gates,
		frameworkCoverage: frameworkCoverage(results, catalog),
		results,
		outOfScope: scope.excludedControls,
		disclaimer: catalog.disclaimer || SQA_NO_CERTIFICATION_DISCLAIMER
	};
}

function markdown(value) {
	return String(value ?? '')
		.replaceAll('\\', '\\\\')
		.replaceAll('|', '\\|')
		.replaceAll('\r', ' ')
                .replaceAll('\n', ' ');
}

const REPORT_SEVERITY_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

function compareReportPriority(left, right) {
	const statusOrder = { fail: 0, blocked: 1, not_assessed: 2, pass: 3 };
	return (statusOrder[left.status] ?? 4) - (statusOrder[right.status] ?? 4)
		|| Number(right.mandatory) - Number(left.mandatory)
		|| (REPORT_SEVERITY_ORDER[left.severity] ?? 4) - (REPORT_SEVERITY_ORDER[right.severity] ?? 4)
		|| String(left.controlId).localeCompare(String(right.controlId));
}

function reportDisposition(assessment) {
	if (assessment.verdict === 'pass') {
		return 'All deterministic decision gates passed within the declared scope. Retain the referenced evidence and use an authorized competent reviewer for any formal conformity, regulatory, audit, or certification decision.';
	}
	if (assessment.verdict === 'fail') {
		return 'One or more evidence-backed controls failed. Remediate the confirmed failures, repeat the affected tests, and re-evaluate the release before relying on this assessment for an engineering acceptance decision.';
	}
	return 'The assessment cannot reach a passing decision because evidence or testing remains incomplete. Supply the named artifacts, complete the outstanding checks, and re-run the deterministic gates; blocked is an evidence state, not proof of failure.';
}

/** Render a stable, human-readable assessment without asserting certification. */
export function buildSqaReportMarkdown(assessment) {
	assertPlainObject(assessment, 'SQA assessment report');
	if (assessment.schemaVersion !== SQA_ASSESSMENT_SCHEMA_VERSION || !Array.isArray(assessment.results)) {
		throw new TypeError('Unsupported SQA assessment report schema.');
	}
        const failures = assessment.results.filter(result => result.status === 'fail').sort(compareReportPriority);
        const blocked = assessment.results.filter(result => result.status === 'blocked').sort(compareReportPriority);
        const notAssessed = assessment.results.filter(result => result.status === 'not_assessed').sort(compareReportPriority);
        const evidenceItems = assessment.results.flatMap(result => (result.evidence ?? []).map((item, index) => ({
			controlId: result.controlId,
			index: index + 1,
			...item
		})));
        const lines = [
                `# SQA assessment — ${markdown(assessment.target?.name)}`,
                '',
                `- **Assessment:** ${markdown(assessment.assessmentId)}`,
			`- **Assessment digest:** sha256:${markdown(assessment.assessmentSha256)}`,
                `- **Release:** ${markdown(assessment.target?.release)}`,
                `- **Environment:** ${markdown(assessment.target?.environment)}`,
		`- **Assessed at:** ${markdown(assessment.assessedAt)}`,
		`- **Catalog:** ${markdown(assessment.catalogVersion)}`,
		`- **Profiles:** ${assessment.profiles.map(markdown).join(', ')}`,
		`- **Verdict:** ${String(assessment.verdict).toUpperCase()}`,
                `- **Residual risk:** ${markdown(assessment.risk?.level)} (${markdown(assessment.risk?.score)}%)`,
                '',
                '> **Important:** ' + markdown(assessment.disclaimer),
                '',
			'## Executive summary',
			'',
			`The deterministic assurance verdict is **${String(assessment.verdict).toUpperCase()}**. Of ${markdown(assessment.summary?.applicableControls)} applicable controls, ${markdown(assessment.summary?.pass)} passed, ${markdown(assessment.summary?.fail)} failed, ${markdown(assessment.summary?.blocked)} are blocked by missing evidence or prerequisites, and ${markdown(assessment.summary?.not_assessed)} were not assessed. Residual risk is **${String(assessment.risk?.level ?? 'unknown').toUpperCase()}** at ${markdown(assessment.risk?.score)}% using the documented severity-weighted unresolved-control method.`,
			'',
			`**Recommended disposition:** ${reportDisposition(assessment)}`,
			'',
			'## Assessment boundary and method',
			'',
			`- Product: ${markdown(assessment.target?.name)}`,
			`- Release and environment: ${markdown(assessment.target?.release)} · ${markdown(assessment.target?.environment)}`,
			`- Selected profiles: ${assessment.profiles.map(markdown).join(', ')}`,
			`- Declared product attributes: ${assessment.attributes?.length ? assessment.attributes.map(markdown).join(', ') : 'none declared'}`,
			`- Method: risk-ordered, non-destructive browser sampling plus deterministic evidence-contract evaluation against Qase catalog ${markdown(assessment.catalogVersion)}.`,
			...(assessment.scopeNotes ? [`- Scope notes: ${markdown(assessment.scopeNotes)}`] : []),
			'',
			'## Priority action plan',
			''
        ];
        const priorityItems = [...failures, ...blocked.filter(result => result.mandatory), ...notAssessed.filter(result => result.mandatory)]
			.sort(compareReportPriority)
			.slice(0, 12);
        if (priorityItems.length === 0) {
			lines.push('- No failed, blocked, or unassessed mandatory controls. Preserve evidence, monitor the release, and route formal assurance decisions to the authorized reviewer.');
		} else {
			for (const result of priorityItems) {
				const missing = result.evidenceCoverage?.missing?.length
					? ` Missing evidence: ${result.evidenceCoverage.missing.map(markdown).join(', ')}.`
					: '';
				const action = result.status === 'fail'
					? `Remediate and retest the evidence-backed failure. ${markdown(result.rationale ?? result.title)}`
					: result.status === 'blocked'
						? `Resolve the prerequisite or obtain authorized reviewer evidence.${missing}`
						: 'Complete the scoped check and record a defensible result.';
				lines.push(`- **${String(result.severity).toUpperCase()} · ${markdown(result.status).toUpperCase()} · ${markdown(result.controlId)} — ${markdown(result.title)}:** ${action}`);
			}
		}
        lines.push(
			'',
                '## Coverage',
                '',
		`- Observed: ${markdown(assessment.coverage?.observed)}%`,
		`- Conclusive: ${markdown(assessment.coverage?.conclusive)}%`,
		`- Mandatory passed: ${markdown(assessment.coverage?.mandatoryPassed)}%`,
		`- Evidence requirements satisfied: ${markdown(assessment.coverage?.evidence)}%`,
		'',
		'## Bounded technical smoke sample',
		'',
		`- Verdict: ${String(assessment.technicalSummary?.verdict ?? 'not_applicable').toUpperCase()}`,
		`- Applicable controls: ${markdown(assessment.technicalSummary?.applicableControls ?? 0)}`,
		`- Pass: ${markdown(assessment.technicalSummary?.pass ?? 0)}`,
		`- Fail: ${markdown(assessment.technicalSummary?.fail ?? 0)}`,
		`- Blocked: ${markdown(assessment.technicalSummary?.blocked ?? 0)}`,
		`- Not assessed: ${markdown(assessment.technicalSummary?.not_assessed ?? 0)}`,
		'',
		'> This sampled browser result does not establish whole-product compliance and does not override the broad assurance verdict.',
		'',
                '## Decision gates',
                ''
        );
	for (const gate of assessment.gates ?? []) {
		lines.push(`- **${markdown(gate.status).toUpperCase()} — ${markdown(gate.title)}:** ${markdown(gate.detail)}`);
	}
	lines.push('', '## Control results', '', '| Control | Severity | Required | Status | Evidence |', '|---|---|---:|---|---:|');
	for (const result of assessment.results) {
		lines.push(`| ${markdown(result.controlId)} — ${markdown(result.title)} | ${markdown(result.severity)} | ${result.mandatory ? 'yes' : 'no'} | ${markdown(result.status)} | ${markdown(result.evidenceCoverage?.satisfied)}/${markdown(result.evidenceCoverage?.required)} |`);
	}

        const unresolved = [...failures, ...blocked, ...notAssessed];
        if (unresolved.length > 0) {
                lines.push('', '## Detailed unresolved controls', '');
		for (const result of unresolved) {
			lines.push(`### ${markdown(result.controlId)} — ${markdown(result.title)}`, '');
			lines.push(`- **Status:** ${markdown(result.status)}`);
			lines.push(`- **Severity:** ${markdown(result.severity)}`);
			if (result.rationale) lines.push(`- **Rationale:** ${markdown(result.rationale)}`);
			if (result.decisionNotes?.length) lines.push(`- **Decision:** ${result.decisionNotes.map(markdown).join(' ')}`);
			if (result.evidenceCoverage?.missing?.length) lines.push(`- **Missing evidence:** ${result.evidenceCoverage.missing.map(markdown).join(', ')}`);
			lines.push('');
                }
        }

		lines.push('## Evidence traceability register', '');
		if (evidenceItems.length === 0) {
			lines.push('No evidence artifacts were attached to this assessment.', '');
		} else {
			lines.push('| Control | # | Type | Collected at | Reference | Digest | Summary |', '|---|---:|---|---|---|---|---|');
			for (const item of evidenceItems) {
				lines.push(`| ${markdown(item.controlId)} | ${item.index} | ${markdown(item.type)} | ${markdown(item.collectedAt ?? 'not recorded')} | ${markdown(item.reference)} | ${markdown(item.digest ?? 'not supplied')} | ${markdown(item.summary ?? '')} |`);
			}
			lines.push('');
		}

		const evidenceRequests = [...blocked, ...notAssessed].filter(result => result.evidenceCoverage?.missing?.length);
		if (evidenceRequests.length > 0) {
			lines.push('## Reviewer evidence request register', '', '| Control | Priority | State | Required evidence not yet satisfied |', '|---|---|---|---|');
			for (const result of evidenceRequests) {
				lines.push(`| ${markdown(result.controlId)} — ${markdown(result.title)} | ${markdown(result.severity)}${result.mandatory ? ' · mandatory' : ''} | ${markdown(result.status)} | ${result.evidenceCoverage.missing.map(markdown).join(', ')} |`);
			}
			lines.push('');
		}

        lines.push('## Framework crosswalk', '', '| Reference | Mapped controls | Status | Conclusive coverage |', '|---|---:|---|---:|');
	for (const framework of assessment.frameworkCoverage ?? []) {
		lines.push(`| [${markdown(framework.title)}](${framework.url}) | ${framework.controls} | ${markdown(framework.status)} | ${framework.coverage}% |`);
	}
        if (assessment.outOfScope?.length) {
                lines.push('', '## Not applicable in the declared scope', '');
                for (const item of assessment.outOfScope) lines.push(`- **${markdown(item.controlId)}:** ${markdown(item.reason)}`);
        }
		lines.push(
			'',
			'## Limitations and assurance notice',
			'',
			'- Results apply only to the declared product, release, environment, profiles, attributes, workflows, and evidence identified in this report.',
			'- Browser observations are sampled technical evidence; they do not prove whole-product behavior, source-code quality, operational effectiveness, or documentary process maturity.',
			'- A blocked control identifies missing evidence or a prerequisite. It is not automatically a product defect, and it cannot be treated as a pass.',
			'- Framework mappings are an independently authored Qase crosswalk. The cited source publications and applicable legal or regulatory requirements remain authoritative.',
			`- Final notice: ${markdown(assessment.disclaimer)}`
		);
        return lines.join('\n');
}
