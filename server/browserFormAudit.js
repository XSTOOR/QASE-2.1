/** Read native validity without submitting, firing events, or exposing values. */
export async function inspectFormValidation(page) {
	if (!page || page.isClosed()) return undefined;
	try {
		return await page.evaluate(() => {
			const elements = [...document.querySelectorAll('input,select,textarea')].filter(element=>element.getClientRects().length && element.willValidate);
			return {
				fieldCount: elements.length, truncated: elements.length>100,
				fields: elements.slice(0,100).map(element=>({
					id:element.id.slice(0,128), type:element.type, required:element.required,
					formNoValidate:element.form?.noValidate ?? false,
					valid:element.validity.valid,
					failures:['valueMissing','typeMismatch','patternMismatch','tooLong','tooShort','rangeUnderflow','rangeOverflow','stepMismatch','badInput','customError'].filter(key=>element.validity[key])
				})),
				limitations:'Native validity state only. Browser validation bubbles may be absent from DOM snapshots. Invalid fields can prevent submission without an inline app error; inspect the actual submission and stale UI separately.'
			};
		});
	} catch {return undefined;}
}
