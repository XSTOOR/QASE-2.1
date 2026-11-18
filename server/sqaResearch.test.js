import {modeDiscoveryStatus} from './modeDiscovery.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalModeHash} from './modeIntegrity.js';
import {createSqaResearch} from './sqaResearch.js';
function fixture(){
 const inventory={url:'https://project.test/',stateKey:'home',title:'Project',ready:true,headings:['Project'],links:[],navigationControls:[],tabs:[],disclosures:[],forms:[],search:[],controls:[]};
 const receipt={id:'r',actionId:'a',activityId:'activity',inventory};receipt.digest=canonicalModeHash(['run','sqa','a','activity',inventory]);
 const session={id:'run',mode:'sqa',sqa:{execution:{actions:[{id:'a',status:'done',tool:'browser_qa_check'}],discovery:{version:1,hashVersion:1,status:'ready',receipts:[receipt],proofIds:['r']}}},activities:[{id:'activity',status:'done',toolName:'browser_qa_check'}]};
 let commits=0,calls=0;
 const content='Fixture Standard 1.0. Control A-1: All visible inputs must have accessible names.';
 const tools=createSqaResearch({session,checkpoint:async()=>{commits++;},env:{},now:()=>1000,retrieve:async url=>{calls++;return {url,finalUrl:url,retrievedAt:1000,contentType:'text/plain',content,contentHash:createHash('sha256').update(content).digest('hex'),hops:[]};}});
 return {session,tools:Object.fromEntries(tools.map(t=>[t.name,t])),calls:()=>calls,commits:()=>commits};
}
test('research requires intact actual discovery and fails clearly without a search provider',async()=>{
 const f=fixture();await assert.rejects(f.tools.web_search.run({query:'public standard'}),/not configured/);assert.equal(f.calls(),0);
 f.session.sqa.execution.discovery.receipts[0].inventory.title='forged';
 await assert.rejects(f.tools.web_fetch.run({url:'https://example.com'}),/Observe/);assert.equal(f.calls(),0);
});
test('source provenance survives serialization and fabricated requirements or modified URLs are rejected',async()=>{
 const f=fixture();const fetched=await f.tools.web_fetch.run({url:'https://example.com/standard'});
 assert.equal(fetched.authority,'unverified');assert.ok(f.commits()>0);
 const input={source_id:fetched.sourceId,framework:'Fixture Standard',control_id:'A-1',quote:'All visible inputs must have accessible names.'};
 const result=await f.tools.sqa_record_requirement.run(input);
 assert.equal(result.requirement.applicability,'POTENTIALLY_APPLICABLE');
 assert.equal(result.requirement.authority,'unverified');
 await assert.rejects(f.tools.sqa_record_requirement.run({...input,quote:'Every company must obtain certification immediately.'}),/actual retrieved source/);
 const research=JSON.parse(JSON.stringify(f.session.sqa.execution.research));
 assert.equal(research.sources[0].publisher,null);assert.equal(research.sources[0].version,null);
 f.session.sqa.execution.research.sources[0].finalUrl='https://invented.test/';
 await assert.rejects(f.tools.sqa_record_requirement.run(input),/modified/);
});
test('source identifiers cannot be borrowed from another project',async()=>{
 const first=fixture(),second=fixture();const source=await first.tools.web_fetch.run({url:'https://example.com'});
 await assert.rejects(second.tools.sqa_record_requirement.run({source_id:source.sourceId}),/Missing/);
 assert.equal(second.session.sqa.execution.research.sources.length,0);
});

test('feature-linked research can support a recommendation while legal applicability stays unresolved',async()=>{
 const f=fixture();
 const source=await f.tools.web_fetch.run({url:'https://example.com/standard'});
 const {requirement}=await f.tools.sqa_record_requirement.run({source_id:source.sourceId,framework:'Fixture Standard',control_id:'A-1',quote:'All visible inputs must have accessible names.'});
 const input={requirement_ids:[requirement.id],feature_ids:[modeDiscoveryStatus(f.session).features[0].id],classification:'RECOMMENDED',obligation:'recommended_practice',jurisdiction:'unknown',rationale:'Visible user interface',assumptions:['Markets are unknown']};
 const apply=f.tools.sqa_record_applicability.run;
 for(const classification of ['CONFIRMED_APPLICABLE','NOT_APPLICABLE'])await assert.rejects(apply({...input,classification}),/organizational facts/);
 await assert.rejects(apply({...input,feature_ids:['invented']}),/observed feature/);
 const {decision}=await apply(input);
 assert.equal(decision.authority,'hypothesis');
 assert.equal(f.session.sqa.execution.research.stage,'APPLICABILITY_ANALYSIS');
 assert.equal(f.session.sqa.execution.research.applicability.length,1);
});

test('retrying a fresh source and applicability decision reuses the original receipts', async()=>{
 const f=fixture(),fetch=f.tools.web_fetch.run;
 const src=await fetch({url:'https://example.com/standard'});
 const cached=await fetch({url:'https://example.com/standard'});
 assert.equal(cached.sourceId,src.sourceId);assert.equal(f.calls(),1);
 const input={source_id:src.sourceId,framework:'Fixture Standard',control_id:'A-1',quote:'All visible inputs must have accessible names.'};
 const first=await f.tools.sqa_record_requirement.run(input);
 assert.deepEqual(await f.tools.sqa_record_requirement.run(input),first);
 const decision={requirement_ids:[first.requirement.id],feature_ids:[modeDiscoveryStatus(f.session).features[0].id],classification:'RECOMMENDED',obligation:'recommended_practice',jurisdiction:'unknown',rationale:'Observed form',assumptions:[]};
 assert.deepEqual(await f.tools.sqa_record_applicability.run(decision),await f.tools.sqa_record_applicability.run(decision));
 assert.equal(f.session.sqa.execution.research.applicability.length,1);
});

test('direct service finalization cannot publish incomplete standalone research',async()=>{
 const {finishSqaAssessment}=await import('./sqaService.js');
 const f=fixture();
 f.session.sqa.execution.strategy='sqa-single-reasoner-v1';
 await assert.rejects(finishSqaAssessment(f.session,{commit(){assert.fail('premature commit');}}),/incomplete|research/);
 assert.equal(f.session.sqa.finalizedAt,undefined);
});

test('document review requires an identified reviewer and binds the scoped decision to a document digest',async()=>{
 const {recordSqaDocumentReview,applicabilityReviewIds}=await import('./sqaDocumentReview.js');
 const f=fixture(),s=f.session;
 s.sqa.execution.strategy='sqa-single-reasoner-v1';
 const src=await f.tools.web_fetch.run({url:'https://example.com/standard'});
 const {requirement}=await f.tools.sqa_record_requirement.run({source_id:src.sourceId,framework:'Fixture Standard',control_id:'A-1',quote:'All visible inputs must have accessible names.'});
 const featureId=modeDiscoveryStatus(s).features[0].id;
 const input={requirementId:requirement.id,featureId,determination:'CONFIRMED_APPLICABLE',obligation:'contractual',jurisdiction:'contract scope',documentText:'Private agreement applies to the reviewed form.',excerpt:'applies to the reviewed form.'};
 const actor={role:'owner',actorUserId:'reviewer'},store={async commit(){}};
 await assert.rejects(recordSqaDocumentReview(s,input,{role:'developer'},store),/owner/);
 await assert.rejects(recordSqaDocumentReview(s,{...input,featureId:'other'},actor,store),/in this assessment/);
 await assert.rejects(recordSqaDocumentReview(s,input,actor,{async commit(){throw Error('storage unavailable');}}),/storage unavailable/);
 assert.equal(s.sqa.execution.research.documentReviews.length,0);
 const receipt=await recordSqaDocumentReview(s,input,actor,store);
 assert.deepEqual(await recordSqaDocumentReview(s,input,actor,store),receipt);
 assert.doesNotMatch(JSON.stringify(s.sqa),/Private agreement/);
 const decision={classification:input.determination,obligation:input.obligation,jurisdiction:input.jurisdiction,feature_ids:[featureId]};
 assert.equal(applicabilityReviewIds(s,decision,[requirement]),null);
 const source=s.sqa.execution.research.sources[0];
 source.authority='verified_official';source.superseded=false;
 assert.deepEqual(applicabilityReviewIds(s,decision,[requirement]),[receipt.id]);
 assert.equal(applicabilityReviewIds(s,{...decision,obligation:'legal'},[requirement]),null);
 await recordSqaDocumentReview(s,{...input,determination:'INSUFFICIENT'},actor,store);
 assert.equal(applicabilityReviewIds(s,decision,[requirement]),null);
});

test('reviewer scope evidence stays with its requirement and preserves the browser failure',async()=>{
 const {sqaResearchSections}=await import('../public/sqaResearchSections.js');
 const requirement={id:'r1',framework:'Practice',controlId:'A',quote:'Name controls.',requirementResult:'NOT_VERIFIABLE',testIds:['form']};
 const report={profile:[{id:'button',name:'Demo button'}],references:[],limitations:[],blockers:[],documents:[],metrics:{},
  requirements:[requirement,{...requirement,id:'r2',controlId:'B',testIds:[]}],
  decisions:[{requirement_ids:['r1'],feature_ids:['button'],classification:'RECOMMENDED',rationale:'Observed form',assumptions:[]}],
  tests:[{id:'form',objective:'Inspect form',method:[],observations:[]}],
  findings:[{testId:'form',title:'Control has an accessible name',expected:'A label',observed:'{"kind":"control","tag":"button","selector":"#submit","name":""}',evidenceId:'receipt-1'}]};
 const rows=()=>sqaResearchSections(report).slice(0,2).map(([,lines])=>lines.join('\n'));
 const [before]=rows();
 assert.match(before,/Which product features/);
 report.documents.push({requirementId:'r1',featureId:'button',determination:'CONFIRMED_APPLICABLE'});
 const [reviewed,unrelated]=rows();
 assert.match(reviewed,/Reviewer record · Demo button · confirmed applicable/);
 assert.doesNotMatch(reviewed,/Which product features/);
 for(const version of [before,reviewed]) {
  assert.match(version,/button #submit has an empty accessible name/);
  assert.match(version,/receipt-1/);
  assert.match(version,/rest of the requirement/);
 }
 assert.match(unrelated,/Which product features/);
 assert.doesNotMatch(unrelated,/receipt-1|confirmed applicable/);
});

test('research export preserves citation, uncertainty and missing coverage in Markdown and PDF HTML',async()=>{
 const {buildResearchReport}=await import('./sqaResearchReport.js');
 const {researchMarkdown}=await import('../public/sqaResearchSections.js');
 const {buildReportHtml}=await import('./reportPdf.js');
 const f=fixture(),session=f.session;session.targetUrl='https://project.test/';
 session.sqa.execution.strategy='sqa-single-reasoner-v1';
 const source=await f.tools.web_fetch.run({url:'https://example.com/standard'});
 await f.tools.sqa_record_requirement.run({source_id:source.sourceId,framework:'Fixture Standard',control_id:'A-1',quote:'All visible inputs must have accessible names.'});
 const report=buildResearchReport(session,1000);
 assert.equal(report.metrics.testsWithEvidence,0);assert.ok(report.blockers.some(v=>v.includes('applicability')));
 const serialized=JSON.parse(JSON.stringify(report));
 const markdown=researchMarkdown(serialized);
 assert.match(markdown,/Fixture Standard/);assert.match(markdown,/No reviewed organizational documents/);
 session.createdAt=1000;session.sqa.assessment={researchReport:serialized};
 assert.ok(buildReportHtml(session).includes(source.contentHash));
 session.sqa.execution.research.sources[0].content+=' altered';
 assert.ok(buildResearchReport(session,1000).blockers.some(v=>v.includes('Invalid source receipt')));
});

test('large source bodies round-trip through checkpoints and reject corrupt or cross-run records',async()=>{
 const {storeResearchBody,verifiedResearchBody}=await import('./sqaResearchSource.js');
 const body='Large fixed document paragraph. '.repeat(2000);
 const stored={...storeResearchBody(body),runId:'a',contentHash:createHash('sha256').update(body).digest('hex')};
 assert.ok(stored.gzipBody.length<body.length);
 stored.integrityHash=canonicalModeHash(stored);
 assert.equal(verifiedResearchBody(JSON.parse(JSON.stringify(stored)),'a'),body);
 assert.equal(verifiedResearchBody(stored,'b'),null);
 assert.equal(verifiedResearchBody({...stored,gzipBody:'corrupt'},'a'),null);
});

test('the reasoner can read a later source excerpt without a second fetch or replaying the full body',async()=>{
 const f=fixture();
 const content='<section id="sample">'+'Page body '.repeat(3500)+'Control T-1: Subsequent section.';
 let requests=0;
 const sourceTools=createSqaResearch({session:f.session,checkpoint:async()=>{},now:()=>1000,retrieve:async url=>{
  requests++;return {url,finalUrl:url,content,retrievedAt:1000,contentHash:createHash('sha256').update(content).digest('hex')};
 }});
 const fetch=sourceTools.find(t=>t.name==='web_fetch');
 const first=await fetch.run({url:'https://example.com/paged'});
 assert.ok(first.content.length <= 3000);
 assert.deepEqual(first.sectionLocators,[{id:'sample',offset:0}]);
 const next=await fetch.run({url:'https://example.com/paged',offset:first.nextOffset});
 assert.equal(first.content+next.content,content.slice(0,next.nextOffset));
 const hit=await fetch.run({url:'https://example.com/paged',find:'Control T-1'});
 assert.equal(hit.content,'Control T-1: Subsequent section.');
 assert.equal((await fetch.run({url:'https://example.com/paged',find:'absent'})).matchFound,false);assert.equal(next.sourceId,first.sourceId);assert.equal(requests,1);
 const index=await sourceTools.find(t=>t.name==='sqa_read_research').run({});
 assert.equal(index.sources[0].gzipBody,undefined);assert.equal(index.sources[0].content,undefined);
});

test('publisher passage offsets restore exact markup, title and section from the saved edition',async()=>{
 const f=fixture();
 const title='Example technical specification';
 const quote='Every <em>interactive</em> control must expose its name.';
 const content='<title>'+title+'</title><section id="control-names"><script>"<p>Script must never become a citation.</p>"</script><p>'+quote+'</p></section><p>Outside the source section.</p>';
 const url='https://example.com/edition';
 const source={id:'edition',runId:f.session.id,url,finalUrl:url,content,title,retrievedAt:1000,contentHash:createHash('sha256').update(content).digest('hex')};
 source.integrityHash=canonicalModeHash(source);
 f.session.sqa.execution.research.sources.push(source);
 const window=await f.tools.web_fetch.run({url});
 assert.deepEqual(window.citationOptions,[{offset:content.indexOf('<p>'+quote),controlId:'control-names',preview:'Every interactive control must expose its name.'}]);
 const record=f.tools.sqa_record_requirement.run;
 const input={source_id:source.id,citation_offset:window.citationOptions[0].offset};
 const {requirement}=await record(input);
 assert.equal(requirement.quote,quote);assert.equal(requirement.controlId,'control-names');assert.equal(requirement.framework,title);
 assert.equal((await record(input)).requirement.id,requirement.id);
 await assert.rejects(record({...input,citation_offset:input.citation_offset+1}),/passage/);
 await assert.rejects(record({...input,citation_offset:content.lastIndexOf('<p>')}),/passage/);
 await assert.rejects(record({...input,quote:'invented'}),/Choose/);
});

test('repeated naming failures on the same element preserve both receipts in one finding',async()=>{
 const {researchFindings}=await import('./sqaResearchReport.js');
 const observation=(id,selector,url='/form')=>({evidenceId:id,url,assertions:[{outcome:'fail',name:'Missing name',actual:JSON.stringify({selector})}]});
 const result=researchFindings([{id:'workflow',observations:[observation('a','#button'),observation('b','#button'),observation('c','#other'),observation('d','#button','/other')]}]);
 assert.deepEqual(result.map(f=>f.evidence.map(row=>row.evidenceId)),[['a','b'],['c'],['d']]);
});

test('search accepts only distinct usable HTTPS leads and rejects malformed provider JSON',async()=>{
 const {session}=fixture();
 let content=JSON.stringify({results:[null,{url:'http://example.test/'},
  {url:'https://publisher.example.test/a#section',title:'A source'},{url:'https://publisher.example.test/a'}]});
 const tools=createSqaResearch({session,checkpoint:async()=>{},env:{QASE_SQA_SEARCH_URL:'https://search.example.test/search'},retrieve:async(url,options)=>{
  assert.equal(new URL(url).searchParams.get('format'),'json');
  assert.equal(options.sameOrigin,true);
  return {url,finalUrl:url,content,retrievedAt:Date.now(),contentHash:createHash('sha256').update(content).digest('hex')};
 }});
 const search=tools.find(t=>t.name==='web_search');
 assert.deepEqual((await search.run({query:'official accessibility standard'})).results,[{url:'https://publisher.example.test/a',title:'A source',excerpt:''}]);
 content='not a JSON document';
 await assert.rejects(search.run({query:'official accessibility standard'}),/invalid JSON/);
});
