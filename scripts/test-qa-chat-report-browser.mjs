import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { buildQaChatReport } from '../server/report.js';

// Real preview UI and production formatter; isolated fixtures prevent paid runs
// and writes to customer data. Backend persistence is tested by runTurn tests.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:5173';
const id = '12345678-1234-4234-8234-123456789abc';
const browser = await chromium.launch();
const checks = [];
const errors = [];
const output = 'test-results/qa-chat-report';
const finding = (severity,title,actual) => ({id:severity,severity,title,actual,expected:'The control should work.',category:'functional',steps:[]});
try {
  await fs.mkdir(output,{recursive:true});
  for (const scenario of ['issues','no-issues','blocked']) {
    const session = {id,title:'QA chat report fixture',mode:'qa',status:'running',createdAt:Date.now(),updatedAt:Date.now(),activities:[],todos:[],secretNames:[],messages:[{id:'promise',role:'agent',text:'I will publish the report now.',ts:Date.now()}],
      findings:scenario === 'issues' ? [finding('low','Footer layout','Footer overlaps the page.'),finding('high','Checkout fails','Submitting checkout returns an error.')] : [],
      report:{verdict:scenario === 'issues' ? 'pass_with_issues' : scenario === 'blocked' ? 'blocked' : 'pass',summary:scenario === 'issues' ? 'Checkout and footer problems were observed.' : scenario === 'blocked' ? 'Login prevented access to the account pages.' : 'The exercised public flows completed successfully.',covered:['Public landing page'],notCovered:scenario === 'blocked' ? ['Account pages behind login'] : [],generatedAt:new Date().toISOString()}};
    const text = buildQaChatReport(session);
    assert.equal(typeof text,'string');
    assert.ok(text.length < 2500,'Chat report remains concise');
    const message = {id:`report-${scenario}`,role:'agent',kind:'qa-report',text,ts:Date.now()};
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(() => {
      window.EventSource = class {
        constructor() {window.fixtureStream=this;setTimeout(()=>this.onopen?.(),0);}
        close() {}
      };
    });
    await page.route('**/api/**',async route=>{
      assert.equal(route.request().method(),'GET','Fixture cannot mutate production');
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname === '/api/auth/me' ? {id:'fixture',displayName:'Fixture'}
        : pathname === '/api/config' ? {provider:'custom',model:'fixture',ready:true,hasApiKey:true,providers:['custom']}
        : pathname === '/api/devices' ? {default:'desktop',devices:[{id:'desktop',label:'Desktop',kind:'desktop'}]}
        : pathname === '/api/sessions' ? [session]
        : pathname === `/api/sessions/${id}` ? session : {};
      await route.fulfill({json:body});
    });
    await page.goto(base);
    await page.waitForFunction(()=>document.querySelector('#conn-label')?.textContent === 'connected');
    await page.locator('#transcript').getByText('I will publish the report now.',{exact:true}).waitFor();
    await page.evaluate(({id,message})=>{
      window.fixtureStream.onmessage({data:JSON.stringify({sessionId:id,type:'message',message})});
      window.fixtureStream.onmessage({data:JSON.stringify({sessionId:id,type:'status',status:'done'})});
    },{id,message});
    session.messages.push(message);session.status='done';
    const last = page.locator('#transcript .msg').last();
    assert.match(await last.getAttribute('class'),/qa-report/);
    const rendered = await last.innerText();
    assert.match(rendered,/Report/);assert.match(rendered,/Findings/);
    if (scenario === 'issues') {
      assert.match(rendered,/Pass with issues/i);assert.match(rendered,/2/);
      assert.match(rendered,/high/i);assert.match(rendered,/Submitting checkout returns an error/);
      assert.ok(rendered.indexOf('Checkout fails') < rendered.indexOf('Footer layout'),'High severity appears first');
    } else if (scenario === 'blocked') {
      assert.match(rendered,/Blocked/i);assert.match(rendered,/Account pages behind login/);
    } else {
      assert.match(rendered,/Pass/i);assert.match(rendered,/no (?:issues|findings)|0 (?:issues|findings)/i);
    }
    await last.scrollIntoViewIfNeeded();
    await page.screenshot({path:`${output}/${scenario}-desktop.png`});
    await page.reload();
    await page.locator('#transcript .qa-report').waitFor();
    assert.equal(await page.locator('#transcript .qa-report').count(),1);
    assert.equal(await page.locator('#transcript .msg').last().innerText(),rendered,'Reload renders durable final chat report');
    await page.setViewportSize({width:390,height:844});
    await page.locator('#transcript .qa-report').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#transcript .qa-report').isVisible(),true);
    await page.screenshot({path:`${output}/${scenario}-mobile.png`});
    checks.push(`${scenario}: concise report arrives last in chat, survives snapshot reload once, renders on desktop/mobile`);
    await page.close();
  }
  assert.deepEqual(errors,[]);
  const result={passed:true,base,checks,pageErrors:errors,limitations:'Real formatter and live UI; controlled API/SSE snapshots. Actual backend persistence covered separately by unit/integration tests.'};
  await fs.writeFile(`${output}/result.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
