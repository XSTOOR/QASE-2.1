import { isSqaInternalEvidence, isSqaPartialReleaseEvidence } from './sqaEvidencePolicy.js';
import { sqaMissingEvidenceRequirements } from './sqaPresentation.js';

let fieldSequence = 0;
const managed = item => String(item?.reference).startsWith('qase-review://');
const forTarget = (item, target) => (!target?.release || target.release === item.release)
	&& (!target?.environment || target.environment === item.environment);

async function filePayload(file) {
	if (!file || file.size < 1 || file.size > 512 * 1024) throw new Error('Choose a nonempty PDF, text, or Markdown file up to 512 KB.');
	const base64 = await new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error('Could not read the selected file.'));
		reader.onload = () => resolve(String(reader.result).split(',')[1]);
		reader.readAsDataURL(file);
	});
	return { name: file.name, base64 };
}

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

export function renderSqaReviewPanel({ session, role, api, refresh, selectRun, downloadMarkdown, selectedControlId, onSelectControl }) {
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
	if (sqa.execution?.strategy === 'sqa-single-reasoner-v1') {
		button('Download research progress', () => downloadMarkdown(prefix + '/research-progress?format=md', 'sqa-research-progress.md'));
		if (reviewer && idle && !sqa.finalizedAt && sqa.execution.research?.requirements?.length) {
			const panel = node('details');
			panel.append(node('summary','Review applicability evidence'));
			section.append(panel);
			const form = node('form', '', 'sqa-review-form');
			panel.append(form);
			const select = (title, options) => {
				const control = field(form, title, 'select');
				for (const [value,label] of options) {
					const option = node('option', label); option.value = value; control.append(option);
				}
				control.required = true;
				return control;
			};
			const requirement = select('Researched requirement', sqa.execution.research.requirements.map(r => [r.id, r.framework + ' · ' + r.controlId]));
			const feature = select('Observed project feature', []);
			panel.ontoggle = async () => {
				if (!panel.open || feature.options.length) return;
				try {
					const {research} = await api(prefix + '/research-progress');
					for (const f of research.profile) {
						const option = node('option', f.name + ' · ' + f.location); option.value = f.id; feature.append(option);
					}
				} catch (error) { message.textContent = error.message; }
			};
			const obligation = select('Obligation', [['contractual','Contractual'],['legal','Legal'],['certification','Certification requirement'],['recommended_practice','Recommended practice']]);
			const determination = select('Document supports', [['INSUFFICIENT','Insufficient evidence'],['CONFIRMED_APPLICABLE','Applicability'],['NOT_APPLICABLE','Exclusion']]);
			const jurisdiction = field(form, 'Jurisdiction or contractual scope'); jurisdiction.required=true; jurisdiction.maxLength=120;
			const file = field(form, 'Reviewed document (plain text, up to 128 KB)'); file.type='file'; file.accept='.txt,text/plain'; file.required=true;
			const excerpt = field(form, 'Exact supporting excerpt', 'textarea'); excerpt.required=true; excerpt.minLength=20; excerpt.maxLength=4000;
			form.append(node('p','The server checks the excerpt against the document and retains their hashes and your scoped review decision.'));
			form.onsubmit = event => event.preventDefault();
			button('Save document review', async () => {
				if (!form.reportValidity()) return;
				const selected = file.files[0];
				if (selected.size > 128000) throw new Error('The document exceeds 128 KB.');
				await api(prefix + '/document-reviews', {method:'POST',body:JSON.stringify({
					expectedRevision:revision,requirementId:requirement.value,featureId:feature.value,determination:determination.value,
					obligation:obligation.value,jurisdiction:jurisdiction.value,documentText:await selected.text(),excerpt:excerpt.value
				})});
				form.reset();
				await selectRun(session.id);
			},form);
		}
	}
	const change = async (action, reason) => {
		const response = await api(`${prefix}/review/${action}`, { method: 'POST', body: JSON.stringify({ expectedRevision: revision, reason }) });
		await refresh(response.sqa, { focusControl: action === 'reopen' });
	};
	if (idle && sqa.finalizedAt && sqa.assessment) {
		const form = node('form', '', 'sqa-review-form');
		const reason = field(form, 'Review request or reopening reason', 'textarea');
		reason.dataset.sqaReviewReason = '';
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
		controls.dataset.sqaReviewControl = '';
		for (const result of sqa.assessment?.results ?? []) {
			const option = node('option', `${result.controlId} — ${result.title}`);
			option.value = result.controlId;
			controls.append(option);
		}
		if ([...controls.options].some(option => option.value === selectedControlId)) controls.value = selectedControlId;
		const decision = field(form, 'Decision', 'select');
		for (const value of ['blocked', 'pass', 'fail']) { const option = node('option', value); option.value = value; decision.append(option); }
		const rationale = field(form, 'Reason for this decision', 'textarea');
		rationale.required = true;
		rationale.maxLength = 2000;
		const evidence = node('div', '', 'sqa-review-evidence');
		const intake = node('section', '', 'sqa-review-form sqa-review-submissions');
		const target = sqa.scope?.target;
		const saveEvidence = async (path, data) => {
			onSelectControl?.(controls.value);
			const response = await api(`${prefix}/review/evidence${path}`, {
				method: 'POST', body: JSON.stringify({ expectedRevision: revision, ...data })
			});
			await refresh(response.sqa, { focusControl: true });
		};
		const paintSubmissions = result => {
			intake.replaceChildren();
			const needs = sqaMissingEvidenceRequirements(result).filter(item => item.owner === 'reviewer');
			const submitted = (sqa.reviewSubmissions ?? []).filter(item => item.controlId === result.controlId);
			if (!needs.length && !submitted.length) return;
			intake.append(node('h4', 'Reviewer document submissions'),
				node('p', 'Submit a document for a specific requirement. Open it and record a reviewer decision before using it in the assessment.'));
			for (const item of submitted) {
				const card = node('fieldset');
				const outOfScope = !forTarget(item, target);
				const state = ({ submitted: 'Awaiting review', accepted: 'Accepted', rejected: 'Rejected' })[item.status];
				card.append(node('legend', `${item.type.replaceAll('_', ' ')} · ${state}`),
					node('p', `Owner ${item.owner} · Build ${item.release} · ${item.environment}`),
					node('p', item.summary));
				if (outOfScope) card.append(node('p', 'Out of scope. This build or environment differs from the assessment.'));
				const link = node('a', item.source === 'file' ? `Download ${item.fileName}` : 'Open source document', 'btn btn-ghost btn-sm');
				if (item.source === 'file') {
					link.href = `/api${prefix}/review/evidence/${encodeURIComponent(item.id)}/file`;
					link.download = item.fileName;
				} else if (URL.parse(item.link)?.protocol === 'https:') {
					link.href = item.link;
					link.target = '_blank';
					link.rel = 'noopener noreferrer';
				}
				if (link.hasAttribute('href')) card.append(link);
				if (item.reviewNote) card.append(node('p', item.reviewNote));
				if (item.status === 'submitted') {
					const note = field(card, 'Document review note', 'textarea'); note.maxLength = 1000;
					const opened = field(card, 'I opened this document and verified access.'); opened.type = 'checkbox';
					if (!outOfScope) button('Accept document', () => saveEvidence(`/${item.id}/decision`, { decision: 'accepted', note: note.value, opened: opened.checked }), card);
					button('Reject document', () => saveEvidence(`/${item.id}/decision`, { decision: 'rejected', note: note.value }), card);
				}
				intake.append(card);
			}
			if (!needs.length) return;
			const submission = node('form', '', 'sqa-review-form');
			const requirement = field(submission, 'Evidence requirement', 'select');
			const purpose = node('p');
			for (const item of needs) {
				const option = node('option', item.type.replaceAll('_', ' ')); option.value = item.id; requirement.append(option);
			}
			const showPurpose = () => { purpose.textContent = needs.find(item => item.id === requirement.value)?.description ?? ''; };
			requirement.onchange = showPurpose;
			showPurpose();
			submission.append(purpose);
			const owner = field(submission, 'Document owner'); owner.required = true; owner.maxLength = 120;
			const release = field(submission, 'Document build or release'); release.required = true; release.maxLength = 200; release.value = target?.release ?? '';
			const environment = field(submission, 'Document environment'); environment.required = true; environment.maxLength = 100; environment.value = target?.environment ?? '';
			const summary = field(submission, 'What the submitted document demonstrates', 'textarea'); summary.required = true; summary.maxLength = 1000;
			const source = field(submission, 'Document source', 'select');
			for (const [value, label] of [['link', 'HTTPS link'], ['file', 'Upload a file']]) {
				const option = node('option', label); option.value = value; source.append(option);
			}
			const link = field(submission, 'HTTPS document link'); link.type = 'url'; link.maxLength = 512;
			const file = field(submission, 'Reviewer document (PDF, text or Markdown, up to 512 KB)'); file.type = 'file'; file.accept = '.pdf,.txt,.md';
			const syncSource = () => {
				const uploading = source.value === 'file';
				link.parentElement.hidden = uploading;
				link.required = !uploading;
				file.parentElement.hidden = !uploading;
				file.required = uploading;
			};
			source.onchange = syncSource;
			syncSource();
			const submit = button('Submit document for review', async () => {
				if (!submission.reportValidity()) return;
				await saveEvidence('', {
					controlId: result.controlId, requirementId: requirement.value, owner: owner.value,
					release: release.value, environment: environment.value, summary: summary.value, source: source.value,
					...(source.value === 'file' ? { file: await filePayload(file.files[0]) } : { link: link.value })
				});
			}, submission);
			submission.onsubmit = event => { event.preventDefault(); submit.click(); };
			intake.append(submission);
		};
		let evidenceInputs = [];
		const syncEvidenceRequired = () => {
			for (const item of evidenceInputs) item.reference.required = decision.value === 'pass' && item.neededForPass;
		};
		decision.onchange = syncEvidenceRequired;
		const paintEvidence = () => {
			evidence.replaceChildren(node('p', 'Add references to documents you reviewed for this release. The files stay in their source system.'));
			evidenceInputs = [];
			const result = sqa.assessment.results.find(item => item.controlId === controls.value);
			if (!result) return;
			paintSubmissions(result);
			decision.value = ['pass', 'fail', 'blocked'].includes(result.status) ? result.status : 'blocked';
			rationale.value = result?.rationale ?? '';
			const browser = (result.evidence ?? []).filter(isSqaInternalEvidence);
			const documents = (result.evidence ?? []).filter(item => !isSqaInternalEvidence(item) && !managed(item));
			const approved = (sqa.reviewSubmissions ?? []).filter(item => item.controlId === result.controlId && item.status === 'accepted' && forTarget(item, target));
			if (approved.length) evidence.append(node('p', `${approved.length} accepted reviewer document${approved.length === 1 ? '' : 's'} will be checked and attached when you save.`));
			if (browser.length) {
				evidence.append(node('p', `${browser.length} browser evidence record${browser.length === 1 ? '' : 's'} will be kept with this decision.`, 'sqa-review-retained'));
			}
			if (result.claimedStatus && result.claimedStatus !== result.status && result.decisionNotes?.length) {
				evidence.append(node('p', result.decisionNotes[0], 'sqa-review-retained'));
			}
			const requirements = new Map();
			for (const item of result.evidenceCoverage?.requirements ?? []) {
				if ((requirements.get(item.type)?.minimum ?? 0) < item.minimum) requirements.set(item.type, item);
			}
			for (const item of documents) if (!requirements.has(item.type)) requirements.set(item.type, { type: item.type, minimum: 0 });
			for (const requirement of requirements.values()) {
				const retained = browser.filter(item => item.type === requirement.type && !isSqaPartialReleaseEvidence(result.controlId, item)).length;
				const accepted = approved.filter(item => item.type === requirement.type).length;
				const required = Math.max(0, requirement.minimum - retained - accepted);
				const existing = documents.filter(item => item.type === requirement.type);
				for (let index = 0; index < Math.max(required, existing.length); index++) {
					const row = node('fieldset');
					row.append(node('legend', requirement.type.replaceAll('_', ' ')));
					if (index === 0 && requirement.description) row.append(node('p', requirement.description));
					const reference = field(row, 'Document reference or URL'); reference.maxLength = 512;
					const summary = field(row, 'What this evidence demonstrates', 'textarea'); summary.maxLength = 1000;
					const digest = field(row, 'SHA-256 digest (optional)'); digest.pattern = 'sha256:[a-f0-9]{64}';
					const saved = existing[index];
					if (saved) { reference.value = saved.reference; summary.value = saved.summary ?? ''; digest.value = saved.digest ?? ''; }
					evidenceInputs.push({ type: requirement.type, reference, summary, digest, neededForPass: index < required });
					evidence.append(row);
				}
			}
			syncEvidenceRequired();
		};
		controls.onchange = () => {
			onSelectControl?.(controls.value);
			paintEvidence();
		};
		paintEvidence();
		form.append(evidence);
		button('Save control decision', async () => {
			if (!form.reportValidity()) return;
			onSelectControl?.(controls.value);
			const items = evidenceInputs.filter(item => item.reference.value.trim()).map(item => ({ type: item.type, reference: item.reference.value.trim(), summary: item.summary.value.trim(), ...(item.digest.value.trim() ? { digest: item.digest.value.trim() } : {}) }));
			const result = await api(`${prefix}/observations`, { method: 'POST', body: JSON.stringify({ expectedRevision: revision, evidenceMode: 'reviewer_documents', observation: { controlId: controls.value, status: decision.value, rationale: rationale.value, evidence: items } }) });
			await refresh(result.sqa);
		}, form);
		form.onsubmit = event => event.preventDefault();
		section.append(form, intake);
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
