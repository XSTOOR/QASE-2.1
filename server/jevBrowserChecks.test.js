import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { runJevBrowserCheck } from './jevBrowserChecks.js';
import { assessJevExecution, jevRouteCandidates } from './jevQaRunner.js';

test('a disclosure on the wrong page is refused before dispatch, then a fresh actual control executes',async t=>{
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent('<h1>Another surface</h1>');let clicks=0;
 const refused=await runJevBrowserCheck(page,{action:'disclosure',selector:'#faq'},{onAction:async()=>{clicks++;}});
 assert.equal(refused.code,'QA_CONTROL_STALE');assert.equal(refused.dispatched,false);assert.equal(clicks,0);assert.deepEqual(refused.assertions,[]);
 await page.setContent('<h1>Observed help</h1><details><summary id="faq">FAQ</summary><p>Declared answer</p></details>');
 const executed=await runJevBrowserCheck(page,{action:'disclosure',selector:'#faq'});
 assert.equal(executed.success,true);assert.ok(executed.assertions.some(a=>a.check==='navigation'&&a.outcome==='pass'));
});

test('title-only menu discovered by inventory executes and restores its viewport', { timeout: 30000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setContent(`<h1>Workspace</h1><button id="menu" title="Menu" aria-expanded="false" onclick="this.setAttribute('aria-expanded',String(panel.hidden));panel.hidden=!panel.hidden">☰</button><section id="panel" hidden>Projects</section>`);
  // An icon with no text is commonly labelled solely by title.
  await page.locator('#menu').evaluate(button => { button.innerHTML = '<svg width="20" height="20" aria-hidden="true"></svg>'; });
  const inventory = await runJevBrowserCheck(page, { action: 'inspect' });
  assert.equal(inventory.inventory.disclosures[0].label, 'Menu');
  const result = await runJevBrowserCheck(page, { action: 'responsive' });
  assert.ok(result.assertions.some(item => /disclosure/i.test(item.name)), JSON.stringify(result));
  assert.ok(!result.gaps?.some(gap => /eligible/.test(gap)));
  assert.equal(await page.locator('#menu').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(page.viewportSize(), { width: 1440, height: 900 });
});

test('inventory waits for a finite CSS reveal but ignores perpetual decoration', { timeout: 15000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<style>@keyframes reveal{from{opacity:0}to{opacity:1}}@keyframes spin{to{transform:rotate(360deg)}}#panel{animation:reveal .6s forwards}#decoration{animation:spin 1s infinite}</style><h1>Workspace</h1><span id="decoration">*</span><section id="panel"><input type="search" placeholder="Search projects"></section>`);
  const result = await runJevBrowserCheck(page, { action: 'inspect' });
  assert.equal(result.inventory.search.length, 1);
  assert.equal(await page.locator('#panel').evaluate(element => getComputedStyle(element).opacity), '1');
});

test('responsive cancellation restores the viewport without starting additional widths', async () => {
  const controller = new AbortController();
  const widths = [];
  const original = { width: 1440, height: 900 };
  const page = {
    isClosed: () => false, url: () => 'https://fixture.test/', viewportSize: () => original,
    async setViewportSize(viewport) { widths.push(viewport.width); if (viewport.width === 390) controller.abort(new Error('Cancelled viewport check')); },
    async waitForLoadState() {}, async waitForFunction() {}, async evaluate() {}
  };
  await assert.rejects(runJevBrowserCheck(page, { action: 'responsive' }, { signal: controller.signal }), /Cancelled viewport check/);
  assert.deepEqual(widths, [390, 1440]);
});

test('coverage planner uses only fresh observed safe links, never invented routes or destructive actions', () => {
  const inventory = { url: 'https://site.test/', links: [
    { href: 'https://site.test/help', label: 'Help', selector: '#help' },
    { href: 'https://site.test/delete', label: 'Delete', selector: '#delete' },
    { href: 'https://elsewhere.test/help', label: 'Other', selector: '#other' },
    { href: 'https://site.test/?change=1', label: 'Go', selector: '#go' },
    { href: 'https://site.test/#section', label: 'Section', selector: '#section' },
    { href: 'https://site.test/download', label: 'Download', selector: '#download', download: true }
  ] };
  assert.deepEqual(jevRouteCandidates(inventory, inventory.url).map(item => item.url), ['https://site.test/help']);
  assert.equal(jevRouteCandidates(inventory, inventory.url, [], ['https://site.test/help']).length, 0);
});

test('coverage gate cannot credit page counts as executed navigation or responsive tests', () => {
  const execution = { visits: [{ url: 'https://site.test/', title: 'Test', diagnosticsComplete: true }], checks: [], remainingRoutes: 8 };
  const result = assessJevExecution(['navigation', 'responsive', 'console_health'], execution);
  assert.deepEqual(result.outcomes.map(item => item.status), ['not_tested', 'not_tested', 'tested']);
  assert.match(result.notCovered.join(' '), /8 additional observed safe routes/);
  const forms = assessJevExecution(['forms'], { ...execution, checks: [{ success: true, action: 'forms', fields: [{ type: 'email' }], assertions: [{ check: 'forms', outcome: 'pass' }] }] });
  assert.equal(forms.outcomes[0].status, 'partial');
});

test('local search executes real filtering, restores input and distinguishes failures from guarded dependencies', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const content = broken => `<!doctype html><title>Search fixture</title><input type="search" id="search" aria-controls="results"><ul id="results"><li>Alpha guide</li><li>Beta help</li></ul><script>
    (() => { const items=['Alpha guide','Beta help'];
    search.addEventListener('input',()=>{const found=items.filter(text=>text.toLowerCase().includes(search.value.toLowerCase())); results.replaceChildren(...(${broken ? 'found.length ? found : items' : 'found'}).map(text=>{const item=document.createElement('li');item.textContent=text;return item}));});
    })();
  </script>`;
  await page.setContent(content(true));
  const broken = await runJevBrowserCheck(page, { action: 'search' });
  assert.equal(broken.success, true);
  assert.ok(broken.assertions.some(item => item.outcome === 'fail' && item.reproduction?.confirmed));
  assert.equal(await page.locator('#search').inputValue(), '');
  await page.setContent(content(false));
  const working = await runJevBrowserCheck(page, { action: 'search' });
  assert.ok(working.assertions.length >= 3);
  assert.ok(working.assertions.every(item => item.outcome === 'pass'));
  await page.setContent(content(false));
  await page.evaluate(() => document.querySelector('#search').addEventListener('input', () => fetch('https://dependency.test/search').catch(() => {})));
  const dependent = await runJevBrowserCheck(page, { action: 'search' });
  assert.ok(dependent.blockedRequests.length > 0);
  assert.equal(dependent.assertions.filter(item => item.outcome === 'fail').length, 0);
  assert.ok(dependent.trials.some(trial => trial.skipped?.includes('network dependency')));
  assert.equal(await page.locator('#search').inputValue(), '');
});

test('discovery excludes invisible/inert controls and reproduces a declared unresponsive disclosure', { timeout: 15000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<title>Disclosure fixture</title><div style="opacity:0"><button>Open menu</button></div><div inert><button>More</button></div><button id="faq" aria-controls="panel" aria-expanded="false">FAQ</button><div id="panel" hidden>Answer</div>');
  const inspected = await runJevBrowserCheck(page, { action: 'inspect' });
  assert.deepEqual(inspected.inventory.disclosures.map(item => item.selector), ['#faq']);
  const checked = await runJevBrowserCheck(page, { action: 'disclosure', selector: '#faq' });
  assert.equal(checked.success, true);
  assert.equal(checked.assertions[0].outcome, 'fail');
  assert.equal(checked.assertions[0].reproduction.confirmed, true);
  await page.setContent('<title>Hover menu fixture</title><button id="products" aria-controls="menu-results" aria-expanded="false" onpointerenter="this.setAttribute(\'aria-expanded\',\'true\');document.getElementById(\'menu-results\').hidden=false" onclick="const open=this.getAttribute(\'aria-expanded\')!==\'true\';this.setAttribute(\'aria-expanded\',String(open));document.getElementById(\'menu-results\').hidden=!open">Products</button><div id="menu-results" hidden><a href="/docs">Docs</a></div>');
  await page.mouse.move(900, 600);
  const hover = await runJevBrowserCheck(page, { action: 'disclosure', selector: '#products' });
  assert.equal(hover.success, true);
  assert.equal(hover.assertions[0].outcome, 'pass', 'Hover opening before the click is not a broken click response.');
  assert.ok(hover.inventory.links.some(link => link.label === 'Docs'), JSON.stringify({ assertion: hover.assertions, body: await page.locator('body').innerHTML() }));
  await page.setContent('<title>Welcome dialog fixture</title><button id="under">Open menu</button><section id="tour" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white"><h2>Welcome guide</h2><label><input type="checkbox">Do not show again</label><button id="close-tour" type="button" aria-label="Close welcome guide" onclick="this.parentElement.remove()">Close</button></section>');
  const overlay = await runJevBrowserCheck(page, { action: 'inspect' });
  assert.equal(overlay.inventory.overlays[0].close.label, 'Close welcome guide');
  assert.equal(overlay.inventory.overlays[0].containsForm, false, 'An onboarding preference checkbox must not be mistaken for a data-entry form.');
  const dismissed = await runJevBrowserCheck(page, { action: 'dismiss_overlay', selector: '#close-tour' });
  assert.equal(dismissed.assertions[0].outcome, 'pass');
  assert.equal(dismissed.inventory.overlays.length, 0);
  const unsafe = await runJevBrowserCheck(page, { action: 'dismiss_overlay', selector: '#under' });
  assert.equal(unsafe.success, false);
  await page.setContent('<title>Sequential onboarding</title><section role="dialog"><button id="first" aria-label="Close welcome">Close</button></section>');
  await page.locator('#first').evaluate(button => button.onclick = () => {
    const next = document.createElement('section'); next.role = 'dialog';
    const close = document.createElement('button'); close.textContent = 'Close introduction'; close.onclick = () => next.remove();
    next.append(close); button.parentElement.replaceWith(next);
  });
  const first = await runJevBrowserCheck(page, { action: 'dismiss_overlay', selector: '#first' });
  assert.equal(first.assertions[0].outcome, 'pass');
  assert.equal(first.inventory.overlays.length, 1, 'A replacement dialog is separate from the original close.');
  await page.setContent('<title>Restore details</title><details><summary id="one">Details</summary><a href="/help">Help</a></details><details><summary id="two">More</summary>More content</details>');
  const restored = await runJevBrowserCheck(page, { action: 'disclosure', selector: '#one', restore: true });
  assert.ok(restored.inventory.links.some(link => link.label === 'Help'));
  assert.ok(!restored.restoredInventory.links.some(link => link.label === 'Help'));
  assert.equal(await page.locator('details').first().getAttribute('open'), null);
});

test('real browser scenarios exercise history, geometry, validation and images without submitting records', { timeout: 60000 }, async t => {
  let writes = 0;
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET') writes++;
    if (request.url === '/ok.svg') { response.writeHead(200, { 'Content-Type': 'image/svg+xml' }); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>'); return; }
    if (request.url === '/missing.png' || request.url === '/broken') { response.writeHead(404); response.end('Missing'); return; }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html><head><title>QA fixture</title><style>body{margin:0} .overflow{width:1100px;height:20px}</style></head><body>
      <h1>${request.url === '/help' ? 'Help' : 'Home'}</h1><a id="help" href="/help">Help</a><a id="broken" href="/broken">Broken</a>
      <div class="overflow">Intentional horizontal overflow</div>
      <form method="post" action="/records"><input id="email" name="email" type="email" required><button>Create record</button></form>
      <input type="search" id="search" disabled><details><summary id="details">Details</summary><p>Expanded content</p></details>
      ${'<img style="display:none" src="/missing.png">'.repeat(12)}
      <img src="/ok.svg" alt="working"><img src="/missing.png" alt="broken">
      </body></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  const inspected = await runJevBrowserCheck(page, { action: 'inspect' });
  assert.equal(inspected.success, true); assert.equal(inspected.inventory.forms.length, 1);
  assert.ok(inspected.inventory.links.some(link => link.href === origin + '/help'));
  const layout = await runJevBrowserCheck(page, { action: 'responsive' });
  assert.equal(layout.success, true); assert.equal(layout.assertions.length, 6);
  assert.ok(layout.assertions.some(item => item.outcome === 'fail' && item.name.includes('390px')));
  assert.deepEqual(page.viewportSize(), { width: 1440, height: 900 });
  const validation = await runJevBrowserCheck(page, { action: 'forms' });
  assert.equal(validation.assertions.length, 3); assert.ok(validation.assertions.every(item => item.outcome === 'pass'));
  assert.equal(await page.locator('#email').inputValue(), ''); assert.equal(writes, 0);
  const search = await runJevBrowserCheck(page, { action: 'search' });
  assert.equal(search.assertions[0].outcome, 'fail');
  const media = await runJevBrowserCheck(page, { action: 'media' });
  assert.equal(media.assertions.length, 2); assert.equal(media.assertions.filter(item => item.outcome === 'fail').length, 1);
  const disclosure = await runJevBrowserCheck(page, { action: 'disclosure', selector: '#details' });
  assert.equal(disclosure.assertions[0].outcome, 'pass');
  const navigation = await runJevBrowserCheck(page, { action: 'navigation', selector: '#help', expected: origin + '/help' });
  assert.equal(navigation.success, true); assert.equal(navigation.assertions.length, 4);
  assert.ok(navigation.assertions.every(item => item.outcome === 'pass'));
  assert.equal(page.url(), origin + '/help');
  const broken = await runJevBrowserCheck(page, { action: 'navigation', selector: '#broken', expected: origin + '/broken' });
  assert.equal(broken.success, true);
  assert.ok(broken.assertions.some(item => item.name.includes('second load') && item.outcome === 'fail'));
  await page.goto(origin);
  const refused = await runJevBrowserCheck(page, { action: 'navigation', selector: '#help', expected: 'https://attacker.test/' });
  assert.equal(refused.success, false); assert.equal(page.url(), origin + '/');
  assert.equal(writes, 0);
});

test('navigation button discovery excludes outside/form/destructive controls and quarantines writes before any pass', { timeout: 20000 }, async t => {
  let writes = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') { writes++; res.writeHead(405).end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Control safety fixture</title><nav><button id="projects" onclick="fetch('/delete',{method:'POST'}).catch(()=>{});document.querySelector('main').textContent='Changed'">Projects</button><button id="delete">Delete project</button><button id="hidden" hidden>Settings</button></nav><button id="outside">Projects</button><form><nav><button id="submit">Projects</button></nav></form><main>Initial content</main>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const observed = await runJevBrowserCheck(page, { action: 'inspect' });
  assert.deepEqual(observed.inventory.navigationControls.map(item => item.selector), ['#projects']);
  const outside = await runJevBrowserCheck(page, { action: 'navigation_control', selector: '#outside' });
  assert.equal(outside.success, false);
  assert.equal(outside.dispatched, false); assert.equal(outside.code, 'QA_CONTROL_STALE');
  assert.deepEqual(outside.inventory.navigationControls.map(item => item.selector), ['#projects']);
  const blocked = await runJevBrowserCheck(page, { action: 'navigation_control', selector: '#projects' });
  assert.equal(writes, 0); assert.equal(blocked.assertions.length, 0); assert.ok(blocked.blockedRequests.length);
  assert.match(blocked.gaps.join(' '), /blocked write/); assert.equal(await page.locator('main').textContent(), 'Initial content');
});

test('a late modal is reported before navigation dispatch, then a safe dismissal permits progress without forced clicking', { timeout: 20000 }, async t => {
  let visits = 0;
  const server = http.createServer((_req, res) => {
    visits++; res.setHeader('Content-Type', 'text/html');
    res.end('<title>Late overlay fixture</title><nav><button id="projects" onclick="location.href=\'/destination\'">Projects</button></nav><main>Workspace</main>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`; await page.goto(base);
  let shown = false;
  const options = { onAction: async step => {
    if (shown || step.phase !== 'before') return; shown = true;
    await page.evaluate(() => { const overlay = document.createElement('div'); overlay.id = 'late'; overlay.setAttribute('role', 'dialog'); overlay.style = 'position:fixed;inset:0;z-index:9999;background:white'; overlay.innerHTML = '<h2>Welcome</h2><button id="close-late">Close welcome</button>'; document.body.append(overlay); document.querySelector('#close-late').onclick = () => overlay.remove(); });
  } };
  const before = visits, blocked = await runJevBrowserCheck(page, { action: 'navigation_control', selector: '#projects' }, options);
  assert.equal(blocked.code, 'QA_CONTROL_OBSTRUCTED'); assert.equal(blocked.dispatched, false); assert.equal(blocked.assertions.length, 0);
  assert.equal(visits, before, 'A blocked pre-dispatch trial must not reload or re-open onboarding.');
  assert.equal(new URL(page.url()).pathname, '/');
  const dismissed = await runJevBrowserCheck(page, { action: 'dismiss_overlay', selector: blocked.inventory.overlays[0].close.selector });
  assert.equal(dismissed.assertions[0].outcome, 'pass');
  const progressed = await runJevBrowserCheck(page, { action: 'navigation_control', selector: '#projects' });
  assert.equal(progressed.success, true); assert.equal(new URL(progressed.inventory.url).pathname, '/destination');
  assert.equal(new URL(page.url()).pathname, '/', 'Source restoration remains intact.');
});

test('navigation restoration releases its temporary guard while retaining the host policy and observed feature evidence', { timeout: 30000 }, async t => {
  let bootstraps = 0, unsafeWrites = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/approved-bootstrap' && req.method === 'POST') { bootstraps++; res.end('ok'); return; }
    if (req.method !== 'GET') { unsafeWrites++; res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<body>Loading...<script>fetch('/approved-bootstrap',{method:'POST'}).then(()=>{document.body.innerHTML='<nav><button id="projects">Projects</button></nav><main><h1>Workspace</h1></main>';document.querySelector('#projects').onclick=()=>{fetch('/telemetry',{method:'POST'}).catch(()=>{});document.querySelector('main').innerHTML='<h1>Projects</h1><input type="search" placeholder="Search projects">';};});</script>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch(); t.after(() => browser.close()); const context = await browser.newContext();
  // Explicit fixture host policy: only its provisioned read bootstrap may POST.
  await context.route('**/*', route => route.request().method() === 'GET' || new URL(route.request().url()).pathname === '/approved-bootstrap' ? route.continue() : route.abort());
  const page = await context.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await runJevBrowserCheck(page, { action: 'navigation_control', selector: '#projects' });
  assert.equal(result.success, true); assert.equal(result.inventory.readiness.ready, true);
  assert.ok(result.transition); assert.equal(result.inventory.search.length, 1);
  assert.equal(result.assertions.length, 0, 'Blocked dependencies retain uncertainty; observed state is not a correctness pass.');
  assert.equal(result.restoredInventory.readiness.ready, true); assert.deepEqual(result.restoredInventory.headings, ['Workspace']);
  assert.equal(bootstraps, 2); assert.equal(unsafeWrites, 0);
});

test('a loading shell is neither an executed media check nor a discovered destination feature', { timeout: 30000 }, async t => {
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<nav><button id="projects" onclick="document.body.textContent=\'Loading...\'">Projects</button></nav><h1>Workspace</h1>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const navigation = await runJevBrowserCheck(page, { action: 'navigation_control', selector: '#projects' });
  assert.equal(navigation.inventory.readiness.ready, false); assert.equal(navigation.transition, undefined);
  assert.equal(navigation.assertions.length, 0); assert.match(navigation.gaps.join(' '), /loading/);
  await page.setContent('Loading...');
  const media = await runJevBrowserCheck(page, { action: 'media' });
  assert.equal(media.code, 'QA_PAGE_NOT_READY'); assert.equal(media.dispatched, false); assert.deepEqual(media.assertions, []);
});
