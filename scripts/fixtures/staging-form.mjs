import http from 'node:http';
import { randomUUID } from 'node:crypto';

// Disposable target for testing QASE through its dashboard. The caller can
// verify saves independently of anything the browser or the report claims.
export async function startStagingForm() {
	const records = [];
	const observations = [];
	const escape = text => text.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url, 'http://localhost');
		const html = (title, content, status = 200) => {
			response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
			response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>' + title + '</title><main><h1>' + title + '</h1>' + content + '</main></html>');
		};
		if (request.method === 'GET' && url.pathname === '/') return html('Staging notebook', '<p>Create a disposable test record.</p><a href="/new">New record</a>');
		if (request.method === 'GET' && url.pathname === '/new') {
			observations.push({ kind: 'form opened', at: Date.now() });
			return html('New record', '<form method="post" action="/records"><label>Record name <input name="name" required maxlength="100"></label><button>Save record</button></form><script>const field=document.querySelector("input");field.addEventListener("invalid",()=>{new Image().src="/observation?validation="+encodeURIComponent(field.validationMessage)+"&empty="+(field.value==="")});</script>');
		}
		if (request.method === 'GET' && url.pathname === '/observation') {
			observations.push({ kind: 'validation', message: url.searchParams.get('validation'), empty: url.searchParams.get('empty') === 'true', at: Date.now() });
			response.writeHead(204).end(); return;
		}
		if (request.method === 'POST' && url.pathname === '/records') {
			let body = '';
			for await (const chunk of request) {
				body += chunk;
				if (body.length > 1024) { response.writeHead(413).end(); return; }
			}
			const name = new URLSearchParams(body).get('name')?.trim();
			if (!name || name.length > 100) return html('Enter a record name', '', 422);
			const record = { id: randomUUID(), name, at: Date.now() };
			records.push(record);
			response.writeHead(303, { Location: '/records/' + record.id }).end(); return;
		}
		const record = records.find(row => url.pathname === '/records/' + row.id);
		if (request.method === 'GET' && record) {
			observations.push({ kind: 'receipt opened', id: record.id, at: Date.now() });
			return html('Record saved', '<p role="status">Saved record: ' + escape(record.name) + '</p>');
		}
		response.writeHead(404).end();
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return { url: 'http://127.0.0.1:' + server.address().port + '/', records, observations, close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}
