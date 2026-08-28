import { randomUUID } from 'node:crypto';
import { redact } from './secrets.js';

/**
 * The two tools the SDK's registry does not ship, because they are specific to
 * this surface: a structured way to file a defect, and a way to declare the run
 * finished with a verdict. Both are built per session so they can write
 * straight into the session the dashboard is rendering.
 */

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const MAX_LIST_ITEMS = 100;

function boundedText(value, maximum, fallback = '') {
	const text = String(value ?? fallback).trim();
	return text.length > maximum ? text.slice(0, maximum) : text;
}

function boundedList(value, maximum = 5_000) {
	return Array.isArray(value)
		? value.slice(0, MAX_LIST_ITEMS).map(item => boundedText(item, maximum)).filter(Boolean)
		: [];
}

export function createQaTools(session, runStore) {
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
				title: boundedText(input.title, 1_000),
				severity,
				category: boundedText(input.category, 200, 'general'),
				url: boundedText(input.url ?? session.targetUrl, 8_192) || undefined,
				steps: boundedList(input.steps),
				expected: boundedText(input.expected, 20_000),
				actual: boundedText(input.actual, 20_000),
				evidence: input.evidence ? boundedText(input.evidence, 20_000) : undefined
			});

			if (!finding.title) {
				return { success: false, error: 'report_finding requires a title.' };
			}

			session.findings.push(finding);
			await runStore.commit(session, 'finding', { finding });
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
				recommendations: { type: 'array', items: { type: 'string' }, description: 'What to fix or investigate first.' },
				force: { type: 'boolean', description: 'Only set to true when the user has explicitly instructed you to end the run early despite an incomplete plan. Never use this to shortcut work.' }
			},
			required: ['verdict', 'summary']
		},
		async run(input) {
			const remainingTodos = Array.isArray(session.todos)
				? session.todos.filter(item => item && item.text && item.status !== 'completed')
				: [];
			if (remainingTodos.length > 0 && input.force !== true) {
				return {
					success: false,
					error: 'finish_qa_report cannot be called until every plan item is completed. Work the remaining items, mark them completed with update_todo, then call finish_qa_report again. If a plan item genuinely cannot be executed, mark it completed with a short note explaining why it was skipped.',
					remaining_plan_items: remainingTodos.map(item => ({ text: item.text, status: item.status })),
					remaining_count: remainingTodos.length
				};
			}
			let verdict = input.verdict ?? 'pass_with_issues';
			if (verdict === 'pass' && session.findings.length > 0) verdict = 'pass_with_issues';
			if (verdict === 'pass_with_issues'
				&& session.findings.some(finding => ['critical', 'high'].includes(finding.severity))) verdict = 'fail';
			const report = redact(session.id, {
				ts: Date.now(),
				verdict,
				summary: boundedText(input.summary, 20_000),
				covered: boundedList(input.covered),
				notCovered: boundedList(input.not_covered),
				recommendations: boundedList(input.recommendations),
				targetUrl: session.targetUrl,
				findings: session.findings.length,
				bySeverity: SEVERITIES.reduce((counts, severity) => {
					counts[severity] = session.findings.filter(finding => finding.severity === severity).length;
					return counts;
				}, {})
			});

			session.report = report;
			await runStore.commit(session, 'report', { report });
			return { success: true, published: true, verdict: report.verdict, findings: report.findings };
		}
	};

	return [reportFinding, finishReport];
}
