export const SQA_REQUIRED_BROWSER_ATTRIBUTES = Object.freeze([
	'web_application',
	'user_interface'
]);

function uniqueStrings(values = []) {
	return [...new Set(values.filter(value => typeof value === 'string' && value))];
}

function applicableControlIds(catalog, profiles, attributes) {
	const controls = Array.isArray(catalog?.controls) ? catalog.controls : [];
	return controls.filter(control => {
		const applicability = control?.applicability;
		if (!applicability || !Array.isArray(applicability.profiles)) return false;
		if (!applicability.profiles.some(profile => profiles.includes(profile))) return false;
		const required = Array.isArray(applicability.attributes) ? applicability.attributes : [];
		return applicability.mode === 'always'
			|| (applicability.mode === 'any' && required.some(attribute => attributes.includes(attribute)))
			|| (applicability.mode === 'all' && required.every(attribute => attributes.includes(attribute)));
	}).map(control => control.id);
}

/**
 * Preview the deterministic catalog scope in the launcher. The server remains
 * authoritative; this mirrors catalog applicability only so the user can see
 * the exact control count and why controls are included before starting.
 */
export function describeSqaScopeSelection(catalog, { profiles = [], attributes = [] } = {}) {
	const selectedProfiles = uniqueStrings(['core', ...profiles]);
	const selectedAttributes = uniqueStrings([...SQA_REQUIRED_BROWSER_ATTRIBUTES, ...attributes]);
	const applicableIds = applicableControlIds(catalog, selectedProfiles, selectedAttributes);
	const baselineIds = applicableControlIds(catalog, ['core'], [...SQA_REQUIRED_BROWSER_ATTRIBUTES]);
	const baselineSet = new Set(baselineIds);
	const additionalControlIds = applicableIds.filter(controlId => !baselineSet.has(controlId));
	const browserControlIds = applicableIds.filter(controlId => /^SQA-WEB-00[1-6]$/.test(controlId));
	const additionalProfiles = selectedProfiles.filter(profile => profile !== 'core');
	const optionalAttributes = selectedAttributes.filter(attribute => !SQA_REQUIRED_BROWSER_ATTRIBUTES.includes(attribute));
	const expanded = additionalProfiles.length > 0 || optionalAttributes.length > 0;
	const reasons = [
		'Universal core controls are required for every SQA assessment.',
		`${browserControlIds.length} browser checks are included because this assessment tests a web URL and user interface.`
	];
	if (additionalProfiles.length > 0) {
		reasons.push(`${additionalProfiles.length} additional standards profile${additionalProfiles.length === 1 ? '' : 's'} selected.`);
	}
	if (optionalAttributes.length > 0) {
		reasons.push(`${optionalAttributes.length} additional product characteristic${optionalAttributes.length === 1 ? '' : 's'} selected.`);
	}
	const text = expanded
		? `${applicableIds.length} controls selected · ${baselineIds.length} recommended + ${additionalControlIds.length} additional · ${browserControlIds.length} browser checks`
		: `${applicableIds.length} controls selected · Recommended core · ${browserControlIds.length} browser checks`;
	return {
		profiles: selectedProfiles,
		attributes: selectedAttributes,
		applicableControlIds: applicableIds,
		browserControlIds,
		baselineControlIds: baselineIds,
		additionalControlIds,
		additionalProfiles,
		optionalAttributes,
		expanded,
		requiresRationale: expanded,
		requiresConfirmation: expanded,
		text,
		reasons,
		warning: expanded
			? `Expanded scope adds ${additionalControlIds.length} control${additionalControlIds.length === 1 ? '' : 's'}. Explain why the selected profiles or characteristics apply, then confirm the broader review.`
			: ''
	};
}
