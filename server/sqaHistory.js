import { PublicInputError } from './publicErrors.js';

export const MAX_SQA_VERSIONS = 10;

export function preserveSqaPublication(sqa, publishedBy, forceNewVersion = false) {
	const versions = [...(sqa.publishedVersions ?? [])];
	if (!sqa.finalizedAt || !sqa.assessment) return versions;
	if (!forceNewVersion && versions.at(-1)?.assessment.assessmentSha256 === sqa.assessment.assessmentSha256) return versions;
	if (versions.length >= MAX_SQA_VERSIONS) throw new PublicInputError('This assessment has reached its 10-version limit. Create a new assessment for further review.', 409);
	versions.push(structuredClone({
		version: versions.length + 1,
		publishedAt: sqa.finalizedAt,
		...(publishedBy ? { publishedBy } : {}),
		assessment: sqa.assessment,
		observations: sqa.observations,
		scope: sqa.scope
	}));
	return versions;
}

export function assertSqaSize(sqa) {
	if (Buffer.byteLength(JSON.stringify(sqa), 'utf8') > 950_000) {
		throw new PublicInputError('The assessment history is too large. Create a new assessment to retain further evidence.', 409);
	}
}

export function sqaPublishedVersions(sqa) {
	return preserveSqaPublication(sqa);
}

export function sqaVersion(sqa, number) {
	if (!/^\d+$/.test(String(number))) throw new PublicInputError('Invalid assessment version.');
	const version = sqaPublishedVersions(sqa).find(item => item.version === Number(number));
	if (!version) throw new PublicInputError('No such published assessment version.', 404);
	return structuredClone(version);
}
