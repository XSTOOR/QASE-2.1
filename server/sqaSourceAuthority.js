// Source metadata is obtained from the publisher independently of the model.
const publisherOrigin = 'https://www.w3.org';
const metadataOrigin = 'https://api.w3.org/specifications/';
const unknown = {
	authority: 'unverified', publisher: null, frameworkOwner: null, title: null,
	version: null, publicationDate: null, effectiveDate: null, superseded: null
};

export async function verifyResearchPublisher(source, retrieve, signal) {
	const url = new URL(source.finalUrl);
	const result = { ...unknown, authorityEvidence: [] };
	if (url.origin !== publisherOrigin || url.search || url.hash) return result;
	result.authority = 'official_incomplete';
	result.publisher = 'W3C';
	const published = /^\/TR\/(\d{4})\/(REC|NOTE|WD|CR|CRD|PR)-([\w.-]+)-(\d{8})\/$/.exec(url.pathname);
	const shortname = published?.[3] ?? /^\/TR\/([\w.-]+)\/$/.exec(url.pathname)?.[1];
	if (!shortname) return result;

	async function metadata(endpoint) {
		const receipt = await retrieve(endpoint, signal);
		if (receipt.finalUrl !== endpoint) throw new Error('Publisher metadata redirected.');
		result.authorityEvidence.push({
			url: endpoint, contentHash: receipt.contentHash, retrievedAt: receipt.retrievedAt
		});
		return JSON.parse(receipt.content);
	}

	try {
		const api = metadataOrigin + shortname;
		const spec = await metadata(api);
		const prefix = api + '/versions/';
		const latest = spec._links?.['latest-version']?.href;
		if (spec.shortname !== shortname || spec.shortlink !== publisherOrigin + '/TR/' + shortname + '/' ||
			typeof latest !== 'string' || !latest.startsWith(prefix) || !/^\d{8}$/.test(latest.slice(prefix.length))) return result;
		const edition = published ? prefix + published[4] : latest;
		const record = await metadata(edition);
		if (!spec.title || spec.title !== record.title || record.shortlink !== spec.shortlink ||
			record._links?.self?.href !== edition || !/^\d{4}-\d{2}-\d{2}$/.test(record.date) ||
			record.date.replaceAll('-', '') !== edition.slice(-8)) return result;
		const datedUri = publisherOrigin + '/TR/' + record.date.slice(0,4) + '/REC-' + shortname + '-' + edition.slice(-8) + '/';
		if (record.status !== 'Recommendation' || record.uri !== datedUri ||
			![record.uri, record.shortlink].includes(url.href) || !spec['series-version']) return result;
		return {
			...result, authority: 'verified_official', frameworkOwner: 'W3C', title: record.title,
			version: spec['series-version'], publicationDate: record.date, superseded: edition !== latest,
			editionUrl: record.uri, publicationStatus: record.status, supersessionScope: spec.shortlink
		};
	} catch (error) {
		signal?.throwIfAborted();
		return { ...result, verificationLimitation: String(error.message).slice(0, 200) };
	}
}

// These W3C sections explicitly describe the document or its publication
// status. Their text can motivate exploration but cannot establish an obligation.
export function publisherBackgroundSection(source, controlId) {
 return source?.publisher === 'W3C' && source.authority === 'verified_official' &&
  ['abstract','sotd'].includes(String(controlId).trim().replace(/^#/, '').toLowerCase());
}
