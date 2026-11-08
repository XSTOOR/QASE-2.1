export function createFounderReportFixture(){
 const session={id:'draft-fixture',mode:'founder',status:'running',founder:{observations:[{id:'observed',category:'product_clarity'}]}};
 const proof={evidence_observation_ids:['observed'],assumptions:[]};
 const payload={executive_summary:'The observed local product offers task practice. Business outcomes remain unmeasured.',
  icp:{primary:'Small teams, as a hypothesis',users:['Team members'],buyers:['Team leads'],jobs:['Practice tasks'],pains:['Unclear task requirements'],...proof},
  positioning:{category:'Task practice',one_liner:'Practice a task locally.',value_proposition:'Clarify the next action.',differentiators:['Local task practice'],alternatives:['Manual notes'],...proof},
  monetization:{model:'Subscription hypothesis',value_metric:'Active practicing teams',packages:['Team pilot'],pricing_presentation:'Describe the pilot scope.',next_tests:['Interview a team lead.'],...proof},
  recommendations:['product_clarity','onboarding','activation'].map((category,i)=>({id:`rec-${i}`,category,title:`Improve ${category}`,opportunity:'The observed task entry needs clearer guidance.',proposed_feature:'Add a sample task.',why_it_matters:'Teams need a starting point.',intended_outcome:'Clearer first task entry.',priority_reason:'Addresses an observed first-use step.',actions:['Test a sample task.'],implementation_scope:'Update the task hint.',acceptance_criteria:['The hint is visible.','The hint describes the task constraints.'],dependencies:[],impact:'medium',effort:'small',confidence:'medium',...proof})),
  marketing:{channels:[{channel:'Team task demo',rationale:'Demonstrate the observed practice flow.',first_test:'Show the demo to a team.',confidence:'medium',...proof}],content_angles:['Task practice'],launch_motions:['Pilot invitation'],growth_loops:['Share a practice template'],assumptions:['Acquisition is unmeasured.']},
  sales:{motion:'Scoped pilot hypothesis',qualification_questions:['Which tasks are hard to repeat?'],objection_responses:[{objection:'We use notes.',response:'Compare a practice example with notes.'}],sales_assets:['Annotated task example'],...proof},
  risks:[{title:'Unknown demand',likelihood:'medium',impact:'high',mitigation:'Interview target teams.',evidence_observation_ids:[],assumptions:['No demand data was supplied.']}],
  quick_wins:['rec-0'],plan:{days_30:['Interview users.'],days_60:['Test task guidance.'],days_90:['Review pilot evidence.']},
  metrics:{north_star:{name:'Useful practice completions',definition:'Completed local practice with a useful next step.',why:'Connects the task to its intended use.',...proof},candidates:[{name:'Task abandonment',definition:'Started practice without completion.',...proof}],experiments:[{hypothesis:'A sample task may clarify entry.',change:'Add a sample task.',success_metric:'Practice completion',timebox:'Two weeks',guardrail:'No loss of editable input',...proof}]}};
 return {session,payload};
}
