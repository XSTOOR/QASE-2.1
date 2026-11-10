const INTEGRITY = { verified: 'Activity receipt verified', mismatch: 'Receipt does not match', unavailable: 'Original receipt unavailable', external_unverified: 'Reference not verified', redacted: 'Additional redaction applied' };

export function createFounderEvidenceView({ documentRef: doc, getSession, api, categoryLabel }) {
	let current, context;
	const identity = session => session?.mode === 'founder' ? `${session.ownerUserId ?? 'local'}:${session.id}` : undefined;
	const node = (tag, text, className) => { const item = doc.createElement(tag); if (text !== undefined) item.textContent = String(text); if (className) item.className = className; return item; };
	const timestamp = value => {
		const date = new Date(value);
		if (!value || Number.isNaN(date.getTime())) return 'Time not recorded';
		return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
	};
	function close(restoreFocus = true) {
		if (!current) return;
		current.restoreFocus = restoreFocus;
		current.dialog.close();
	}
	function showReceipt(record, observation, evidence, index, button, body) {
		let loading = false;
		const status = node('p', '', 'founder-evidence-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
		body.append(status);
		async function load() {
			if (loading || current !== record) return;
			loading = true; button.setAttribute('aria-disabled', 'true'); status.setAttribute('role','status'); status.textContent = 'Checking the saved browser record…'; const retryFocused=body.contains(doc.activeElement);body.replaceChildren(status);if(retryFocused)button.focus({preventScroll:true});
			try {
				const result = await api(`/sessions/${encodeURIComponent(record.runId)}/founder/evidence/${encodeURIComponent(observation.id)}/${index}`);
				if (current !== record || context !== record.context) return;
				status.textContent = INTEGRITY[result.integrity] ?? 'Verification unavailable'; status.dataset.integrity = result.integrity;
				body.append(node('p', result.detail));
				const metadata = node('dl');
				for (const [label, value] of [['Linked to observation', timestamp(result.evidence?.collectedAt)], ['Reference', result.evidence?.reference ?? 'Not recorded'], ['Recorded digest', result.evidence?.digest ?? 'Not recorded']]) metadata.append(node('dt', label), node('dd', value));
				body.append(metadata);
				for (const activity of result.activities ?? []) {
					const card = node('article', undefined, 'founder-receipt');
					card.append(node('h4', 'Bound browser activity'), node('p', activity.toolName ?? 'Browser activity'), node('p', timestamp(activity.ts)), node('p', activity.summary ?? 'No activity summary retained.'));
					if (activity.detail) { const details = node('details'); details.append(node('summary', 'Saved activity details'), node('pre', typeof activity.detail === 'string' ? activity.detail : JSON.stringify(activity.detail, null, 2))); card.append(details); }
					body.append(card);
				}
				body.append(node('p', result.limitation, 'founder-evidence-limit'), node('p', result.redaction, 'founder-evidence-limit'));
			} catch (error) {
				if (current !== record || context !== record.context) return;
				status.textContent = error instanceof Error ? error.message : 'The browser record could not be loaded.'; status.setAttribute('role', 'alert');
				const retry = node('button', 'Retry evidence lookup', 'btn btn-ghost'); retry.type = 'button'; retry.onclick = load; body.append(retry);
			} finally { loading = false; button.removeAttribute('aria-disabled'); }
		}
		button.onclick = load;
	}
	return {
		sync(session) { const next = identity(session); if (next !== context) close(false); context = next; },
		open(ids, trigger, title = 'Supporting observations') {
			const session = getSession(); if (session?.mode !== 'founder') return;
			close(false); context = identity(session);
			const dialog = node('dialog', undefined, 'modal founder-evidence-dialog');
			const heading = node('h2', title); heading.id = 'founder-evidence-title'; dialog.setAttribute('aria-labelledby', heading.id);
			const dismiss = node('button', 'Close evidence', 'btn btn-ghost'); dismiss.type = 'button'; dismiss.onclick = () => close();
			const head = node('header', undefined, 'founder-evidence-head'); head.append(heading, dismiss);
			dialog.append(head, node('p', 'These are recorded browser observations. They do not establish customer demand, revenue, or other commercial assumptions.', 'founder-evidence-limit'));
			const record = { dialog, runId: session.id, context, restoreFocus: true }; current = record;
			const observations = new Map((session.founder?.observations ?? []).map(item => [item.id, item]));
			const requested = [...new Set(ids)], list = node('div', undefined, 'founder-evidence-observations'); dialog.append(list);
			if(!requested.length)list.append(node('p','No observations are retained in this saved run.'));
			let shown = 0;
			const more = node('button', 'Show more observations', 'btn btn-ghost'); more.type = 'button';
			function appendPage() {
				for (const id of requested.slice(shown, shown + 20)) {
					const observation = observations.get(id), card = node('article', undefined, 'founder-evidence-observation');
					if (!observation) { card.append(node('h3', 'Observation unavailable'), node('p', `The referenced observation ${id} is not retained in this saved run.`)); list.append(card); continue; }
					card.append(node('h3', observation.title ?? 'Recorded observation'), node('p', `${categoryLabel(observation.category)} · Observation confidence: ${observation.confidence ?? 'not recorded'}`, 'founder-card-meta'), node('p', observation.summary ?? 'No observation summary retained.'));
					if (!observation.evidence?.length) card.append(node('p', 'No browser record is retained for this observation.'));
					for (const [offset, evidence] of (observation.evidence ?? []).entries()) {
						const entry = node('section', undefined, 'founder-evidence-entry'), button = node('button', `Inspect browser record ${offset + 1}`, 'btn btn-ghost'), body = node('div', undefined, 'founder-evidence-receipt');
						button.type = 'button'; button.setAttribute('aria-label', `Inspect browser record ${offset + 1} for ${observation.title ?? 'observation'}`);
						entry.append(node('p', evidence.summary ?? 'Browser activity reference'), button, body); card.append(entry);
						showReceipt(record, observation, evidence, offset + 1, button, body);
					}
					list.append(card);
				}
				shown += 20; more.hidden = shown >= requested.length;
			}
			more.onclick = appendPage; appendPage(); dialog.append(more);
			dialog.addEventListener('close', () => {
				dialog.remove(); if (current === record) current = undefined;
				if (record.restoreFocus && identity(getSession()) === record.context && trigger?.isConnected && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
			}, { once: true });
			doc.body.append(dialog); dialog.showModal();
		}
	};
}
