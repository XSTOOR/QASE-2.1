/**
 * Test doubles for the Founder engine: a scripted OpenAI-compatible model that
 * plays the founder/product strategist against the QA Lab's Taskly startup
 * site, and the competitor search results it finds. Test use only.
 */
import http from 'node:http';

export const COMPETITOR_RESULTS = [
	{ title: 'Asana — manage your team’s work', url: 'https://asana.com/', content: 'Work management platform for teams. Free plan available.' },
	{ title: 'Trello — boards for teams', url: 'https://trello.com/', content: 'Kanban boards. Free, Standard $5/user/month.' },
	{ title: 'Best project management tools for agencies 2026', url: 'https://www.example-review.com/agency-pm-tools', content: 'Asana, Trello, Teamwork, Monday compared for agencies.' }
];

/** An OpenAI-compatible streaming server that plays the founder reviewer. */
export async function startFounderModel() {
	const log = [];
	const server = http.createServer((request, response) => {
		let raw = '';
		request.on('data', chunk => { raw += chunk; });
		request.on('end', () => {
			const body = JSON.parse(raw || '{}');
			const tools = (body.tools ?? []).map(item => item.function?.name);
			const messages = body.messages ?? [];
			const userText = messages.filter(item => item.role === 'user').map(item => typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).join('\n');
			const calledTools = messages.filter(item => item.role === 'assistant').flatMap(item => item.tool_calls ?? []).map(call => call.function?.name);
			const lastTool = messages.at(-1)?.role === 'tool' ? messages.at(-1) : undefined;
			log.push({ tools, called: calledTools, last: lastTool ? String(lastTool.content).slice(0, 300) : messages.at(-1)?.role });
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			const send = data => response.write(`data: ${JSON.stringify(data)}\n\n`);
			const finish = reason => { send({ choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 1100, completion_tokens: 160 } }); response.end('data: [DONE]\n\n'); };
			const say = text => { send({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }); finish('stop'); };
			const call = (...calls) => {
				send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
				calls.forEach(([name, args], index) => send({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${log.length}_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
				finish('tool_calls');
			};
			const done = name => lastTool && calledTools.at(-1) === name && /"success":\s*true/.test(String(lastTool.content));
			const signal = kind => (userText.match(new RegExp(`(S\\d+) \\[\\w+\\] [^\\n]*`, 'g')) ?? []).find(line => line.includes(kind))?.split(' ')[0] ?? 'S1';
			if (tools.includes('founder_record_business')) {
				if (done('founder_record_business')) return say('Recorded the business profile.');
				return call(['founder_record_business', { name: 'Taskly', category: 'saas', one_liner: 'Task and project management for small agencies, with boards, recurring tasks and time tracking.', value_proposition: 'The future of work, reimagined for the next generation of ambitious modern teams everywhere', target_customer: { stated: '', inferred: 'Small agencies (2–20 people) planning client work' }, business_model: 'free_trial', primary_goal: 'sign_up', stage: 'early', journeys: [{ name: 'Understand the offer from the home page', goal: 'Know what Taskly is and why to choose it within 10 seconds' }, { name: 'Compare plans and pricing', goal: 'Find out what it costs' }, { name: 'Sign up for the free trial', goal: 'Create an account and reach the first board' }], evidence: ['/saas/: headline "The future of work, reimagined…"', '/saas/features: "helps small agencies plan client work"', '/saas/: "Start your 14-day free trial"'] }]);
			}
			if (tools.includes('founder_record_market')) {
				if (done('founder_record_market')) return say('Market recorded.');
				if (!calledTools.includes('web_search')) return call(['web_search', { query: 'project management for small agencies alternatives 2026' }]);
				return call(['founder_record_market', { competitors: [
					{ name: 'Asana', url: 'https://asana.com/', positioning: 'Work management for teams of every size', pricing: 'Free plan; paid from $10.99/user/month', strengths: ['brand trust', 'integrations', 'templates'], source_url: 'https://asana.com/' },
					{ name: 'Trello', url: 'https://trello.com/', positioning: 'Simple boards for any project', pricing: 'Free; Standard $5/user/month', strengths: ['simplicity', 'free plan'], source_url: 'https://www.example-review.com/agency-pm-tools' },
					{ name: 'Invented Tasks', url: 'https://invented-tasks.example/', positioning: 'Made up', source_url: 'https://nowhere.example/' }
				], expectations: ['Free plan or trial without a card', 'Templates for client projects', 'Slack and calendar integrations', 'Visible pricing per seat'], differentiation: ['Built only for agencies: client portals and billable time', 'Calmer, simpler than Asana'] }]);
			}
			if (tools.includes('founder_record_journey')) {
				const open = [...userText.matchAll(/^(J\d+): ([^—\n]+)/gm)].map(match => ({ id: match[1], name: match[2].trim() }));
				if (!calledTools.includes('founder_open')) return call(['founder_open', { url: '/saas/' }]);
				if (calledTools.includes('founder_record_journey')) return say('All journeys recorded.');
				return call(...open.map(item => ['founder_record_journey', /pricing/i.test(item.name)
					? { journey_id: item.id, outcome: 'blocked', steps: ['Clicked "Pricing" in the navigation', 'Got a 404 page'], friction: [{ issue: 'The Pricing link leads to a 404 page; no prices anywhere', severity: 'critical', page: '/saas/pricing', impact: 'Visitors who want to know the cost leave' }], summary: 'Could not find any pricing; the Pricing link is broken.' }
					: /sign ?up|trial/i.test(item.name)
						? { journey_id: item.id, outcome: 'partial', steps: ['Scrolled far down the home page to find "Start free trial"', 'Opened the sign-up form', 'Counted nine required fields including phone and company size'], friction: [{ issue: 'Nine required fields including a phone number', severity: 'high', page: '/saas/signup', impact: 'Sign-up drop-off' }, { issue: 'No Google sign-in', severity: 'medium', page: '/saas/signup' }], delights: ['A 14-day free trial is offered'], summary: 'The trial exists but is hard to find and the form is long.' }
						: { journey_id: item.id, outcome: 'partial', steps: ['Read the hero headline', 'Scrolled; no button on the first screen', 'Found what it does only on /saas/features'], friction: [{ issue: 'The headline does not say what Taskly does or for whom', severity: 'high', page: '/saas/', impact: 'Visitors bounce before understanding the product' }], delights: ['The features page is clear and specific'], summary: 'The home page does not explain the product; the features page does.' }]));
			}
			if (tools.includes('founder_score_lens')) {
				const scored = messages.filter(item => item.role === 'assistant').flatMap(item => item.tool_calls ?? []).filter(call => call.function?.name === 'founder_score_lens').map(call => { try { return JSON.parse(call.function.arguments).lens; } catch { return undefined; } });
				const lenses = [...new Set([...userText.matchAll(/(?:^|not scored yet: |, )(value_prop|trust|onboarding|conversion|experience|mobile|performance|discoverability|retention|positioning)(?=: |,|\.)/gm)].map(match => match[1]))].filter(lens => !scored.includes(lens));
				if (!lenses.length) return say('All areas scored.');
				const score = { value_prop: 3, trust: 4, onboarding: 4, conversion: 3, experience: 7, mobile: 4, performance: 8, discoverability: 2, retention: 2, positioning: 5 };
				const evidence = { value_prop: [signal('Clear headline'), 'J1'], trust: [signal('social proof')], onboarding: [signal('Short sign-up'), 'J3'], conversion: [signal('Pricing is easy'), 'J2'], experience: [signal('visual defects')], mobile: [signal('phone screen')], performance: [signal('Fast first load')], discoverability: [signal('Search title')], retention: [signal('Reasons to stay')], positioning: ['C1', 'C2'] };
				return call(...lenses.map(lens => ['founder_score_lens', { lens, score: score[lens], verdict: `Scripted verdict for ${lens}.`, strengths: lens === 'experience' ? ['Clean features page'] : [], weaknesses: lens === 'value_prop' ? ['Vague headline, no first-screen CTA'] : [], evidence: evidence[lens] }]));
			}
			if (tools.includes('founder_record_recommendations')) {
				if (done('founder_record_recommendations')) return say('Recommendations recorded.');
				return call(['founder_record_recommendations', { recommendations: [
					{ title: 'Rewrite the hero headline to "Plan client work and hit every deadline — built for small agencies"', lens: 'value_prop', kind: 'do', priority: 'now', impact: 'high', effort: 'small', why: 'Visitors cannot tell what Taskly does; competitors (Asana, Trello) state it in 6 words.', how: ['Replace the H1 with the outcome and audience', 'Add a sub-headline naming boards, recurring tasks and time tracking'], metric: 'Home-page bounce rate', acceptance: ['The headline names the customer and the outcome'], evidence: [signal('Clear headline'), 'J1', 'C1'] },
					{ title: 'Put "Start free trial" on the first screen', lens: 'value_prop', kind: 'do', priority: 'now', impact: 'high', effort: 'small', why: 'The only call to action is three screens down.', how: ['Add a primary button under the headline on desktop and mobile'], metric: 'Visitor-to-trial rate', evidence: [signal('Primary call to action visible'), signal('first mobile screen')] },
					{ title: 'Publish a pricing page and fix the broken Pricing link', lens: 'conversion', kind: 'do', priority: 'now', impact: 'high', effort: 'medium', why: 'The Pricing link is a 404; Trello and Asana show per-seat prices.', how: ['Create /pricing with 2–3 plans', 'Link it from the navigation'], metric: 'Pricing-page to trial rate', evidence: [signal('Pricing is easy'), 'J2', 'C2'] },
					{ title: "Don't ask for a phone number, company size or role at sign-up", lens: 'onboarding', kind: 'avoid', priority: 'now', impact: 'high', effort: 'small', why: 'Nine required fields cut trial starts; ask after the first board is created.', how: ['Keep email and password only', 'Add Google sign-in'], metric: 'Sign-up completion rate', evidence: [signal('Short sign-up'), 'J3'] },
					{ title: 'Add social proof from agencies', lens: 'trust', kind: 'do', priority: 'next', impact: 'medium', effort: 'medium', why: 'There is no proof anyone uses Taskly.', how: ['Add three agency testimonials with names and logos'], evidence: [signal('social proof')] },
					{ title: 'Fix the phone layout that scrolls sideways', lens: 'mobile', kind: 'do', priority: 'next', impact: 'medium', effort: 'small', why: 'A 900px banner breaks the phone layout.', how: ['Make the banner width 100%'], evidence: [signal('phone screen')] },
					{ title: 'Add a title and meta description', lens: 'discoverability', kind: 'do', priority: 'later', impact: 'low', effort: 'small', why: 'Search results show only "Taskly".', how: ['Write a 55-character title and a 150-character description'], evidence: [signal('Search title')] },
					{ title: 'Launch a big ad campaign', lens: 'conversion', kind: 'do', priority: 'now', impact: 'high', effort: 'large', why: 'No evidence for this one.', how: ['Spend money'], evidence: [] }
				], keep: [{ title: 'The specific features page', why: 'It explains the product better than the home page.', evidence: ['J1'] }] }]);
			}
			if (tools.includes('founder_finish')) {
				if (done('founder_finish')) return say('Done.');
				return call(['founder_finish', { summary: 'Taskly has a solid, focused product for small agencies, but its home page does not say so: a vague headline, no call to action on the first screen, a broken pricing link and a nine-field sign-up will lose most visitors before they try it.', positioning: 'Taskly helps small agencies plan client work and hit deadlines, without the complexity of Asana.', headline_options: ['Plan client work and hit every deadline', 'Project management built for small agencies'] }]);
			}
			say('Nothing to do.');
		});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return { url: `http://127.0.0.1:${server.address().port}/v1`, log, close: () => new Promise(resolve => server.close(resolve)) };
}
