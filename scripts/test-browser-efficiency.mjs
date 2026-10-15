import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { attachBrowserBridge } from '../server/browserBridge.js';
import { createBrowserPolicy } from '../server/browserPolicy.js';

// Real SDK and Chromium; all interactions remain in this isolated fixture.
const fixture = `<!doctype html><meta name="viewport" content="width=device-width"><title>Late controls fixture</title>
<style>.layout{height:1px}button{min-height:44px}</style>
${Array.from({length:560}, (_,i)=>`<div class="layout">Layout ${i}</div>`).join('')}
<button data-test="billing" hidden>Hidden billing duplicate</button>
<button data-test="billing" onclick="this.setAttribute('aria-pressed','true');document.querySelector('#result').textContent='Annual selected'">Annual billing</button>
<button data-cy="details">Plan details</button><button data-testid="compare">Compare plans</button><p id="result">Monthly selected</p>`;
const server = createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end(fixture);});
server.listen(0,'127.0.0.1');
await once(server,'listening');
const targetUrl=`http://127.0.0.1:${server.address().port}/`;
const { CleanSlateNodeBrowserAutomation } = await import(new URL('./node/cleanSlateNodeBrowserAutomation.js',import.meta.resolve('@cleanslate/sdk')));
const results=[];
try {
  for (const device of ['desktop','iphone-15-pro']) {
    const service=new CleanSlateNodeBrowserAutomation({headless:true});
    const session={id:'efficiency-fixture',targetUrl,device,messages:[],status:'running'};
    const store={publish(){},async commit(){}};
    const policy=createBrowserPolicy({getTargetUrl:()=>targetUrl,environment:{NODE_ENV:'test',QASE_BROWSER_ALLOWED_PRIVATE_HOSTS:'127.0.0.1'}});
    const bridge=attachBrowserBridge(session,service,store,{policy});
    try {
      await service.open(targetUrl);bridge.stopFrames();
      const errors=[];service.activePage.on('pageerror',error=>errors.push(error.message));
      const snapshot=await service.snapshot('ide',{limit:20});
      const billing=snapshot.elements.find(element=>element.text==='Annual billing');
      assert.ok(billing,'One snapshot must discover the billing control after 560 layout nodes');
      assert.ok(snapshot.elements.length<=20);
      for (const label of ['Annual billing','Plan details','Compare plans']) {
        const element=snapshot.elements.find(item=>item.text===label);
        assert.ok(element,`${label} is included`);
        assert.equal(await service.activePage.locator(element.selector).count(),1,`${label} selector is unique including hidden duplicates`);
        assert.equal(await service.activePage.locator(element.selector).innerText(),label);
        const index=await service.activePage.locator('body *:visible').evaluateAll((nodes,text)=>nodes.findIndex(node=>node.textContent===text),label);
        assert.equal(element.id,`e${index+1}`,'SDK DOM indices remain stable');
      }
      assert.ok(!snapshot.elements.some(element=>element.text==='Hidden billing duplicate'));
      const total=await service.activePage.locator('body *:visible').count();
      assert.deepEqual(snapshot.elementCoverage,{total,returned:snapshot.elements.length,omitted:total-snapshot.elements.length});
      assert.ok(snapshot.elementCoverage.omitted>500);
      assert.equal(typeof snapshot.guidance,'string');assert.ok(snapshot.guidance.length>20);
      const clicked=await service.click('ide',{elementId:billing.id});
      assert.notEqual(clicked.success,false);
      assert.equal(await service.activePage.locator('#result').innerText(),'Annual selected');
      assert.deepEqual(errors,[]);
      await fs.mkdir('test-results/browser-efficiency',{recursive:true});
      await service.activePage.screenshot({path:`test-results/browser-efficiency/${device}.png`});
      results.push({device,passed:true,snapshots:1,actions:1,billingId:billing.id,coverage:snapshot.elementCoverage,pageErrors:errors});
    } finally {bridge.dispose();await service.dispose();}
  }
  await fs.writeFile('test-results/browser-efficiency/result.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
