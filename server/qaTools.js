import { randomUUID } from 'node:crypto';
import { emit } from './store.js';
import { redact } from './secrets.js';

/**
 * The two tools the SDK's registry does not ship, because they are specific to
 * this surface: a structured way to file a defect, and a way to declare the run
 * finished with a verdict. Both are built per session so they can write
 * straight into the session the dashboard is rendering.
 */

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

export function createQaTools(session) {
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
				steps: { type: 'array', items: { type: 'string' }, description: 'The exact steps to reproduce, in order.' },
				expected: { type: 'string', description: 'What should have happened.' },
				actual: { type: 'string', description: 'What actually happened.' },
				evidence: { type: 'string', description: 'Supporting detail: a console error, a status code, the text of an error message.' }
			},
			required: ['title', 'severity', 'expected', 'actual']
		},
		async run(input) {
			const severity = SEVERITIES.includes(input.severity) ? input.severity : 'medium';
			const finding = redact(session.id, {
				id: randomUUID(),
				ts: Date.now(),
				title: String(input.title ?? '').trim(),
				severity,
				category: String(input.category ?? 'general').trim(),
				url: input.url ?? session.targetUrl,
				steps: Array.isArray(input.steps) ? input.steps.map(String) : [],
				expected: String(input.expected ?? '').trim(),
				actual: String(input.actual ?? '').trim(),
				evidence: input.evidence ? String(input.evidence) : undefined
			});

			if (!finding.title) {
				return { success: false, error: 'report_finding requires a title.' };
			}

			session.findings.push(finding);
			emit(session, 'finding', { finding });
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
				verdict: { type: 'string', enum: ['pass', 'pass_with_issues', 'fail', 'blocked'], description: 'pass when nothing of substance broke, pass_with_issues when defects exist but the core flows work, fail when a core flow is broken, blocked when testing could not proceed.' },
				summary: { type: 'string', description: 'A short paragraph a product owner could read: what was tested, what state the site is in.' },
				covered: { type: 'array', items: { type: 'string' }, description: 'The areas and flows actually exercised.' },
				not_covered: { type: 'array', items: { type: 'string' }, description: 'Anything planned but skipped, and why.' },
				recommendations: { type: 'array', items: { type: 'string' }, description: 'What to fix or investigate first.' }
			},
			required: ['verdict', 'summary']
		},
		async run(input) {
			const report = redact(session.id, {
				ts: Date.now(),
				verdict: input.verdict ?? 'pass_with_issues',
				summary: String(input.summary ?? '').trim(),
				covered: Array.isArray(input.covered) ? input.covered.map(String) : [],
				notCovered: Array.isArray(input.not_covered) ? input.not_covered.map(String) : [],
				recommendations: Array.isArray(input.recommendations) ? input.recommendations.map(String) : [],
				targetUrl: session.targetUrl,
				findings: session.findings.length,
				bySeverity: SEVERITIES.reduce((counts, severity) => {
					counts[severity] = session.findings.filter(finding => finding.severity === severity).length;
					return counts;
				}, {})
			});

			session.report = report;
			emit(session, 'report', { report });
			return { success: true, published: true, verdict: report.verdict, findings: report.findings };
		}
	};

	return [reportFinding, finishReport];
}
