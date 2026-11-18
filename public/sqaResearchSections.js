// Text rows are rendered using textContent, escaped HTML or literal Markdown.
export function sqaResearchSections(report) {
	if (!report) return [];
	const sources = new Map(report.references.map(row => [row.id, row]));
	const requirements = new Map(report.requirements.map(row => [row.id, row]));
	return [
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
 for (const [title, rows] of sqaResearchSections(report)) {
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
  section.append(details);
 }
 return section;
}
