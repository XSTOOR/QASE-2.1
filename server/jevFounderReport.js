/** Host-authored report templates. JEV supplies classifications, never prose. */
export function buildJevFounderReport(session, classifications, pages) {
  const scope = session.founder.scope;
  const context = scope.productContext ?? {};
  const assumptions = ['Hypothesis for operator validation; browser evidence does not establish customer demand, commercial outcomes, private analytics, or market differentiation.'];
  const reference = category => ({
    evidence_observation_ids: (session.founder.observations ?? []).filter(item => item.category === category).map(item => item.id).slice(0, 3), assumptions
  });
  const selected = [...classifications].sort((a, b) => ({ concern: 0, unknown: 1, supported: 2 }[a.decision] - { concern: 0, unknown: 1, supported: 2 }[b.decision])).slice(0, 3);
  const recommendations = selected.map((category, i) => ({
    id: `jev-review-${i + 1}`, category: category.id,
    title: `Validate ${category.label.toLowerCase()} for ${scope.target.name}`,
    opportunity: `JEV classified ${category.label.toLowerCase()} as ${category.decision} from ${pages.length} bounded page observations. Further evidence is needed to decide a product change.`,
    proposed_feature: `A reviewed evidence checklist for ${category.label.toLowerCase()}, linked to the sampled product routes.`,
    why_it_matters: `The current review of ${scope.target.name} cannot substantiate this area beyond its browser sample.`,
    intended_outcome: 'Make the next product decision using verified evidence.',
    priority_reason: `JEV classification is ${category.decision}; resolve evidence gaps before committing implementation resources.`,
    actions: [`Review ${pages[0]?.url ?? scope.target.url} with the product owner.`, `Collect specific evidence for ${category.description.toLowerCase()}`],
    implementation_scope: `Record the intended behavior, evidence source, observed result, and operator decision for ${category.label.toLowerCase()}. Implement a product change only after this hypothesis is validated.`,
    acceptance_criteria: ['Every conclusion cites a reproducible observation or is explicitly marked unverified.', 'The product owner records whether the proposed change is supported by the collected evidence.'],
    dependencies: ['Product-owner review and the missing customer or operational evidence.'],
    impact: 'low', effort: 'small', confidence: 'low', ...reference(category.id)
  }));
  return {
    executive_summary: `JEV Decisions reviewed a bounded sample of ${pages.length} page observations from ${scope.target.name}. Classifications and the following host-authored suggestions are limited to captured DOM and diagnostics. Unobserved areas are explicitly marked unknown. No generated market claims, visual-design assessment, or complete workflow validation is implied.`,
    icp: { primary: context.targetCustomer || 'Target customer not established by this browser sample.', users: [context.targetCustomer || 'To be supplied by the product owner.'], buyers: ['Buyer identity requires customer evidence.'], jobs: [context.primaryGoal || 'Core user job requires operator validation.'], pains: ['Validate the observed workflow friction with intended customers.'], ...reference('customer_discovery') },
    positioning: { category: 'Operator validation required.', one_liner: `Browser sample of ${scope.target.name}; positioning has not been independently verified.`, value_proposition: 'Use the observed product copy as a hypothesis and validate comprehension with intended users.', differentiators: ['No competitive differentiation independently verified.'], alternatives: ['Existing user workarounds require discovery; no competitor comparison was performed.'], ...reference('positioning') },
    monetization: { model: context.businessModel || 'Business model not established.', value_metric: 'Value metric requires customer and usage evidence.', packages: ['No new pricing package is supported by this review alone.'], pricing_presentation: 'Only sampled public page text was available for review.', next_tests: ['Validate the proposed value metric with the product owner and customers before changing pricing.'], ...reference('monetization_pricing') },
    recommendations,
    marketing: { channels: [{ channel: 'Customer discovery interviews', rationale: 'Validate the target customer and observed product message before choosing an acquisition channel.', first_test: 'Show the sampled entry page to an intended customer and record their interpretation.', confidence: 'low', ...reference('marketing_growth') }], content_angles: ['Hypothesis: explain the core task shown by the sampled product page.'], launch_motions: ['Validate comprehension before choosing a launch motion.'], growth_loops: ['Not established; needs retention and referral evidence.'], assumptions },
    sales: { motion: 'Sales motion requires operator and buyer validation.', qualification_questions: ['Which concrete task brought you to this product?', 'What evidence would you need before purchasing?'], objection_responses: [{ objection: 'The review does not demonstrate the complete intended workflow.', response: 'Provide a reproducible demonstration with the required test inputs and authorization.' }], sales_assets: ['A verified workflow demonstration with explicit scope and limitations.'], ...reference('go_to_market_sales') },
    risks: [{ title: 'Decisions based on an incomplete browser sample', likelihood: 'high', impact: 'medium', mitigation: 'Validate missing workflows and commercial assumptions with independent evidence.', ...reference('technical_product_quality') }],
    quick_wins: recommendations.map(item => item.id),
    plan: { days_30: ['Validate the recorded observations and missing prerequisites with the operator.'], days_60: ['Run controlled workflow and customer tests for validated priorities.'], days_90: ['Review actual outcomes before extending the roadmap.'] },
    metrics: {
      north_star: { name: 'Verified core-task completion', definition: 'Measure the intended task after its outcome and event instrumentation are validated.', why: 'The browser sample alone cannot establish activation or retention.', ...reference('metrics_experiments') },
      candidates: [{ name: 'Observed task failures', definition: 'Count reproducible failures within a declared tested workflow.', ...reference('metrics_experiments') }],
      experiments: [{ hypothesis: 'Clarifying the sampled core workflow may improve user comprehension.', change: 'Test an operator-approved explanation with intended users.', success_metric: 'Observed comprehension and task-completion evidence.', timebox: 'One reviewed research iteration.', guardrail: 'Do not claim commercial improvement without measured results.', ...reference('metrics_experiments') }]
    }
  };
}
