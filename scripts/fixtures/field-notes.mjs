import http from 'node:http';
import { randomUUID } from 'node:crypto';

// A second disposable QA target. Evidence stays in the caller, outside the
// application served to the agent. Saving a note never replaces the document.
export async function startFieldNotes() {
	const records = [];
	const observations = [];
	const routes = new Map([
		['/', ['Field notes', '<p>Keep track of work in the field.</p><ul><li><a href="/notes">Notebook</a></li><li><a href="/labels">Browse labels</a></li><li><a href="/guide">Field guide</a></li></ul>']],
		['/labels', ['Labels', '<details><summary>Locations</summary><p>Office · On site · Remote</p></details>']],
		['/guide', ['Field guide', '<details><summary>How do I organize notes?</summary><p>Use short, descriptive titles.</p></details>']],
		['/notes', ['Notebook', `<form method="post" action="/api/notes"><label>Note title <input name="title" required maxlength="100"></label>
			<button>Add note</button></form><p role="status"></p><ul id="saved"></ul>
			<script>
			const docId = crypto.randomUUID();
			function observe(kind, details) {
				const params = new URLSearchParams({kind, docId, ...details});
				void fetch('/observed?' + params).catch(() => {});
			}
			const form = document.forms[0], title = form.elements.title;
			observe('opened', {});
			title.addEventListener('invalid', () => observe('invalid', {empty: String(!title.value), message: title.validationMessage}));
			form.addEventListener('submit', async event => {
				event.preventDefault();
				const status = document.querySelector('[role=status]');
				const response = await fetch(form.action, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title:title.value})});
				if (!response.ok) {status.textContent = 'Unable to save note.';return;}
				const note = await response.json();
				const row = document.createElement('li'); row.textContent = note.title;
				document.querySelector('#saved').append(row);
				status.textContent = 'Note saved. Reference ' + note.id;
				observe('receipt displayed', {id:note.id}); form.reset();
			});
			</script>`]]
	]);
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, 'http://localhost');
		if (req.method === 'GET' && routes.has(url.pathname)) {
			const [title, content] = routes.get(url.pathname);
			observations.push({ kind: 'page requested', path: url.pathname, at: Date.now() });
			res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'});
			res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>' + title +
				'</title><nav><a href="/">Home</a></nav><main><h1>' + title + '</h1>' + content + '</main></html>'); return;
		}
		if (req.method === 'GET' && url.pathname === '/observed') {
			const params = url.searchParams;
			if (['opened','invalid','receipt displayed'].includes(params.get('kind'))) {
				observations.push({kind:params.get('kind'),docId:params.get('docId'),id:params.get('id'),message:params.get('message'),empty:params.get('empty') === 'true',at:Date.now()});
			}
			res.writeHead(204).end(); return;
		}
		if (req.method === 'POST' && url.pathname === '/api/notes') {
			let body = '';
			for await (const chunk of req) {
				body += chunk;
				if (body.length > 2048) { res.writeHead(413).end(); return; }
			}
			let title;
			try { title = JSON.parse(body)?.title; } catch { res.writeHead(400).end(); return; }
			if (typeof title !== 'string' || !title.trim() || title.length > 100) { res.writeHead(422).end(); return; }
			const note = {id:randomUUID(), title:title.trim(), at:Date.now()};
			records.push(note);
			res.writeHead(201, {'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(note)); return;
		}
		res.writeHead(404).end();
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return {url:'http://127.0.0.1:' + server.address().port + '/', records, observations,
		close:() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }};
}
