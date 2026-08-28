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
