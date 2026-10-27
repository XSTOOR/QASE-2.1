import http from 'node:http';
import { once } from 'node:events';

export async function startHybridBenchmarkFixture() {
  let writes = 0;
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET') { writes++; response.writeHead(405); response.end('Writes disabled'); return; }
    if (request.url === '/missing-fixture.png') { response.writeHead(404); response.end('Known missing fixture asset'); return; }
    if (request.url === '/healthy.svg') { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>'); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><title>Hybrid benchmark fixture</title><h1>${request.url === '/help' ? 'Help' : 'Home'}</h1><a href="/">Home</a><a href="/help">Help</a>
      <div style="width:1200px;height:20px">Known narrow overflow</div>
      <img src="/missing-fixture.png" alt="Missing fixture" width="20" height="20"><img src="/healthy.svg" alt="Healthy fixture" width="20" height="20">
      <label for="search">Filter guides</label><input id="search" type="search" aria-controls="results"><ul id="results"><li>Alpha guide</li><li>Beta guide</li></ul>
      <details><summary>Details</summary>Healthy disclosure content</details>
      <script>const values=['Alpha guide','Beta guide']; search.oninput=()=>{const found=values.filter(value=>value.toLowerCase().includes(search.value.toLowerCase()));results.replaceChildren(...(found.length?found:values).map(value=>{const li=document.createElement('li');li.textContent=value;return li}));}</script>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/`, writes: () => writes, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
