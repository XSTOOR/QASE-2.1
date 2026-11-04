let fieldSequence = 0;

function node(tag, text, className) {
	const element = document.createElement(tag);
	if (text) element.textContent = text;
	if (className) element.className = className;
	return element;
}

export function compareSqaVersions(before, after) {
	const prior = new Map((before.results ?? []).map(item => [item.controlId, item]));
	return (after.results ?? []).flatMap(item => {
		const old = prior.get(item.controlId);
		return JSON.stringify([old?.status, old?.rationale, old?.evidence]) === JSON.stringify([item.status, item.rationale, item.evidence])
			? [] : [{ controlId: item.controlId, before: old?.status ?? 'outside scope', after: item.status, evidenceChanged: JSON.stringify(old?.evidence) !== JSON.stringify(item.evidence), reasonChanged: old?.rationale !== item.rationale }];
	});
}

export function renderSqaReviewPanel({ session, role, api, refresh, selectRun, downloadMarkdown }) {
	const sqa = session.sqa;
	const section = node('section', '', 'sqa-section sqa-review-panel');
	section.setAttribute('aria-label', 'Human evidence review');
	section.append(node('h3', 'Human evidence review'));
	const status = { requested: 'Review requested', in_review: 'Review draft — unpublished', published: 'Reviewed version published' }[sqa.review?.status];
	section.append(node('p', status ?? 'Request a reviewer to resolve documentary evidence gaps.'));
	if (sqa.review?.reason) section.append(node('p', sqa.review.reason));
	const message = node('p');
	message.setAttribute('role', 'status');
	message.setAttribute('aria-live', 'polite');
	section.append(message);
	const prefix = `/sessions/${session.id}/sqa`;
	const reviewer = ['owner', 'admin'].includes(role);
	const idle = !['running', 'queued', 'awaiting_input'].includes(session.status);
	const revision = sqa.reviewRevision ?? 0;
	section.dataset.reviewRevision = revision;
	const button = (label, work, parent = section) => {
		const item = node('button', label, 'btn btn-ghost btn-sm');
		item.type = 'button';
		item.onclick = async () => {
			item.disabled = true;
			message.textContent = '';
			try { await work(); } catch (error) { message.textContent = error.message; }
			finally { item.disabled = false; }
		};
		parent.append(item);
		return item;
	};
	const field = (parent, label, tag = 'input') => {
		const wrap = node('label', '', 'sqa-review-field');
		const caption = node('span', label);
		caption.id = `sqa-review-label-${++fieldSequence}`;
		wrap.append(caption);
		const control = node(tag);
		control.setAttribute('aria-labelledby', caption.id);
		if (tag === 'input') control.type = 'text';
		wrap.append(control);
		parent.append(wrap);
		return control;
	};
	const change = async (action, reason) => {
		const response = await api(`${prefix}/review/${action}`, { method: 'POST', body: JSON.stringify({ expectedRevision: revision, reason }) });
		await refresh(response.sqa);
	};
	if (idle && sqa.finalizedAt && sqa.assessment) {
		const form = node('form', '', 'sqa-review-form');
		const reason = field(form, 'Review request or reopening reason', 'textarea');
		reason.required = true;
		reason.maxLength = 2000;
		if (sqa.review?.status !== 'requested') button('Request review', async () => { if (form.reportValidity()) await change('request', reason.value); }, form);
		if (reviewer) button('Open review draft', async () => { if (form.reportValidity()) await change('reopen', reason.value); }, form);
		form.onsubmit = event => event.preventDefault();
		section.append(form);
	}
	if (idle && reviewer && sqa.review?.status === 'in_review' && !sqa.finalizedAt) {
		const form = node('form', '', 'sqa-review-form');
		form.append(node('h4', 'Record a control decision'));
		const controls = field(form, 'Control', 'select');
		for (const result of sqa.assessment?.results ?? []) {
			const option = node('option', `${result.controlId} — ${result.title}`);
			option.value = result.controlId;
			controls.append(option);
		}
		const decision = field(form, 'Decision', 'select');
		for (const value of ['blocked', 'pass', 'fail']) { const option = node('option', value); option.value = value; decision.append(option); }
		const rationale = field(form, 'Reason for this decision', 'textarea');
		rationale.required = true;
		rationale.maxLength = 2000;
		const evidence = node('div', '', 'sqa-review-evidence');
		let evidenceInputs = [];
		const syncEvidenceRequired = () => {
			for (const item of evidenceInputs) item.reference.required = decision.value === 'pass';
		};
		decision.onchange = syncEvidenceRequired;
		const paintEvidence = () => {
			evidence.replaceChildren(node('p', 'Reference documents you have reviewed for this release. Documents remain in their source system.'));
			evidenceInputs = [];
			const result = sqa.assessment.results.find(item => item.controlId === controls.value);
			rationale.value = result?.rationale ?? '';
			for (const requirement of result?.evidenceCoverage?.requirements ?? []) {
				for (let index = 0; index < requirement.minimum; index++) {
					const row = node('fieldset');
					row.append(node('legend', requirement.type.replaceAll('_', ' ')));
					const reference = field(row, 'Document reference or URL'); reference.maxLength = 512;
					const summary = field(row, 'What this evidence demonstrates', 'textarea'); summary.maxLength = 1000;
					const digest = field(row, 'SHA-256 digest (optional)'); digest.pattern = 'sha256:[a-f0-9]{64}';
					const existing = (result.evidence ?? []).filter(item => item.type === requirement.type)[index];
					if (existing) { reference.value = existing.reference; summary.value = existing.summary ?? ''; digest.value = existing.digest ?? ''; }
					evidenceInputs.push({ type: requirement.type, reference, summary, digest });
					evidence.append(row);
				}
			}
			syncEvidenceRequired();
		};
		controls.onchange = paintEvidence;
		paintEvidence();
		form.append(evidence);
		button('Save control decision', async () => {
			if (!form.reportValidity()) return;
			const items = evidenceInputs.filter(item => item.reference.value.trim()).map(item => ({ type: item.type, reference: item.reference.value.trim(), summary: item.summary.value.trim(), collectedAt: new Date().toISOString(), ...(item.digest.value.trim() ? { digest: item.digest.value.trim() } : {}) }));
			const result = await api(`${prefix}/observations`, { method: 'POST', body: JSON.stringify({ expectedRevision: revision, observation: { controlId: controls.value, status: decision.value, rationale: rationale.value, evidence: items } }) });
			await refresh(result.sqa);
		}, form);
		form.onsubmit = event => event.preventDefault();
		section.append(form);
		const publication = node('form', '', 'sqa-review-form');
		const reason = field(publication, 'Publication reason', 'textarea'); reason.required = true; reason.maxLength = 2000;
		button('Publish reviewed version', async () => { if (publication.reportValidity()) await change('publish', reason.value); }, publication);
		publication.onsubmit = event => event.preventDefault();
		section.append(publication);
	}
	if (reviewer) {
		const inbox = node('details'); inbox.append(node('summary', 'Review inbox'));
		const rows = node('div');
		button('Refresh review inbox', async () => {
			const result = await api('/sqa/reviews');
			rows.replaceChildren(node('p', 'Requests from the 100 most recent runs you can access.'));
			for (const review of result.reviews) button(`${review.title} — ${review.review.status.replaceAll('_', ' ')}`, () => selectRun(review.id), rows);
			if (!result.reviews.length) rows.append(node('p', 'No pending reviews.'));
		}, inbox);
		inbox.append(rows); section.append(inbox);
	}
	const history = node('details'); history.append(node('summary', 'Published versions'));
	const list = node('div');
	button('Load published versions', async () => {
		const result = await api(`${prefix}/versions`);
		list.replaceChildren();
		for (const version of result.versions) {
			const row = node('div', '', 'sqa-review-version');
			row.append(node('p', `Version ${version.version} — ${version.verdict} — ${version.publishedAt}`));
			button('Download this version', () => downloadMarkdown(`${prefix.replace('/sqa', '')}/report.md?version=${version.version}`, `sqa-version-${version.version}.md`), row);
			button('Compare with current assessment', async () => {
				const prior = await api(`${prefix}/versions/${version.version}`);
				const diff = node('ul');
				const changes = compareSqaVersions(prior.assessment, sqa.assessment ?? prior.assessment);
				for (const change of changes) diff.append(node('li', `${change.controlId}: ${change.before} → ${change.after}${change.evidenceChanged ? ' (evidence changed)' : ''}${change.reasonChanged ? ' (reason changed)' : ''}`));
				if (!changes.length) diff.append(node('li', 'No control, reason, or evidence changes.'));
				row.querySelector('ul')?.remove(); row.append(diff);
			}, row);
			list.append(row);
		}
		if (!result.versions.length) list.append(node('p', 'No published assessment yet.'));
	}, history);
	history.append(list); section.append(history);
	return section;
}
