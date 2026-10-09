/**
 * Small, side-effect-free presentation helpers shared by the dashboard.
 *
 * Keeping these outside the application controller makes their escaping and
 * formatting rules independently testable without coupling them to run state.
 */

export function escapeHtml(text) {
	return text.replace(/[&<>"']/g, character => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
	));
}

/**
 * Render the deliberately small markdown subset used by agent messages.
 * Input is escaped before formatting so page content can never become markup.
 */
export function markdown(text) {
	const blocks = [];
	let html = escapeHtml(text)
		.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
			blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
			return `\uE000${blocks.length - 1}\uE000`;
		})
		.replace(/`([^`\n]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
		.replace(/^#{1,6}\s+(.+)$/gm, '<h3>$1</h3>');

	html = html
		.replace(/(?:^[-*]\s+.+(?:\n|$))+/gm, match =>
			`<ul>${match.trim().split('\n').map(line => `<li>${line.replace(/^[-*]\s+/, '')}</li>`).join('')}</ul>`)
		.replace(/(?:^\d+[.)]\s+.+(?:\n|$))+/gm, match =>
			`<ol>${match.trim().split('\n').map(line => `<li>${line.replace(/^\d+[.)]\s+/, '')}</li>`).join('')}</ol>`);

	return html
		.split(/\n{2,}/)
		.map(chunk => (/^\s*(<(ul|ol|pre|h3)|\uE000)/.test(chunk) ? chunk : `<p>${chunk.replace(/\n/g, '<br>')}</p>`))
		.join('')
		.replace(/<p>\s*<\/p>/g, '')
		.replace(/\uE000(\d+)\uE000/g, (_match, index) => blocks[Number(index)]);
}

export function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

export function relativeTime(timestamp, now = Date.now()) {
	const seconds = Math.round((now - timestamp) / 1000);
	if (seconds < 60) return 'just now';
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
	return new Date(timestamp).toLocaleDateString();
}

export function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Compact token count: 820, 15.3k, 2.01M, 3.4B. */
export function formatTokens(value) {
	const count = Number(value);
	if (!Number.isFinite(count) || count <= 0) return undefined;
	if (count < 1_000) return `${count}`;
	if (count < 1_000_000) return `${Number((count / 1_000).toFixed(count < 100_000 ? 1 : 0))}k`;
	if (count < 1_000_000_000) return `${Number((count / 1_000_000).toFixed(2))}M`;
	return `${Number((count / 1_000_000_000).toFixed(2))}B`;
}

/**
 * Compose the header usage-chip text from a run's token/context usage.
 * `tok` belongs to each count segment (`4.76M tok in · 27.2k tok out`),
 * never a standalone segment; `~` marks estimated counts.
 */
export function usageChipText(usage, context) {
	if (!usage || !Number.isFinite(usage.totalTokens) || usage.totalTokens <= 0) return undefined;
	const est = usage.estimated === true ? '~' : '';
	const parts = [];
	const input = formatTokens(usage.inputTokens);
	const output = formatTokens(usage.outputTokens);
	if (input) parts.push(`${est}${input} tok in`);
	if (output) parts.push(`${est}${output} tok out`);
	if (parts.length === 0) return undefined;
	const percentage = context && Number.isFinite(context.percentage) && context.percentage > 0
		? Math.round(context.percentage) : undefined;
	return parts.join(' · ') + (percentage !== undefined ? ` · ${percentage}% ctx` : '');
}

/**
 * Compose the run-summary token row: `[~]4.76M in · 27.2k out · 4.79M total`.
 * Context % is NOT included here (it rides the tooltip) so the row stays
 * compact at every width. `~` marks estimated counts.
 */
export function tokenSummaryText(usage) {
	if (!usage) return undefined;
	const est = usage.estimated === true ? '~' : '';
	const parts = [];
	const input = formatTokens(usage.inputTokens);
	const output = formatTokens(usage.outputTokens);
	const total = formatTokens(usage.totalTokens);
	if (input) parts.push(`${est}${input} in`);
	if (output) parts.push(`${est}${output} out`);
	if (total && parts.length > 0) parts.push(`${est}${total} total`);
	return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Compose the minimized run-summary row: `✦ 6.39M tokens · ● DONE · 5/5 · 100% · Findings 4`.
 * Returns the four segments separately (tokens / status / progress / findings) so the
 * caller can lay them out with flex and hide empty ones. No in/out split, no bar, no
 * activity — the expanded row carries those. Pending usage renders `--`, never a fake 0.
 */
export function miniSummaryText({ usage, status, progress, findings }) {
	const est = usage && usage.estimated === true ? '~' : '';
	const total = usage ? formatTokens(usage.totalTokens) : undefined;
	const tokens = usage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens) && total
		? `✦ ${est}${total} tokens`
		: '✦ -- tokens';
	const statusLabels = { running: '● RUNNING', done: '● DONE', blocked: '● BLOCKED', awaiting_input: '● waiting for you' };
	const statusText = status
		? (statusLabels[status] ?? `● ${status.toUpperCase()}`)
		: '';
	let progressText = '';
	if (progress && progress.total > 0) {
		progressText = `${progress.done}/${progress.total}` + (progress.percent !== undefined ? ` · ${progress.percent}%` : '');
	}
	const findingsText = Number.isFinite(findings) && findings > 0 ? `Findings ${findings}` : '';
	return { tokens, status: statusText, progress: progressText, findings: findingsText };
}

export function section(heading, body, documentRef = globalThis.document) {
	const node = documentRef.createElement('div');
	node.className = 'report-section';
	const title = documentRef.createElement('h3');
	title.textContent = heading;
	node.append(title, body);
	return node;
}

export function paragraph(text, documentRef = globalThis.document) {
	const node = documentRef.createElement('p');
	node.textContent = text ?? '';
	return node;
}

export function list(items, documentRef = globalThis.document) {
	const node = documentRef.createElement('ul');
	for (const item of items) {
		const entry = documentRef.createElement('li');
		entry.textContent = item;
		node.append(entry);
	}
	return node;
}
