function element(tag, text) {
	const node = document.createElement(tag);
	if (text !== undefined) node.textContent = text;
	return node;
}

const INTEGRITY_LABELS = {
	verified: 'Digest verified', mismatch: 'Digest mismatch', unavailable: 'Original bundle unavailable',
	external_unverified: 'External document not verified', redacted: 'Additional redaction applied'
};

export function evidenceInspectButton({ runId, controlId, index, api, version }) {
	const button = element('button', 'Inspect evidence');
	button.type = 'button'; button.className = 'btn btn-ghost btn-sm';
	button.setAttribute('aria-label', `Inspect evidence ${index} for ${controlId}`);
	button.onclick = async () => {
		const dialog = element('dialog'); dialog.className = 'modal sqa-evidence-dialog';
		dialog.setAttribute('aria-label', `Evidence ${index} for ${controlId}`);
		const close = element('button', 'Close evidence'); close.type = 'button'; close.className = 'btn btn-ghost'; close.onclick = () => dialog.close();
		const body = element('div'); body.className = 'sqa-evidence-inspector'; body.setAttribute('aria-live', 'polite');
		dialog.append(close, body); document.body.append(dialog);
		dialog.addEventListener('close', () => { dialog.remove(); if (button.isConnected) button.focus(); }, { once: true });
		dialog.showModal(); body.textContent = 'Loading the saved evidence record…';
		try {
			const result = await api(`/sessions/${runId}/sqa/evidence/${encodeURIComponent(controlId)}/${index}${version === undefined ? '' : `?version=${version}`}`);
			if (!dialog.isConnected) return;
			body.replaceChildren(element('h2', `${controlId} — evidence ${index}`));
			const state = element('strong', INTEGRITY_LABELS[result.integrity] ?? result.integrity); state.dataset.integrity = result.integrity;
			body.append(state, element('p', result.detail));
			const metadata = element('dl');
			for (const [label, value] of [ ['Type', result.evidence.type], ['Collected at', result.evidence.collectedAt ?? 'not recorded'], ['Reference', result.evidence.reference], ['Digest', result.evidence.digest ?? 'not supplied'], ['Summary', result.evidence.summary ?? 'not recorded'] ]) {
				metadata.append(element('dt', label), element('dd', value));
			}
			body.append(metadata, element('p', result.redaction), element('h3', 'Bound browser activities'));
			if (!result.activities.length) body.append(element('p', 'No browser activity bundle is available for this evidence.'));
			for (const activity of result.activities) {
				const card = element('article');
				card.append(element('h4', activity.toolName ?? 'Browser activity'), element('p', `Activity ${activity.id}`), element('p', Number.isFinite(Number(activity.ts)) ? new Date(Number(activity.ts)).toISOString() : 'Time not recorded'));
				if (activity.detail) card.append(element('p', typeof activity.detail === 'string' ? activity.detail : JSON.stringify(activity.detail)));
				if (activity.summary) card.append(element('pre', typeof activity.summary === 'string' ? activity.summary : JSON.stringify(activity.summary, null, 2)));
				body.append(card);
			}
			body.append(element('p', 'This observation bundle does not imply a screenshot or other binary artifact was retained.'));
			if (result.bundle) {
				const full = element('details'); full.append(element('summary', 'Retained browser bundle'), element('pre', JSON.stringify(result.bundle, null, 2))); body.append(full);
			}
		} catch (error) { if (dialog.isConnected) body.textContent = error.message; }
	};
	return button;
}

export function renderSqaTraceability(model, options) {
	const register = element('details'); register.className = 'sqa-section sqa-traceability';
	register.append(element('summary', `Evidence traceability register (${model.evidence.length})`));
	for (const item of model.evidence) {
		const entry = element('article');
		entry.append(element('h4', `${item.controlId} · ${item.index} · ${item.type}`));
		for (const [key, value] of [['Collected at', item.collectedAt], ['Reference', item.reference], ['Digest', item.digest], ['Summary', item.summary], ['Origin', item.origin]]) entry.append(element('p', `${key}: ${value}`));
		entry.append(evidenceInspectButton({ ...options, controlId: item.controlId, index: item.index }));
		register.append(entry);
	}
	if (!model.evidence.length) register.append(element('p', 'No evidence artifacts were attached to this assessment.'));
	return register;
}
