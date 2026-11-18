// Text rows are rendered using textContent, escaped HTML or literal Markdown.
function observedFailure(finding) {
	let actual;
	try { actual = JSON.parse(finding.observed); } catch { /* Plain text observation. */ }
	if (actual?.kind === 'control' && actual.name === '' && actual.selector &&
		/accessible name/i.test(finding.title)) {
		return `The ${actual.tag || 'control'} ${actual.selector} has an empty accessible name.`;
	}
	return [finding.title, finding.observed].filter(Boolean).join(' · ');
}

function requirementSection(report, requirement) {
	const decisions = report.decisions.filter(d => d.requirement_ids.includes(requirement.id));
	const tests = report.tests.filter(t => requirement.testIds.includes(t.id));
	const findings = (report.findings ?? []).filter(f => requirement.testIds.includes(f.testId));
	const documents = report.documents.filter(d => d.requirementId === requirement.id);
	const rows = [];
	for (const decision of decisions) {
		const scope = decision.classification === 'RECOMMENDED' ? 'Recommended practice' :
			decision.classification.toLowerCase().replaceAll('_', ' ');
		rows.push(`Scope · ${scope}`);
	}
	if (!decisions.length) rows.push('Scope · Applicability has yet to be assessed.');
	for (const finding of findings) {
		rows.push(`Browser finding · ${observedFailure(finding)}`, `Expected · ${finding.expected}`);
		const ids = finding.evidence?.map(e => e.evidenceId) ?? [finding.evidenceId];
		rows.push(['Evidence', finding.url, ...ids].filter(Boolean).join(' · '));
	}
	if (!findings.length) {
		for (const test of tests) rows.push(`Browser check · ${test.objective} · ${test.status}`);
		if (!tests.length) rows.push('Browser evidence · No linked browser check.');
	}
	for (const doc of documents) {
		const feature = report.profile.find(f => f.id === doc.featureId);
		rows.push(['Reviewer record', feature?.name || doc.featureId, doc.determination.toLowerCase().replaceAll('_',' ')].join(' · '));
	}
	if (requirement.requirementResult === 'NOT_VERIFIABLE') {
		const featureIds = new Set(decisions.flatMap(d => d.feature_ids));
		const latest = new Map(documents.map(d => [d.featureId, d.determination]));
		const pending = [...featureIds].filter(id => !latest.has(id) || latest.get(id) === 'INSUFFICIENT');
		if (!documents.length) {
			rows.push('Reviewer question · Which product features and releases fall within the scope of this requirement?');
		} else if (pending.length) {
			const names = pending.map(id => report.profile.find(f => f.id === id)?.name || id);
			rows.push('Reviewer question · Does the supporting document also cover ' + [...new Set(names)].join(', ') + '?');
		}
		rows.push('Reviewer question · What evidence covers the rest of the requirement beyond the recorded browser checks?');
	} else rows.push(`Requirement outcome · ${requirement.requirementResult}`);
	const proofIds = new Set(findings.flatMap(f => f.evidence?.map(row => row.evidenceId) ?? [f.evidenceId]));
	const observations = tests.flatMap(t => t.observations).filter(o =>
		o.assertions.length && (!proofIds.size || proofIds.has(o.evidenceId)));
	return [`Requirement review · ${requirement.framework} · ${requirement.controlId}`, rows, observations];
}

export function sqaResearchSections(report) {
	if (!report) return [];
	const sources = new Map(report.references.map(row => [row.id, row]));
	const requirements = new Map(report.requirements.map(row => [row.id, row]));
	return [
		...report.requirements.map(r => requirementSection(report, r)),
		['Project profile', [report.targetUrl, ...report.profile.map(f => `${f.name} · ${f.kind} · ${f.location} · evidence ${f.evidenceId}`)]],
		['Applicability decisions', report.decisions.map(d => {
			const framework = d.requirement_ids.map(id => {
				const req = requirements.get(id);
				return [req?.framework, sources.get(req?.sourceId)?.version, req?.controlId].filter(Boolean).join(' ');
			});
			return [framework.join(', '),d.classification,d.obligation,d.jurisdiction,d.rationale,...d.assumptions,...(d.limitations??[])].join(' · ');
		})],
		['Requirement coverage', report.requirements.map(r => [r.framework,r.controlId,r.citationUse,r.quote,r.requirementResult,'Source '+r.sourceId,'Tests '+(r.testIds.join(', ')||'none')].filter(Boolean).join(' · '))],
		['Browser verification', report.tests.flatMap(t => [
			[t.id,t.objective,t.status,'Expected '+t.expected,...t.method,t.limitation].filter(Boolean).join(' · '),
			...t.observations.flatMap(o => o.assertions.map(a => [o.evidenceId,o.tool,o.url,a.name,a.outcome,a.actual].filter(Boolean).join(' · ')))
		])],
		['Observed failures', (report.findings??[]).map(f=>[f.testId,f.title,f.url,'Expected '+f.expected,'Observed '+f.observed,...(f.evidence?.map(row=>row.evidenceId)??[f.evidenceId])].filter(Boolean).join(' · '))],
		['Documentary evidence', report.documents.length ? report.documents.map(d => [d.requirementId,d.determination,d.documentHash].join(' · ')) : ['No reviewed organizational documents.']],
		['Research references', report.references.map(r => [r.id,r.finalUrl,r.authority,r.version??'version unknown',r.publicationDate??'publication date unknown',Number.isFinite(new Date(r.retrievedAt).getTime()) && r.retrievedAt != null ? new Date(r.retrievedAt).toISOString() : 'retrieval date unknown',r.contentHash].join(' · '))],
		['Execution metrics', [
			`${report.metrics.pagesReviewed} pages reviewed · ${report.metrics.testsWithEvidence}/${report.metrics.testsPlanned} workflows with execution evidence`,
			...(report.metrics.testsWithAssertions===undefined?[]:[`${report.metrics.testsWithAssertions} workflows with executed assertions · ${report.metrics.dispositions.passed} passed · ${report.metrics.dispositions.failed} failed · ${report.metrics.dispositions.blocked} blocked · ${report.metrics.dispositions.inconclusive} inconclusive`]),
   `Input tokens ${report.metrics.inputTokens??'unknown'} · output tokens ${report.metrics.outputTokens??'unknown'} · elapsed milliseconds ${report.metrics.elapsedMs??'unknown'} · recoveries ${report.metrics.recoveries}`
		]],
		['Assessment limitations', [...report.limitations,...report.blockers,'Browser results cover the observed samples. Organizational assurance requires separate evidence.']]
	];
}

export function researchMarkdown(report) {
	// Render source-controlled and reviewer-controlled strings as literal text.
	return sqaResearchSections(report).map(([heading, rows]) =>
		'## '+heading+'\n\n'+rows.filter(Boolean).map(row=>'    '+String(row).replace(/[\r\n\u2028\u2029]+/g,' ')).join('\n')).join('\n\n');
}

export function renderSqaResearchReport(report) {
 const section = document.createElement('section');
 section.className = 'sqa-section';
 const heading = document.createElement('h3');
 heading.textContent = 'Research and verification';
 section.append(heading);
 for (const [title, rows, observations] of sqaResearchSections(report)) {
  if (!rows.length) continue;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = title;
  const list = document.createElement('ul');
  for (const row of rows) {
   const item = document.createElement('li');
   item.textContent = row;
   list.append(item);
  }
  details.append(summary, list);
  if (observations) {
   details.open = section.children.length === 1;
   for (const observation of observations) {
    const evidence = document.createElement('details');
    const label = document.createElement('summary');
    label.textContent = 'Inspect browser evidence · ' + observation.evidenceId;
    const assertions = document.createElement('ul');
    for (const assertion of observation.assertions) {
     const item = document.createElement('li');
     item.textContent = [assertion.name, assertion.outcome, assertion.actual].join(' · ');
     assertions.append(item);
    }
    evidence.append(label, assertions);
    details.append(evidence);
   }
  }
  section.append(details);
 }
 return section;
}
