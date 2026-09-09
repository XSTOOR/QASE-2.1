import { randomUUID } from 'node:crypto';
import { redact } from './secrets.js';

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
			if (!validInput(input) || !['title', 'expected', 'actual'].every(field => hasText(input[field]))) {
				return { success: false, error: 'report_finding requires nonempty title, expected, and actual strings.' };
			}
			if (!SEVERITIES.includes(input.severity)) {
				return { success: false, error: 'report_finding requires a valid severity: critical, high, medium, low, or info.' };
			}
			const severity = input.severity;
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
				recommendations: { type: 'array', items: { type: 'string' }, description: 'What to fix or investigate first.' }
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
			const activeActivities = (session.activities ?? []).filter(activity => (
				activity.status === 'running' && activity.toolName !== 'finish_qa_report'
			));
			if (activeActivities.length > 0) {
				return { success: false, error: 'QA checks are still running. Wait for their tool results before publishing.', active_activity_ids: activeActivities.map(item => item.id) };
			}
			if (input.verdict === 'blocked') {
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
			let verdict = input.verdict;
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
