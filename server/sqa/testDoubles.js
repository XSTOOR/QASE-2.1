/**
 * Test doubles for the compliance engine: a scripted OpenAI-compatible model
 * that plays the compliance analyst against the QA Lab's BrightPath education
 * site, a stub of the SDK's hosted web-search provider, and a SearXNG-shaped
 * search endpoint for runs in a separate server process. Test use only.
 */
import http from 'node:http';

const SEARCH_RESULTS = [
	{ title: 'WCAG 2.2', url: 'https://www.w3.org/TR/WCAG22/', content: 'Web Content Accessibility Guidelines 2.2' },
	{ title: 'COPPA rule', url: 'https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa', content: "Children's Online Privacy Protection Rule" },
	{ title: 'DPDP Act', url: 'https://www.meity.gov.in/data-protection-framework', content: 'Digital Personal Data Protection Act 2023' }
];

/** A SearXNG-compatible JSON endpoint; QASE_SQA_SEARCH_URL is its base URL (the SDK adds /search). */
export async function startSearchStub() {
	const queries = [];
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');
		queries.push(url.searchParams.get('q'));
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ query: url.searchParams.get('q'), results: SEARCH_RESULTS }));
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return { url: `http://127.0.0.1:${server.address().port}`, queries, close: () => new Promise(resolve => server.close(resolve)) };
}

/** An OpenAI-compatible streaming server that plays the compliance analyst. */
export async function startScriptedModel() {
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
			const finish = reason => { send({ choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 900, completion_tokens: 120 } }); response.end('data: [DONE]\n\n'); };
			const say = text => { send({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }); finish('stop'); };
			const call = (...calls) => {
				send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
				calls.forEach(([name, args], index) => send({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${log.length}_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
				finish('tool_calls');
			};
			const done = name => lastTool && calledTools.at(-1) === name && /"success":\s*true/.test(String(lastTool.content));
			if (tools.includes('sqa_record_product')) {
				if (done('sqa_record_product')) return say('Recorded the product profile.');
				return call(['sqa_record_product', { name: 'BrightPath Academy', category: 'education', subcategory: 'Online live classes for children (K-12 tutoring)', summary: 'Live online maths, coding and science classes for children aged 8–14, sold to parents.', audience: { description: 'Children aged 8–14 and their parents', children: true, students: true }, regions: ['India', 'United States'], data_handled: ['accounts', 'personal_data', 'children', 'payments'], features: ['sign-up', 'live classes', 'parent dashboard'], evidence: ['/edu/: "Fun online courses for kids aged 8–14"', '/edu/about: based in Bengaluru, India, teaching students in India and the United States'] }]);
			}
			if (tools.includes('sqa_select_frameworks')) {
				if (done('sqa_select_frameworks')) return say('Frameworks selected.');
				if (!calledTools.includes('web_search')) return call(['web_search', { query: 'children online education website compliance India United States COPPA DPDP WCAG' }]);
				return call(['sqa_select_frameworks', { frameworks: [
					{ name: 'WCAG 2.2 Level AA', publisher: 'W3C', source_url: 'https://www.w3.org/TR/WCAG22/', kind: 'accessibility', applicability: 'Public education website used by children and parents.', mandatory: true },
					{ name: 'COPPA', publisher: 'US FTC', source_url: 'https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa', kind: 'privacy', jurisdiction: 'US', applicability: 'Collects personal data from children under 13 in the US.', mandatory: true },
					{ name: 'India DPDP Act 2023', publisher: 'MeitY', source_url: 'https://www.meity.gov.in/data-protection-framework', kind: 'privacy', jurisdiction: 'India', applicability: 'Indian company processing children\'s data (Section 9 parental consent).', mandatory: true },
					{ name: 'Made-up Standard', source_url: 'https://invented.example.org/standard', applicability: 'not real', mandatory: false }
				] }]);
			}
			if (tools.includes('sqa_define_requirements')) {
				const ids = [...new Set([...userText.matchAll(/^(F\d+): /gm)].map(match => match[1]))];
				const pending = ids.filter(id => !calledTools.includes('sqa_define_requirements') || !messages.some(item => item.role === 'tool' && String(item.content).includes(`"framework"`) && messages.indexOf(item) > 0 && false));
				if (calledTools.filter(name => name === 'sqa_define_requirements').length >= ids.length) return say('All frameworks have requirements.');
				return call(...pending.map(id => ['sqa_define_requirements', { framework_id: id, requirements: id === 'F1'
					? [{ clause: '1.1.1', title: 'Images have text alternatives', check: 'Every informative image has alt text.', method: 'automated', evidence_kinds: ['a11y.images_alt'], severity: 'high' },
						{ clause: '1.4.3', title: 'Text contrast', check: 'Body text contrast is at least 4.5:1.', method: 'automated', evidence_kinds: ['a11y.contrast'], severity: 'medium' },
						{ clause: '2.4.7', title: 'Focus is visible', check: 'Keyboard focus is visible on links and buttons.', method: 'browser', severity: 'medium' }]
					: id === 'F2'
						? [{ clause: '312.4', title: 'Privacy notice covers children', check: 'The privacy policy describes what is collected from children and how parents consent.', method: 'browser', severity: 'high' },
							{ clause: '312.5', title: 'Verifiable parental consent', check: 'Records of verifiable parental consent are kept.', method: 'document', severity: 'high' },
							{ clause: '312.4(d)', title: 'Notice where data is collected', check: 'The sign-up form links the privacy notice.', method: 'automated', evidence_kinds: ['privacy.form_notice'], severity: 'medium' }]
						: [{ clause: 'Sec. 5', title: 'Notice to data principals', check: 'A privacy notice is published.', method: 'automated', evidence_kinds: ['privacy.policy_link'], severity: 'high' },
							{ clause: 'Sec. 6', title: 'Consent before tracking', check: 'No tracking before consent.', method: 'automated', evidence_kinds: ['privacy.tracking_before_consent'], severity: 'high' },
							{ clause: 'Sec. 8(10)', title: 'Grievance officer published', check: 'Contact of the grievance officer is published.', method: 'document', severity: 'medium' }] }]));
			}
			if (tools.includes('sqa_record_result')) {
				const open = [...userText.matchAll(/^(R\d+) \[(\w+)\]/gm)].map(match => ({ id: match[1], method: match[2] }));
				if (!calledTools.includes('sqa_open')) return call(['sqa_open', { url: '/edu/privacy' }]);
				if (calledTools.includes('sqa_record_result')) return say('All open requirements are recorded.');
				return call(...open.map(item => ['sqa_record_result', item.method === 'document'
					? { requirement_id: item.id, status: 'needs_documents', observed: 'Needs internal records.' }
					: /Privacy notice covers children/.test(userText.split('\n').find(line => line.startsWith(`${item.id} `)) ?? '')
						? { requirement_id: item.id, status: 'fail', observed: 'The privacy policy at /edu/privacy never mentions children, minors or parental consent.', url: '/edu/privacy', fix: 'Add a children’s privacy section with verifiable parental consent.' }
						: { requirement_id: item.id, status: 'pass', observed: 'Focus outline visible on the main links.', url: '/edu/' }]));
			}
			if (tools.includes('sqa_finish')) {
				if (done('sqa_finish')) return say('Done.');
				return call(['sqa_finish', { summary: 'BrightPath Academy, an online school for children in India and the US, was assessed against WCAG 2.2 AA, COPPA and the DPDP Act. It tracks visitors before consent and its privacy policy does not address children or parental consent.', priorities: ['Stop analytics before consent', 'Add a children’s privacy section and parental consent'] }]);
			}
			say('Nothing to do.');
		});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return { url: `http://127.0.0.1:${server.address().port}/v1`, log, close: () => new Promise(resolve => server.close(resolve)) };
}

/** Stubs the SDK's hosted search provider; everything else passes through. */
export function stubWebSearch() {
	const original = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		if (/mcp\.exa\.ai|search\.parallel\.ai/.test(String(url))) {
			const text = 'WCAG 2.2 https://www.w3.org/TR/WCAG22/\nCOPPA rule https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa\nDPDP Act https://www.meity.gov.in/data-protection-framework';
			return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
		}
		return original(url, init);
	};
	return () => { globalThis.fetch = original; };
}
