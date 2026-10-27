import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { runJevBrowserCheck } from './jevBrowserChecks.js';

test('fragment links detect missing targets, accept custom handlers, and exclude unsafe links', { timeout: 30000 }, async t => {
  let writes = 0;
  const html = `<title>Anchors</title><style>html{scroll-behavior:smooth}#target{margin-top:1600px}</style><a id="good" href="#target">Details</a><section id="target">Destination</section>
    <a id="bad" href="#missing">Missing section</a><a href="#custom" onclick="document.body.innerHTML='<h1>Article reader</h1>'">Open article</a>
    <a href="#network" onclick="fetch('/records',{method:'POST'});event.preventDefault()">Remote panel</a>
    <a href="#target-again">Another section</a><section id="target-again">Still tested after the article view</section>
    <a href="#delete">Delete account</a><a href="#!router">Hash router</a><a href="#/router">Hash path</a>`;
  const server = http.createServer((req, res) => { if (req.method !== 'GET') writes++; res.setHeader('Content-Type', 'text/html'); res.end(html); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await runJevBrowserCheck(page, { action: 'anchors' });
  assert.equal(result.success, true, result.error);
  assert.equal(result.assertions.filter(item => item.outcome === 'fail').length, 1);
  assert.equal(result.assertions.find(item => item.outcome === 'fail').reproduction.confirmed, true);
  assert.match(result.assertions.find(item => item.outcome === 'fail').actual, /missing/);
  assert.ok(result.trials.filter(item => item.skipped).length >= 2);
  assert.ok(result.trials.some(item => item.executed && item.href.endsWith('#target-again')), 'Restore the source DOM after custom hash routing, then continue remaining links.');
  assert.ok(!result.trials.some(item => item.skipped?.includes('Timeout')));
  assert.equal(writes, 0);
  assert.equal(new URL(page.url()).hash, '');
});

test('tabs verify actual selection and controlled panel, restore original tab, and do not create remote data', { timeout: 30000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<title>Tabs</title><div role="tablist">
    <button id="first" role="tab" aria-selected="true" aria-controls="one">Overview</button>
    <button id="second" role="tab" aria-selected="false" aria-controls="two">Details</button></div>
    <section id="one">First panel</section><section id="two" hidden>Second panel</section>
    <script>for(const el of document.querySelectorAll('[role=tab]'))el.onclick=()=>{for(const tab of document.querySelectorAll('[role=tab]')){tab.setAttribute('aria-selected',String(tab===el));document.getElementById(tab.getAttribute('aria-controls')).hidden=tab!==el}}</script>`);
  const working = await runJevBrowserCheck(page, { action: 'tabs' });
  assert.equal((await runJevBrowserCheck(page, { action: 'inspect' })).inventory.disclosures.length, 0, 'A tab named Details is not a disclosure.');
  assert.equal(working.assertions.length, 2);
  assert.ok(working.assertions.every(item => item.outcome === 'pass'));
  assert.equal(await page.locator('#first').getAttribute('aria-selected'), 'true');
  await page.locator('#second').evaluate(el => el.onclick = () => { document.querySelector('#first').setAttribute('aria-selected', 'false'); el.setAttribute('aria-selected', 'true'); });
  const broken = await runJevBrowserCheck(page, { action: 'tabs' });
  assert.equal(broken.assertions.filter(item => item.outcome === 'fail').length, 1);
  assert.equal(broken.assertions.at(-1).reproduction.confirmed, true);
  assert.match(broken.assertions.at(-1).actual, /"panelVisible":false/);
  await page.locator('#second').evaluate(el => el.onclick = () => { fetch('https://dependency.test/write', { method: 'POST' }).catch(() => {}); });
  const dependent = await runJevBrowserCheck(page, { action: 'tabs' });
  assert.ok(dependent.trials.some(item => item.skipped));
  assert.ok(dependent.assertions.every(item => item.outcome === 'pass'));
});

test('expanded ARIA without a visible panel is a reproduced defect; mobile menus are exercised and viewport restored', { timeout: 30000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setContent(`<title>False expanded</title><button id="faq" aria-controls="panel" aria-expanded="false" onclick="this.setAttribute('aria-expanded',this.getAttribute('aria-expanded')==='true'?'false':'true')">FAQ</button><section id="panel" hidden>Invisible answer</section>`);
  const disclosure = await runJevBrowserCheck(page, { action: 'disclosure', selector: '#faq', restore: true });
  assert.equal(disclosure.assertions[0].outcome, 'pass', 'Attribute-only response is not the full oracle.');
  assert.equal(disclosure.assertions[1].outcome, 'fail');
  assert.equal(disclosure.assertions[1].reproduction.confirmed, true);
  assert.equal(await page.locator('#faq').getAttribute('aria-expanded'), 'false');
  await page.setContent(`<title>Mobile fixture</title><style>#menu{display:none}@media(max-width:500px){#menu{display:block}}</style><button id="menu" aria-controls="panel" aria-expanded="false">Menu</button><section id="panel" hidden>Mobile routes</section>`);
  const responsive = await runJevBrowserCheck(page, { action: 'responsive' });
  assert.ok(responsive.interactions.some(item => item.width === 390));
  assert.ok(responsive.assertions.some(item => item.outcome === 'fail' && item.reproduction?.confirmed));
  assert.deepEqual(page.viewportSize(), { width: 1440, height: 900 });
});

test('FAQ discovery is not truncated to two or six controls and excludes form submission', { timeout: 10000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<title>Questions</title><div class="faq">${Array.from({ length: 12 }, (_, i) => `<button>Question ${i}?</button>`).join('')}<form><button>Send question?</button></form></div>`);
  const inventory = await runJevBrowserCheck(page, { action: 'inspect' });
  assert.equal(inventory.inventory.disclosures.length, 12);
  assert.equal(inventory.inventory.totalDisclosures, 12);
});

test('closed details links are not visible candidates; network-dependent disclosure cannot submit or confirm a defect', { timeout: 15000 }, async t => {
  let writes = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') writes++;
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Safe controls</title><details><summary>More</summary><a id="hidden" href="/deep">Guide</a></details><button id="remote" aria-expanded="false" aria-controls="panel" onclick="fetch(\'/write\',{method:\'POST\'}).catch(()=>{})">Menu</button><section id="panel" hidden>Remote content</section>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  const before = await runJevBrowserCheck(page, { action: 'inspect' });
  assert.ok(!before.inventory.links.some(link => link.selector === '#hidden'));
  const opened = await runJevBrowserCheck(page, { action: 'disclosure', selector: 'summary', restore: true });
  assert.ok(opened.inventory.links.some(link => link.selector === '#hidden'));
  assert.ok(!opened.restoredInventory.links.some(link => link.selector === '#hidden'));
  const dependent = await runJevBrowserCheck(page, { action: 'disclosure', selector: '#remote', restore: true });
  assert.equal(dependent.success, true); assert.equal(dependent.assertions.length, 0);
  assert.ok(dependent.blockedRequests.length); assert.equal(writes, 0);
});

test('bounded document exploration reveals lazy controls and restores scroll position', { timeout: 15000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.setContent(`<title>Lazy content</title><h1>Home</h1><div style="height:1500px"></div><div id="lazy" style="opacity:0"><button role="tab" aria-selected="true">Late tab</button></div><script>new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))lazy.style.opacity='1'}).observe(lazy)</script>`);
  const before = await runJevBrowserCheck(page, { action: 'inspect' });
  assert.equal(before.inventory.tabs.length, 0);
  const scrolled = await runJevBrowserCheck(page, { action: 'scroll' });
  assert.equal(scrolled.success, true);
  assert.equal(scrolled.inventory.tabs.length, 1);
  assert.ok(scrolled.samples.length > 1);
  assert.equal(scrolled.remainingScroll, 0);
  assert.equal(await page.evaluate(() => scrollY), 0);
});
