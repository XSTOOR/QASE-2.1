import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Load real deployed UI assets, isolating API/SSE fixtures from customer runs.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:5173';
const id = '12345678-1234-4234-8234-123456789abc';
const report = { generatedAt:'2026-09-13T00:00:00.000Z', executiveSummary:'Completion fixture founder thesis', coverage:{categoriesReviewed:[],totalCategories:0,evidenceBackedObservations:0} };
const fixture = (status = 'running', mode = 'founder', finalized = false) => ({ id, title:'Founder completion fixture', mode, status, createdAt:Date.now(),updatedAt:Date.now(),messages:[],activities:[],findings:[],todos:[],secretNames:[],founder:{scope:{target:{name:'Fixture',url:'https://example.test'},categories:[]},observations:[],...(finalized ? {report,finalizedAt:report.generatedAt} : {})} });
const browser = await chromium.launch();
const checks = [];
const errors = [];
async function open(session) {
  const alternate = {...structuredClone(session),id:'12345678-1234-4234-8234-123456789abd',title:'Alternate completion fixture'};
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() { window.fixtureStream = this; setTimeout(() => this.onopen?.(), 0); }
      close() {}
    };
  });
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    assert.equal(route.request().method(), 'GET', 'Browser fixture must never mutate production');
    const body = pathname === '/api/auth/me' ? {id:'fixture',displayName:'Fixture'}
      : pathname === '/api/config' ? {provider:'custom',model:'fixture',ready:true,hasApiKey:true,providers:['custom']}
      : pathname === '/api/devices' ? {default:'desktop',devices:[{id:'desktop',label:'Desktop',kind:'desktop'}]}
      : pathname === '/api/sessions' ? [session,alternate]
      : pathname === `/api/sessions/${alternate.id}` ? alternate
      : pathname === `/api/sessions/${id}` ? session : {};
    await route.fulfill({json:body});
  });
  await page.goto(base);
  await page.waitForFunction(() => /Fixture|Founder completion fixture/.test(document.querySelector('#chat-title')?.textContent ?? ''));
  await page.waitForFunction(() => document.querySelector('#conn-label')?.textContent === 'connected');
  return page;
}
const selected = page => page.locator('#tab-report').getAttribute('aria-selected');
const emit = (page, event) => page.evaluate(data => window.fixtureStream.onmessage({data:JSON.stringify(data)}), {sessionId:id,ts:Date.now(),...event});
try {
  for (const ordering of ['report-first','status-first']) {
    const page = await open(fixture());
    await page.locator('#tab-activity').click();
    const first = ordering === 'report-first' ? {type:'founder.finalized',report} : {type:'status',status:'done'};
    const second = ordering === 'report-first' ? {type:'status',status:'done'} : {type:'founder.finalized',report};
    await emit(page,first);
    assert.equal(await selected(page),'false',`${ordering} waits for both signals`);
    await emit(page,second);
    assert.equal(await selected(page),'true',`${ordering} selects report`);
    assert.equal(await page.locator('#pane-report').isVisible(),true);
    await page.locator('#pane-report').getByText(report.executiveSummary,{exact:true}).waitFor();
    await page.locator('#tab-activity').click();
    await emit(page,first); await emit(page,second);
    assert.equal(await selected(page),'false','Repeated completion preserves manual choice');
    checks.push(`${ordering}: opens visible founder report once; repeated events preserve Activity`);
    await page.close();
  }
  const completed = await open(fixture('done','founder',true));
  assert.equal(await selected(completed),'true','Saved completed run selects report');
  await completed.locator('#pane-report').getByText(report.executiveSummary,{exact:true}).waitFor();
  await fs.mkdir('test-results/founder-completion',{recursive:true});
  await completed.screenshot({path:'test-results/founder-completion/desktop.png'});
  await completed.setViewportSize({width:390,height:844});
  assert.equal(await completed.locator('#pane-report').isVisible(),true);
  await completed.locator('#pane-report').scrollIntoViewIfNeeded();
  await completed.screenshot({path:'test-results/founder-completion/mobile.png'});
  checks.push('Saved completed run opens report at desktop and mobile sizes');
  await completed.setViewportSize({width:1440,height:1000});
  await completed.locator('#tab-activity').click();
  await completed.locator('.run').filter({hasText:'Alternate completion fixture'}).click();
  await completed.waitForFunction(() => document.querySelector('#tab-report').getAttribute('aria-selected') === 'true');
  await completed.locator('#tab-activity').click();
  await completed.locator('.run').filter({hasText:'Founder completion fixture'}).click();
  await completed.waitForFunction(() => document.querySelector('#tab-report').getAttribute('aria-selected') === 'true');
  checks.push('Switching to another completed session and reopening first both select their reports');
  await completed.close();
  const session = fixture();
  const reconnect = await open(session);
  Object.assign(session,fixture('done','founder',true));
  await reconnect.evaluate(() => window.fixtureStream.onopen());
  await reconnect.waitForFunction(() => document.querySelector('#tab-report').getAttribute('aria-selected') === 'true');
  await reconnect.locator('#tab-activity').click();
  await reconnect.evaluate(() => window.fixtureStream.onopen());
  await reconnect.waitForTimeout(300);
  assert.equal(await selected(reconnect),'false');
  checks.push('Reconnect snapshot opens completed report; duplicate reconnect preserves manual choice');
  await reconnect.close();
  for (const [status,mode,finalized] of [['running','founder',true],['error','founder',true],['stopped','founder',true],['done','founder',false],['done','qa',true],['done','sqa',true]]) {
    const page = await open(fixture(status,mode,finalized));
    assert.equal(await selected(page),'false',`${mode}/${status}/${finalized} must not auto-open`);
    checks.push(`${mode}/${status}/finalized=${finalized}: no automatic report selection`);
    await page.close();
  }
  assert.deepEqual(errors,[],'No browser runtime errors');
  const result = {passed:true,base,checks,pageErrors:errors,limitations:'API and EventSource are controlled fixtures; real live UI assets are loaded. No paid agent run or production mutation.'};
  await fs.writeFile('test-results/founder-completion/result.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally { await browser.close(); }
