export const SQA_REQUIRED_BROWSER_ATTRIBUTES = Object.freeze([
	'web_application',
	'user_interface'
]);

function uniqueStrings(values = []) {
	return [...new Set(values.filter(value => typeof value === 'string' && value))];
}

/**
 * Preview the deterministic catalog scope in the launcher. The server remains
 * authoritative; this mirrors catalog applicability only so the user can see
 * the exact control count and why controls are included before starting.
 */
export function describeSqaScopeSelection(catalog, { profiles = [], attributes = [] } = {}) {
	const selectedProfiles = uniqueStrings(['core', ...profiles]);
	const selectedAttributes = uniqueStrings([...SQA_REQUIRED_BROWSER_ATTRIBUTES, ...attributes]);
	const controls = Array.isArray(catalog?.controls) ? catalog.controls : [];
	const applicableControls = controls.filter(control => {
		const applicability = control?.applicability;
		if (!applicability || !Array.isArray(applicability.profiles)) return false;
		if (!applicability.profiles.some(profile => selectedProfiles.includes(profile))) return false;
		const required = Array.isArray(applicability.attributes) ? applicability.attributes : [];
		return applicability.mode === 'always'
			|| (applicability.mode === 'any' && required.some(attribute => selectedAttributes.includes(attribute)))
			|| (applicability.mode === 'all' && required.every(attribute => selectedAttributes.includes(attribute)));
	});
	const browserControls = applicableControls.filter(control => /^SQA-WEB-00[1-6]$/.test(control.id));
	const additionalProfiles = selectedProfiles.filter(profile => profile !== 'core');
	const optionalAttributes = selectedAttributes.filter(attribute => !SQA_REQUIRED_BROWSER_ATTRIBUTES.includes(attribute));
	const reasons = [
		'Universal core controls are required for every SQA assessment.',
		`${browserControls.length} browser checks are included because this assessment tests a web URL and user interface.`
	];
	if (additionalProfiles.length > 0) {
		reasons.push(`${additionalProfiles.length} additional standards profile${additionalProfiles.length === 1 ? '' : 's'} selected.`);
	}
	if (optionalAttributes.length > 0) {
		reasons.push(`${optionalAttributes.length} additional product characteristic${optionalAttributes.length === 1 ? '' : 's'} selected.`);
	}
	return {
		profiles: selectedProfiles,
		attributes: selectedAttributes,
		applicableControlIds: applicableControls.map(control => control.id),
		browserControlIds: browserControls.map(control => control.id),
		text: `${applicableControls.length} controls selected · Universal core · ${browserControls.length} browser checks`,
		reasons
	};
}
