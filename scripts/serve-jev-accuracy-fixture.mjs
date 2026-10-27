// Local-only acceptance target with deliberately known defects and benign noise.
import http from 'node:http';

const server = http.createServer((request, response) => {
  if (request.method !== 'GET') { response.writeHead(405); response.end('No writes accepted'); return; }
  if (request.url === '/required.js') { response.writeHead(500); response.end('Deliberately failed script'); return; }
  if (request.url === '/missing.png') { response.writeHead(404); response.end('Deliberately missing image'); return; }
  if (request.url === '/api/auth/me') { response.writeHead(401); response.end('Anonymous session'); return; }
  if (request.url?.includes('_rsc=')) { response.writeHead(404); response.end('Speculative request unavailable'); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><html lang="en"><head><title>QASE accuracy acceptance fixture</title>
    <style>body{font:16px system-ui;margin:16px}.overflow{width:1200px;height:30px;background:#ddd}button{min-width:40px;min-height:30px}#mobile-menu{display:none}@media(max-width:500px){#mobile-menu{display:block}}</style></head><body>
    <h1>${request.url === '/help' ? 'Help page' : 'Known-defect acceptance page'}</h1>
    <a id="home" href="/">Home</a> <a id="help" href="/help">Help</a>
    <div class="overflow">Deliberate narrow viewport overflow</div>
    <button id="unnamed"><span aria-hidden="true">×</span></button>
    <button id="faq" aria-controls="answer" aria-expanded="false">FAQ</button><div id="answer" hidden>Unreachable answer</div>
    <button id="false-panel" aria-controls="hidden-panel" aria-expanded="false" onclick="this.setAttribute('aria-expanded',this.getAttribute('aria-expanded')==='true'?'false':'true')">More details</button><div id="hidden-panel" hidden>Still hidden after expansion</div>
    <button id="mobile-menu" aria-controls="mobile-panel" aria-expanded="false">Menu</button><div id="mobile-panel" hidden>Unreachable mobile routes</div>
    <a href="#absent-section">Jump to missing section</a>
    <div role="tablist"><button id="tab-one" role="tab" aria-selected="true" aria-controls="panel-one">Overview</button><button id="tab-two" role="tab" aria-selected="false" aria-controls="panel-two">Details</button></div>
    <section id="panel-one">Overview content</section><section id="panel-two" hidden>Details content never revealed</section>
    <img id="broken-image" src="/missing.png" alt="Deliberately broken asset" width="40" height="40">
    <label for="search">Filter guides</label><input type="search" id="search" aria-controls="results"><ul id="results"><li>Alpha guide</li><li>Beta help</li></ul>
    <script src="/required.js"></script><script>
      const items=['Alpha guide','Beta help'];
      for(const tab of document.querySelectorAll('[role="tab"]'))tab.onclick=()=>{for(const other of document.querySelectorAll('[role="tab"]'))other.setAttribute('aria-selected',String(other===tab));};
      search.addEventListener('input',()=>{const found=items.filter(text=>text.toLowerCase().includes(search.value.toLowerCase()));results.replaceChildren(...(found.length?found:items).map(text=>{const item=document.createElement('li');item.textContent=text;return item}));});
      fetch('/api/auth/me').catch(()=>{});fetch('/document.pdf/__next._tree.txt?_rsc=fixture').catch(()=>{});
      setTimeout(()=>{throw new TypeError('QASE_ACCEPTANCE_UNCAUGHT_EXCEPTION')},50);
    </script></body></html>`);
});
server.listen(5186, '127.0.0.1', () => console.log('Known-defect fixture ready: http://127.0.0.1:5186/'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
