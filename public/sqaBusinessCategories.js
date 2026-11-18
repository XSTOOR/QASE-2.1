/** Discovery hints only. A category never creates features, permissions or evidence. */
const category = (id, title, journeys) => Object.freeze({ id, title, journeys: Object.freeze(journeys) });

export const SQA_BUSINESS_CATEGORIES = Object.freeze({
	general: category('general', 'General website or application', ['primary navigation', 'key user journeys', 'forms and feedback']),
	ai_technology: category('ai_technology', 'AI and technology', ['workspace navigation', 'input and result presentation', 'settings and error feedback']),
	digital_education: category('digital_education', 'Digital education / Academy', ['course discovery', 'lesson navigation', 'learner forms and progress presentation']),
	creator_affiliate: category('creator_affiliate', 'Content creator / Influencer / Affiliate', ['content discovery', 'media and outbound links', 'subscription forms and disclosures']),
	hr_hiring: category('hr_hiring', 'HR / Hiring businesses', ['job discovery', 'application forms', 'candidate and employer navigation']),
	digital_products: category('digital_products', 'Sales for digital products', ['product discovery', 'pricing presentation', 'cart and checkout entry without purchase'])
});

export function normalizeSqaBusinessCategory(value = 'general') {
	if (typeof value !== 'string' || !Object.hasOwn(SQA_BUSINESS_CATEGORIES, value)) {
		throw new TypeError('Choose an available SQA business category.');
	}
	return value;
}
