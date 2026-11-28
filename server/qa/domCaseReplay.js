import { randomUUID } from 'node:crypto';
import { inspectCaseControls } from './domCaseEvidence.js';
import { formOutcomeObserver } from './formOutcome.js';

const gap = detail => ({ status: 'inconclusive', detail });
const checked = (ok, detail) => ({ status: ok ? 'passed' : 'failed', detail });

async function repeatForm(page, form, element, save) {
	const scope = { path: new URL(page.url()).pathname, form: element.formNumber };
	const controls = await form.evaluate(node => Array.from(node.elements).map(el => ({
		tag: el.localName, type: el.type, required: el.required, disabled: el.disabled, empty: el.value === '',
		inside: node.contains(el)
	})));
	const fields = controls.filter(c => c.required && !c.disabled);
	const submits = form.locator('button[type=submit],button:not([type]),input[type=submit]');
	if (fields.length !== 1 || !fields[0].inside || !fields[0].empty || !['text','email','textarea'].includes(fields[0].type) ||
		controls.some(c => ['password','file'].includes(c.type)) || await submits.count() !== 1 ||
		!await form.evaluate(f => f.method === 'post' && new URL(f.action).origin === location.origin && !f.noValidate) ||
		!await submits.evaluate(b => !b.formNoValidate && !b.hasAttribute('formaction') && !b.hasAttribute('formmethod'))) return gap('This form cannot be replayed with the approved single-field receipt check.');
	const observed = formOutcomeObserver(page, save, scope);
	await observed.observe(submits, () => submits.click({timeout:3000}));
	if (!observed.outcomes[0]?.validation) return gap('The required field did not expose the recorded validation step.');
	const value = 'qa-' + randomUUID().slice(0,8);
	await form.locator(':required:enabled').fill(fields[0].type === 'email' ? value + '@example.test' : value);
	await observed.observe(submits, () => submits.click({timeout:3000}));
	const outcome = observed.outcomes[0];
	return outcome.submitted && outcome.receipt ? {status:'passed', detail:'A corrected submission produced a new matching receipt.', artifactId:outcome.artifactId} :
		gap('The corrected submission and matching receipt could not both be verified.');
}

// Run only reviewed objectives against a freshly inspected control. Never translate
// arbitrary reviewer text into actions or treat a model response as an assertion.
export async function replayDomCase({page, record, allowWrites, writeOrigins = [], allowedPaths = [], save = async () => {}}) {
	const g = record.generation;
	if (!g || g.reviewStatus !== 'Ready for Execution' || g.stale) return gap('This case requires current reviewer approval.');
	if (page.url() !== record.sourceUrl) return gap('The browser did not reach the approved source page.');
	if (g.requiresWrite && !(allowWrites && writeOrigins.includes(new URL(page.url()).origin))) return gap('A test-write grant and a configured staging origin are required.');
	const snapshot = await inspectCaseControls(page, allowedPaths);
	const live = snapshot.elements?.find(e => e.fingerprint === g.element.fingerprint);
	if (!live || live.revision !== g.element.revision) return gap('The source control changed or disappeared. Regenerate and review the case.');
	if (g.specification || g.original.expected !== record.expected || JSON.stringify(g.original.steps) !== JSON.stringify(record.steps) || g.original.testData !== g.testData) return gap('The reviewer changed the procedure or assertion. It requires a matching executable check.');
	const control = page.locator(live.css);
	const objective = g.objective;
	if (objective === 'Repeat verified form submission') return repeatForm(page, control, live, save);
	if (objective === 'Disabled control') return checked(await control.isDisabled(), 'Checked the live disabled state.');
	if (objective === 'Read-only field') return checked(await control.evaluate(el => el.readOnly), 'Checked the live read-only property.');
	if (objective === 'Check link destination') return checked(await control.evaluate(el => el.href) === live.destination, 'Compared the resolved link destination.');
	if (objective === 'Repeat verified navigation') {
		await control.click({timeout:3000});
		const arrived = await page.waitForURL(live.destination, {timeout:4000}).then(() => true, () => false);
		return checked(arrived && await page.locator('body').innerText().then(t => !!t.trim()), 'Compared the destination and checked for rendered content.');
	}
	if (objective === 'Select native control') {
		if (await control.isChecked()) return gap('The control was already selected.');
		await control.check({timeout:3000});
		return checked(await control.isChecked(), 'Read the checked state after selection.');
	}
	if (objective === 'Choose an available option') {
		const index = await control.evaluate(el => Array.from(el.options).findIndex(o => !o.disabled && !o.parentElement.disabled && !o.selected));
		if (index < 0) return gap('No alternative enabled option was available.');
		await control.selectOption({index});
		return checked(await control.evaluate(el => el.selectedIndex) === index, 'Compared the selected option after interaction.');
	}
	if (objective === 'Above maxlength') {
		await control.fill('');
		await control.pressSequentially(g.testData,{timeout:5000});
		return checked((await control.inputValue()).length <= Number(live.attrs.maxlength), 'Compared the typed length with maxlength.');
	}
	const validity = {'Digit pattern mismatch':['patternMismatch',true], 'Below minlength':['tooShort',true], 'Empty required field':['valueMissing',true], 'Malformed email':['typeMismatch',true], 'Well-formed email':['typeMismatch',false],
		'At min':['rangeUnderflow',false], 'Outside min':['rangeUnderflow',true], 'At max':['rangeOverflow',false], 'Outside max':['rangeOverflow',true]};
	if (validity[objective] || ['Unicode text input','At minlength','At maxlength'].includes(objective)) {
		const data = objective === 'Empty required field' ? '' : g.testData;
		await control.fill(data, {timeout:3000});
		if (!validity[objective]) return checked(await control.inputValue() === data, 'Compared the field contents after entry.');
		const [flag, expected] = validity[objective];
		const actual = await control.evaluate((el,key) => el.validity[key], flag);
		return checked(actual === expected, flag + ' was ' + actual + '.');
	}
	return gap('This expected behavior requires an independently verifiable assertion.');
}
