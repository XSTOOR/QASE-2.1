import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {publisherBackgroundSection,verifyResearchPublisher} from './sqaSourceAuthority.js';

const shortlink = 'https://www.w3.org/TR/Test-2.0/';
const api = 'https://api.w3.org/specifications/Test-2.0';
const latest = api + '/versions/20240611';
const dated = 'https://www.w3.org/TR/2024/REC-Test-2.0-20240611/';
function retrieve(overrides = {}) {
	return async url => {
		const content = JSON.stringify(url === api ? {shortname:'Test-2.0', shortlink, title:'Test', 'series-version':'2', _links:{'latest-version':{href:latest}}} :
			{title:'Test', shortlink, date:'2024-06-11', uri:dated, status:'Recommendation', _links:{self:{href:latest}}, ...overrides});
		return {finalUrl:url,content,contentHash:createHash('sha256').update(content).digest('hex'),retrievedAt:1};
	};
}
test('official edition requires an independent matching publisher record and retains both receipts', async () => {
	for (const finalUrl of [shortlink,dated]) {
		const publication = await verifyResearchPublisher({finalUrl},retrieve());
		assert.equal(publication.authority,'verified_official');
		assert.equal(publication.version,'2');
		assert.equal(publisherBackgroundSection(publication,'#Abstract'),true);
		assert.equal(publisherBackgroundSection(publication,'sotd'),true);
		assert.equal(publisherBackgroundSection(publication,'criteria'),false);
		assert.equal(publication.effectiveDate,null);
		assert.equal(publication.superseded,false);
		assert.deepEqual(publication.authorityEvidence.map(v=>v.url),[api,latest]);
	}
});
test('lookalike origin, stale edition, draft, mismatched metadata and cancellation cannot verify a current recommendation',async()=>{
	const forged = await verifyResearchPublisher({finalUrl:shortlink.replace('www.w3.org','w3.example.org')},()=>assert.fail('Unexpected request'));
	assert.equal(forged.authority,'unverified');
	for(const patch of [{uri:'https://other.test/'},{status:'Draft'},{title:'Unrelated'},{date:'2019-01-01'}])
		assert.equal((await verifyResearchPublisher({finalUrl:shortlink},retrieve(patch))).authority,'official_incomplete');
	const older=await verifyResearchPublisher({finalUrl:dated.replace('20240611','20240101')},retrieve());
	assert.equal(older.authority,'official_incomplete');
	const controller=new AbortController();
	await assert.rejects(verifyResearchPublisher({finalUrl:shortlink},async()=>{controller.abort(new Error('cancelled'));throw Error();},controller.signal),/cancelled/);
});
