/**
 * Qase Software Quality Assurance (SQA) control catalog.
 *
 * This is an independently authored, outcome-oriented crosswalk. It does not
 * reproduce, replace, or grant access to the normative text of any referenced
 * standard. The public source links describe the frameworks; licensed standards
 * and qualified assessors remain authoritative for a conformity determination.
 */

export const SQA_CATALOG_VERSION = '2026.08.2';

/**
 * Bounded browser-smoke controls used for the independent technical verdict.
 * These IDs do not replace or satisfy broader assurance/documentary controls.
 */
export const SQA_TECHNICAL_CONTROL_IDS = Object.freeze([
	'SQA-WEB-001',
	'SQA-WEB-002',
	'SQA-WEB-003',
	'SQA-WEB-004',
	'SQA-WEB-005',
	'SQA-WEB-006'
]);

export const SQA_NO_CERTIFICATION_DISCLAIMER = [
	'A Qase SQA result is an engineering-assurance assessment against the Qase SQA catalog.',
	'It is not legal advice, regulatory approval, accreditation, an audit opinion, or certification.',
	'Sector applicability and final conformity decisions require competent human, legal, regulatory,',
	'or accredited assessors using the applicable authoritative requirements and licensed standards.'
].join(' ');

export const SQA_AUTOMATION_LEVELS = Object.freeze([
	'manual', 'agent_assisted', 'automated', 'hybrid'
]);
export const SQA_CONTROL_SEVERITIES = Object.freeze([
	'critical', 'high', 'medium', 'low'
]);
export const SQA_EVIDENCE_TYPES = Object.freeze([
	'anomaly_record',
	'approval_record',
	'artifact',
	'assessment_record',
	'audit_record',
	'code_quality_report',
	'configuration_record',
	'coverage_report',
	'operational_record',
	'penetration_test',
	'privacy_record',
	'regulatory_record',
	'requirements_baseline',
	'risk_register',
	'safety_case',
	'sbom',
	'security_report',
	'test_plan',
	'test_result',
	'traceability_matrix',
	'validation_record',
	'verification_record',
	'wcag_report'
]);
export const SQA_PRODUCT_ATTRIBUTES = Object.freeze([
	'ai_enabled',
	'handles_payment_data',
	'handles_personal_data',
	'localized',
	'multi_region',
	'public_api',
	'safety_critical',
	'source_available',
	'user_interface',
	'web_application'
]);

export const SQA_SOURCES = Object.freeze({
	ISO_29119: Object.freeze({
		id: 'ISO_29119',
		title: 'ISO/IEC/IEEE 29119 series — Software testing',
		publisher: 'ISO/IEC/IEEE',
		version: 'series',
		url: 'https://committee.iso.org/sites/jtc1sc7/home/projects/flagship-standards/isoiecieee-29119-series.html',
		scope: 'Testing concepts, processes, documentation, design techniques, and keyword-driven testing.'
	}),
	ISO_25010: Object.freeze({
		id: 'ISO_25010',
		title: 'ISO/IEC 25010:2023 — Product quality model',
		publisher: 'ISO/IEC',
		version: '2023',
		url: 'https://www.iso.org/standard/78176.html',
		scope: 'Quality characteristics used to specify, measure, and evaluate ICT and software products.'
	}),
	ISO_12207: Object.freeze({
		id: 'ISO_12207',
		title: 'ISO/IEC/IEEE 12207:2026 — Software life cycle processes',
		publisher: 'ISO/IEC/IEEE',
		version: '2026',
		url: 'https://www.iso.org/standard/90219.html',
		scope: 'Processes and outcomes across acquisition, development, operation, maintenance, and disposal.'
	}),
	ISO_90003: Object.freeze({
		id: 'ISO_90003',
		title: 'ISO/IEC/IEEE 90003:2018 — Applying ISO 9001 to software',
		publisher: 'ISO/IEC/IEEE',
		version: '2018',
		url: 'https://www.iso.org/standard/74348.html',
		scope: 'Software-specific quality management guidance across acquisition, supply, development, operation, and maintenance.'
	}),
	ISO_5055: Object.freeze({
		id: 'ISO_5055',
		title: 'ISO/IEC 5055:2021 — Automated source code quality measures',
		publisher: 'ISO/IEC',
		version: '2021',
		url: 'https://www.iso.org/standard/80623.html',
		scope: 'Automated source-code measures related to reliability, security, performance efficiency, and maintainability.'
	}),
	IEEE_1012: Object.freeze({
		id: 'IEEE_1012',
		title: 'IEEE 1012-2024 — System, software, and hardware verification and validation',
		publisher: 'IEEE',
		version: '2024',
		url: 'https://standards.ieee.org/ieee/1012/7324/',
		scope: 'Risk- and integrity-informed verification and validation throughout the life cycle.'
	}),
	CMMI_DEV: Object.freeze({
		id: 'CMMI_DEV',
		title: 'Capability Maturity Model Integration — Development view',
		publisher: 'CMMI Institute / ISACA',
		version: 'current',
		url: 'https://dev.cmmiinstitute.com/cmmi/dev',
		scope: 'Organizational capability and process-improvement practices for developing quality products and services.'
	}),
	TMMI: Object.freeze({
		id: 'TMMI',
		title: 'Test Maturity Model integration',
		publisher: 'TMMi Foundation',
		version: 'reference model R1.3',
		url: 'https://www.tmmi.org/tmmi-model/',
		scope: 'Staged test-process improvement from managed through defined, measured, and optimizing practices.'
	}),
	ISTQB: Object.freeze({
		id: 'ISTQB',
		title: 'ISTQB Certified Tester scheme and testing body of knowledge',
		publisher: 'International Software Testing Qualifications Board',
		version: 'current',
		url: 'https://www.istqb.org/what-we-do/',
		scope: 'Role-oriented testing terminology, foundational knowledge, and specialist competence frameworks.'
	}),
	ISO_27001: Object.freeze({
		id: 'ISO_27001',
		title: 'ISO/IEC 27001:2022 — Information security management systems',
		publisher: 'ISO/IEC',
		version: '2022',
		url: 'https://www.iso.org/standard/27001',
		scope: 'Risk-based management of information confidentiality, integrity, and availability.'
	}),
	NIST_SSDF: Object.freeze({
		id: 'NIST_SSDF',
		title: 'NIST SP 800-218 v1.1 — Secure Software Development Framework',
		publisher: 'NIST',
		version: '1.1',
		url: 'https://csrc.nist.gov/pubs/sp/800/218/final',
		scope: 'Outcome-oriented secure development practices integrated into an SDLC.'
	}),
	NIST_SSDF_AI: Object.freeze({
		id: 'NIST_SSDF_AI',
		title: 'NIST SP 800-218A — SSDF community profile for generative AI',
		publisher: 'NIST',
		version: '2024',
		url: 'https://csrc.nist.gov/pubs/sp/800/218/a/final',
		scope: 'Secure development practices for AI models and systems that use them.'
	}),
	OWASP_ASVS: Object.freeze({
		id: 'OWASP_ASVS',
		title: 'OWASP Application Security Verification Standard',
		publisher: 'OWASP Foundation',
		version: '5.0.0',
		url: 'https://owasp.org/www-project-application-security-verification-standard/',
		scope: 'Open technical security verification requirements for web applications and services.'
	}),
	WCAG_22: Object.freeze({
		id: 'WCAG_22',
		title: 'Web Content Accessibility Guidelines (WCAG) 2.2',
		publisher: 'W3C',
		version: '2.2',
		url: 'https://www.w3.org/TR/WCAG22/',
		scope: 'Testable accessibility success criteria organized under perceivable, operable, understandable, and robust principles.'
	}),
	GDPR: Object.freeze({
		id: 'GDPR',
		title: 'Regulation (EU) 2016/679 — General Data Protection Regulation',
		publisher: 'European Union',
		version: 'consolidated',
		url: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=en',
		scope: 'Requirements governing processing of personal data and rights of data subjects.'
	}),
	CCPA: Object.freeze({
		id: 'CCPA',
		title: 'California Consumer Privacy Act and implementing regulations',
		publisher: 'California Privacy Protection Agency',
		version: 'current',
		url: 'https://cppa.ca.gov/regulations/',
		scope: 'California consumer notice, choice, access, correction, deletion, and sensitive-data obligations.'
	}),
	CISA_SBOM: Object.freeze({
		id: 'CISA_SBOM',
		title: 'CISA 2025 Minimum Elements for a Software Bill of Materials',
		publisher: 'CISA',
		version: '2025',
		url: 'https://www.cisa.gov/sites/default/files/2025-08/2025_CISA_SBOM_Minimum_Elements.pdf',
		scope: 'Minimum data and process expectations for useful software component transparency.'
	}),
	FDA_DEVICE_SOFTWARE: Object.freeze({
		id: 'FDA_DEVICE_SOFTWARE',
		title: 'Content of Premarket Submissions for Device Software Functions',
		publisher: 'U.S. Food and Drug Administration',
		version: 'current guidance',
		url: 'https://www.fda.gov/media/153781/download',
		scope: 'Risk-based software documentation expected for covered medical-device premarket submissions.'
	}),
	FDA_CSA: Object.freeze({
		id: 'FDA_CSA',
		title: 'Computer Software Assurance for Production and Quality Management System Software',
		publisher: 'U.S. Food and Drug Administration',
		version: '2026',
		url: 'https://www.fda.gov/regulatory-information/search-fda-guidance-documents/computer-software-assurance-production-and-quality-management-system-software',
		scope: 'Risk-based assurance for software used in medical-device production and quality management systems.'
	}),
	IEC_62304: Object.freeze({
		id: 'IEC_62304',
		title: 'IEC 62304:2006+A1:2015 — Medical device software life cycle processes',
		publisher: 'IEC',
		version: '2006+A1:2015',
		url: 'https://webstore.iec.ch/en/publication/6792',
		scope: 'Life-cycle processes, activities, and tasks for development and maintenance of medical-device software.'
	}),
	ISO_14971: Object.freeze({
		id: 'ISO_14971',
		title: 'ISO 14971:2019 — Risk management for medical devices',
		publisher: 'ISO',
		version: '2019',
		url: 'https://www.iso.org/standard/72704.html',
		scope: 'Medical-device hazard identification, risk evaluation, control, and life-cycle monitoring.'
	}),
	FAA_DO178C: Object.freeze({
		id: 'FAA_DO178C',
		title: 'FAA AC 20-115D — Airborne software development assurance',
		publisher: 'U.S. Federal Aviation Administration',
		version: '20-115D',
		url: 'https://www.faa.gov/airports/resources/advisory_circulars/index.cfm/go/document.information/documentNumber/20-115D',
		scope: 'FAA-recognized means for airborne software assurance using DO-178C/ED-12C.'
	}),
	IEC_61508: Object.freeze({
		id: 'IEC_61508',
		title: 'IEC 61508-1:2010 — Functional safety general requirements',
		publisher: 'IEC',
		version: '2010',
		url: 'https://webstore.iec.ch/en/publication/5515',
		scope: 'Generic safety life-cycle approach for electrical, electronic, and programmable electronic safety-related systems.'
	}),
	ISO_26262: Object.freeze({
		id: 'ISO_26262',
		title: 'ISO 26262:2018 series — Road vehicles functional safety',
		publisher: 'ISO',
		version: '2018',
		url: 'https://www.iso.org/publication/PUB200262.html',
		scope: 'Automotive safety management, hazard analysis, integrity levels, development, supporting processes, and operations.'
	}),
	PCI_DSS: Object.freeze({
		id: 'PCI_DSS',
		title: 'Payment Card Industry Data Security Standard',
		publisher: 'PCI Security Standards Council',
		version: '4.0.1',
		url: 'https://www.pcisecuritystandards.org/standards/pci-dss/',
		scope: 'Technical and operational requirements for protecting payment account data.'
	})
});

export const SQA_PROFILES = Object.freeze({
	core: Object.freeze({
		id: 'core',
		title: 'Universal software quality core',
		description: 'Risk-based product, process, security, evidence, and life-cycle assurance applicable to general software.'
	}),
	medical: Object.freeze({
		id: 'medical',
		title: 'Medical-device software readiness',
		description: 'Additional evidence-readiness checks for medical-device and SaMD contexts. Regulatory classification must be confirmed by qualified specialists.'
	}),
	aviation: Object.freeze({
		id: 'aviation',
		title: 'Airborne software assurance readiness',
		description: 'Additional planning, integrity, independence, traceability, and life-cycle evidence checks for airborne software contexts.'
	}),
	functional_safety: Object.freeze({
		id: 'functional_safety',
		title: 'Functional-safety and automotive readiness',
		description: 'Additional hazard, integrity-level, safety-life-cycle, and verification checks aligned conceptually with IEC 61508 and ISO 26262.'
	}),
	payment: Object.freeze({
		id: 'payment',
		title: 'Payment-data security readiness',
		description: 'Additional scoping and security-verification checks for systems that store, process, transmit, or can affect payment account data.'
	})
});

function evidence(id, type, description, minimum = 1) {
	return { id, type, description, minimum };
}

function applicability(profiles, mode = 'always', attributes = []) {
	return { profiles, mode, attributes };
}

const CONTROLS = [
	{
		id: 'SQA-GOV-001', title: 'Define product context, intended use, and quality risk',
		objective: 'Establish the assessed product boundary, users, environments, intended use, foreseeable misuse, quality risks, and selected assurance profiles before testing.',
		domain: 'governance', severity: 'critical', mandatory: true, automationLevel: 'manual',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('product-risk-baseline', 'risk_register', 'Approved product scope and quality-risk baseline tied to the assessed release.')],
		sources: ['ISO_29119', 'ISO_25010', 'ISO_12207', 'IEEE_1012']
	},
	{
		id: 'SQA-GOV-002', title: 'Baseline verifiable requirements and acceptance criteria',
		objective: 'Make functional, quality, security, regulatory, and intended-use requirements uniquely identifiable, testable, versioned, and approved.',
		domain: 'governance', severity: 'critical', mandatory: true, automationLevel: 'agent_assisted',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('requirements-baseline', 'requirements_baseline', 'Versioned requirements and measurable acceptance criteria for this release.')],
		sources: ['ISO_29119', 'ISO_25010', 'ISO_12207', 'IEEE_1012']
	},
	{
		id: 'SQA-GOV-003', title: 'Approve a risk-based test strategy',
		objective: 'Define test levels, types, techniques, priorities, environments, data, entry and exit criteria, responsibilities, schedule, and residual-risk handling proportionate to product risk.',
		domain: 'test_management', severity: 'high', mandatory: true, automationLevel: 'agent_assisted',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('test-strategy', 'test_plan', 'Approved release-specific test strategy with risk prioritization and exit criteria.')],
		sources: ['ISO_29119', 'ISO_90003', 'IEEE_1012', 'TMMI']
	},
	{
		id: 'SQA-GOV-004', title: 'Assign assurance responsibilities and independence',
		objective: 'Document accountable owners, reviewer competence, segregation of incompatible duties, and verification independence appropriate to integrity and risk.',
		domain: 'governance', severity: 'high', mandatory: true, automationLevel: 'manual',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('assurance-roles', 'approval_record', 'Approved roles, competence, review authority, and independence rationale.')],
		sources: ['ISO_90003', 'IEEE_1012', 'ISO_29119', 'ISTQB']
	},
	{
		id: 'SQA-GOV-005', title: 'Operate measurable quality improvement',
		objective: 'Track quality objectives, audit results, escaped defects, nonconformities, corrective actions, and effectiveness to drive repeatable improvement.',
		domain: 'quality_management', severity: 'medium', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('quality-review', 'audit_record', 'Recent management or quality review with metrics, actions, owners, and effectiveness follow-up.')],
		sources: ['ISO_90003', 'ISO_12207', 'CMMI_DEV', 'TMMI']
	},
	{
		id: 'SQA-TRC-001', title: 'Maintain bidirectional requirements traceability',
		objective: 'Trace each applicable requirement and risk control to design or implementation evidence, tests, results, defects, and release disposition in both directions.',
		domain: 'traceability', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('trace-matrix', 'traceability_matrix', 'Release-specific bidirectional traceability with no unexplained gaps.')],
		sources: ['ISO_29119', 'IEEE_1012', 'ISO_12207']
	},
	{
		id: 'SQA-TRC-002', title: 'Preserve reproducible, attributable test evidence',
		objective: 'Record immutable test inputs, configuration, steps, expected and actual results, timestamps, actor or tool identity, evidence integrity, and disposition.',
		domain: 'evidence', severity: 'high', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		// A Qase browser observation is one integrity-protected evidence bundle. Requiring
		// a second item with a different type made this otherwise browser-verifiable
		// control impossible for the agent to satisfy even though the same bundle binds
		// the activity, environment/configuration summary, timestamp, and digest.
		evidenceRequirements: [evidence('reproducible-evidence-bundle', 'test_result', 'Representative integrity-protected test results bind inputs, steps, expected and actual outcomes, exact relevant configuration, timestamps, tool identity, and disposition so the check can be reproduced.')],
		sources: ['ISO_29119', 'ISO_90003', 'IEEE_1012']
	},
	{
		id: 'SQA-TST-001', title: 'Apply risk-appropriate test design techniques',
		objective: 'Use documented techniques such as equivalence classes, boundaries, decision rules, state transitions, scenarios, exploratory charters, and negative testing where they fit the risk.',
		domain: 'test_design', severity: 'high', mandatory: true, automationLevel: 'agent_assisted',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('designed-tests', 'test_plan', 'Test design identifies techniques, coverage intent, test data, and risk links.')],
		sources: ['ISO_29119']
	},
	{
		id: 'SQA-TST-002', title: 'Execute layered static and dynamic verification',
		objective: 'Combine appropriately scoped reviews, static analysis, unit, integration, system, acceptance, regression, and specialized testing rather than relying on one test level.',
		domain: 'verification', severity: 'high', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('layered-results', 'verification_record', 'Results from each applicable verification level with exclusions justified.')],
		sources: ['ISO_29119', 'ISO_12207', 'IEEE_1012', 'TMMI']
	},
	{
		id: 'SQA-TST-003', title: 'Control regressions, anomalies, and retesting',
		objective: 'Record anomalies consistently, assess impact and root cause, link fixes to changes, retest corrections, and select regression scope using impact and risk.',
		domain: 'anomaly_management', severity: 'high', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('anomaly-workflow', 'anomaly_record', 'Sample anomalies show triage, impact, ownership, correction, retest, and closure evidence.')],
		sources: ['ISO_29119', 'ISO_12207', 'ISO_90003']
	},
	{
		id: 'SQA-VAL-001', title: 'Verify correctness and validate intended use',
		objective: 'Demonstrate both that implementation conforms to its specified requirements and that representative users can achieve the intended outcomes in realistic contexts.',
		domain: 'validation', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('verification-summary', 'verification_record', 'Independent or reviewed verification conclusion against requirements.'), evidence('intended-use-validation', 'validation_record', 'Validation evidence from representative users, workflows, data, and environment.')],
		sources: ['IEEE_1012', 'ISO_25010', 'ISO_12207']
	},
	{
		id: 'SQA-QUA-001', title: 'Demonstrate functional suitability',
		objective: 'Verify required functions are complete, correct, and appropriate for user tasks, including negative paths, authorization boundaries, data integrity, and error behavior.',
		domain: 'functional_suitability', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('functional-results', 'test_result', 'Requirement-linked functional results covering critical positive and negative workflows.')],
		sources: ['ISO_25010', 'ISO_29119']
	},
	{
		id: 'SQA-QUA-002', title: 'Demonstrate performance efficiency and capacity',
		objective: 'Measure response time, throughput, resource use, capacity limits, degradation, and recovery against realistic workloads and explicit service objectives.',
		// Load, stress, endurance, resource, and recovery evidence needs controlled
		// infrastructure and approved workload limits. The non-destructive browser agent
		// can sample latency, but cannot safely complete this control by itself.
		domain: 'performance_efficiency', severity: 'high', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('performance-results', 'test_result', 'Repeatable load, stress, endurance, or resource results compared with approved thresholds.')],
		sources: ['ISO_25010', 'ISO_29119']
	},
	{
		id: 'SQA-QUA-003', title: 'Verify compatibility and interoperability',
		objective: 'Test supported integrations, protocols, data exchanges, concurrent-resource use, version tolerance, and failure isolation across declared environments.',
		domain: 'compatibility', severity: 'high', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('compatibility-matrix', 'test_result', 'Supported platform and integration matrix with results and known constraints.')],
		sources: ['ISO_25010', 'ISO_29119']
	},
	{
		id: 'SQA-QUA-004', title: 'Verify interaction quality and accessibility',
		objective: 'Evaluate operability, error prevention and recovery, inclusive interaction, representative task paths, keyboard and assistive-technology semantics, and WCAG 2.2 conformance at the declared level.',
		domain: 'interaction_accessibility', severity: 'high', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core'], 'any', ['user_interface', 'web_application']),
		// Intended-use validation by representative users remains a separate reviewer
		// boundary in SQA-VAL-001. Requiring that same validation record here duplicated
		// the gate and prevented technical interaction/accessibility checks from reaching
		// a conclusive result.
		evidenceRequirements: [evidence('interaction-accessibility-results', 'wcag_report', 'Task-based interaction plus automated and manual accessibility results identify WCAG version, level, tested scope, keyboard and semantic checks, error paths, exceptions, and unresolved failures.')],
		sources: ['ISO_25010', 'WCAG_22']
	},
	{
		id: 'SQA-QUA-005', title: 'Demonstrate reliability and recoverability',
		objective: 'Verify availability, fault tolerance, graceful degradation, retry and idempotency behavior, backup restoration, disaster recovery, and data consistency under faults.',
		domain: 'reliability', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('resilience-results', 'test_result', 'Fault-injection or recovery results against reliability objectives.'), evidence('restore-proof', 'operational_record', 'Recent restoration or failover evidence with measured recovery outcomes.')],
		sources: ['ISO_25010', 'ISO_12207', 'IEEE_1012']
	},
	{
		id: 'SQA-QUA-006', title: 'Demonstrate security quality',
		objective: 'Verify confidentiality, integrity, availability, authenticity, accountability, authorization, session handling, secure failure, and resistance to relevant abuse cases.',
		domain: 'security', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('security-verification', 'security_report', 'Threat-linked security verification results with scope, tools, manual checks, findings, and disposition.')],
		sources: ['ISO_25010', 'ISO_27001', 'OWASP_ASVS']
	},
	{
		id: 'SQA-QUA-007', title: 'Measure maintainability and source-code quality',
		objective: 'Measure architecture and source risks affecting modularity, analyzability, modifiability, testability, reliability, security, and performance; enforce reviewed thresholds.',
		domain: 'maintainability', severity: 'high', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core'], 'all', ['source_available']),
		evidenceRequirements: [evidence('source-quality', 'code_quality_report', 'Version-bound static, architecture, complexity, duplication, dependency, and testability measures with dispositions.')],
		sources: ['ISO_25010', 'ISO_5055']
	},
	{
		id: 'SQA-QUA-008', title: 'Verify deployability, adaptability, and replacement',
		objective: 'Test installation, upgrade, rollback, migration, supported-platform adaptation, configuration portability, and safe replacement or removal.',
		domain: 'flexibility_portability', severity: 'medium', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('deployment-matrix', 'test_result', 'Install, upgrade, rollback, and migration results across supported deployment targets.')],
		sources: ['ISO_25010', 'ISO_12207']
	},
	{
		id: 'SQA-WEB-001', title: 'Smoke-sample web availability and initial rendering',
		objective: 'Perform a bounded smoke sample of the authorized entry page: confirm that navigation returns a usable document, the expected application shell renders, and no blank, fatal, or obvious load-error state prevents use. This sample does not establish uptime, capacity, resilience, or whole-site availability.',
		domain: 'web_smoke_availability', severity: 'high', mandatory: true, automationLevel: 'agent_assisted',
		applicability: applicability(['core'], 'any', ['web_application', 'user_interface']),
		evidenceRequirements: [evidence('web-render-smoke-result', 'test_result', 'Bounded browser result records the tested URL, observed response or render state, visible application shell, obvious load failures, and sample limitations.')],
		sources: ['ISO_25010', 'ISO_29119']
	},
	{
		id: 'SQA-WEB-002', title: 'Smoke-sample representative navigation and UI state',
		objective: 'Perform a bounded smoke sample of declared representative navigation paths and reversible state transitions, including route changes, selected controls, back or reload behavior where safe, and visible state consistency. This sample does not establish complete workflow or state-model coverage.',
		domain: 'web_smoke_navigation', severity: 'high', mandatory: true, automationLevel: 'agent_assisted',
		applicability: applicability(['core'], 'any', ['web_application', 'user_interface']),
		evidenceRequirements: [evidence('web-navigation-smoke-result', 'test_result', 'Bounded browser result identifies sampled routes and transitions, expected and actual visible state, recovery performed, and untested paths.')],
		sources: ['ISO_25010', 'ISO_29119']
	},
	{
		id: 'SQA-WEB-003', title: 'Smoke-sample form validation and error recovery',
		objective: 'Perform a bounded, non-destructive smoke sample of representative forms using safe invalid, boundary, and corrected inputs; observe validation feedback, preserved state, error clarity, and recovery. This sample does not establish complete input-domain, business-rule, or destructive-flow coverage.',
		domain: 'web_smoke_forms', severity: 'high', mandatory: true, automationLevel: 'agent_assisted',
		applicability: applicability(['core'], 'any', ['web_application', 'user_interface']),
		evidenceRequirements: [evidence('web-form-smoke-result', 'test_result', 'Bounded browser result records sampled field conditions, expected and actual validation, error presentation, recovery, and excluded destructive cases.')],
		sources: ['ISO_25010', 'ISO_29119', 'WCAG_22']
	},
	{
		id: 'SQA-WEB-004', title: 'Smoke-sample keyboard and semantic accessibility',
		objective: 'Perform a bounded technical smoke sample of representative screens for keyboard reachability, visible focus, logical focus movement, control names, roles and states, headings, landmarks, and error association. This is not a WCAG conformance determination or assistive-technology user validation.',
		domain: 'web_smoke_accessibility', severity: 'high', mandatory: true, automationLevel: 'agent_assisted',
		applicability: applicability(['core'], 'any', ['web_application', 'user_interface']),
		evidenceRequirements: [evidence('web-accessibility-smoke-result', 'test_result', 'Bounded browser result records sampled screens, keyboard path, focus behavior, exposed semantics, observed defects, and explicit conformance limitations.')],
		sources: ['WCAG_22', 'ISO_25010', 'ISO_29119']
	},
	{
		id: 'SQA-WEB-005', title: 'Smoke-sample browser console and request diagnostics',
		objective: 'Perform a bounded smoke sample of browser console and request diagnostics while exercising representative safe workflows; identify uncaught errors, failed essential requests, mixed-content or obvious client integration failures. This sample does not establish performance, security, backend, or full integration assurance.',
		domain: 'web_smoke_diagnostics', severity: 'high', mandatory: true, automationLevel: 'agent_assisted',
		applicability: applicability(['core'], 'any', ['web_application', 'user_interface']),
		evidenceRequirements: [evidence('web-diagnostics-smoke-result', 'test_result', 'Bounded browser result records the sampled workflow and diagnostic window, material console or request failures, repeated observations, and limitations.')],
		sources: ['ISO_25010', 'ISO_29119']
	},
	{
		id: 'SQA-WEB-006', title: 'Smoke-sample responsive layout behavior',
		objective: 'Perform a bounded smoke sample at representative desktop and narrow viewports for usable reflow, reachable controls, readable content, overlap, clipping, and unintended scrolling. This sample does not establish complete device, browser, orientation, zoom, or localization coverage.',
		domain: 'web_smoke_responsive', severity: 'medium', mandatory: true, automationLevel: 'agent_assisted',
		applicability: applicability(['core'], 'any', ['web_application', 'user_interface']),
		evidenceRequirements: [evidence('web-responsive-smoke-result', 'test_result', 'Bounded browser result identifies sampled viewport dimensions, representative screens, layout observations, detected defects, and untested combinations.')],
		sources: ['WCAG_22', 'ISO_25010', 'ISO_29119']
	},
	{
		id: 'SQA-SAF-001', title: 'Analyze and control software-related safety risks',
		objective: 'Identify hazardous software contributions, define risk controls and safe states, verify control effectiveness, and evaluate residual risk throughout the life cycle.',
		domain: 'safety', severity: 'critical', mandatory: true, automationLevel: 'manual',
		applicability: applicability(['core'], 'all', ['safety_critical']),
		evidenceRequirements: [evidence('safety-analysis', 'safety_case', 'Hazard analysis and safety argument linking controls to verified evidence and residual-risk approval.')],
		sources: ['ISO_25010', 'IEEE_1012', 'IEC_61508']
	},
	{
		id: 'SQA-SEC-001', title: 'Integrate secure development and threat modeling',
		objective: 'Prepare people, process, and technology; protect development artifacts; identify threats and abuse cases; define security requirements; and address vulnerabilities at their root cause.',
		domain: 'secure_development', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('secure-development-assessment', 'assessment_record', 'Release-relevant secure-development practice assessment and improvement actions.'), evidence('threat-model', 'risk_register', 'Current threat model with trust boundaries, assets, threats, controls, and residual risk.')],
		sources: ['NIST_SSDF', 'ISO_27001', 'OWASP_ASVS']
	},
	{
		id: 'SQA-SEC-002', title: 'Verify application security controls',
		objective: 'Test architecture, authentication, authorization, input handling, cryptography, communications, data protection, API, file, business-logic, and configuration controls at a risk-appropriate rigor.',
		domain: 'application_security', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core'], 'any', ['web_application', 'public_api']),
		evidenceRequirements: [evidence('appsec-verification', 'security_report', 'Versioned technical control assessment with an explicit verification baseline and unresolved findings.'), evidence('penetration-test', 'penetration_test', 'Independent or appropriately segregated penetration test for material attack surfaces.')],
		sources: ['OWASP_ASVS', 'NIST_SSDF', 'ISO_27001']
	},
	{
		id: 'SQA-SUP-001', title: 'Control software supply-chain risk',
		objective: 'Inventory components and suppliers, preserve build provenance and artifact integrity, assess known vulnerabilities and licenses, and define time-bound remediation or acceptance.',
		domain: 'supply_chain', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('release-sbom', 'sbom', 'Machine-readable release SBOM with minimum component identity, relationship, version, author, timestamp, and validation fields.'), evidence('provenance-review', 'security_report', 'Dependency, provenance, signature, vulnerability, and exception review tied to the release.')],
		sources: ['CISA_SBOM', 'NIST_SSDF', 'ISO_27001']
	},
	{
		id: 'SQA-SEC-003', title: 'Operate vulnerability and incident response',
		objective: 'Continuously receive, triage, remediate, disclose, and learn from vulnerabilities and security incidents using risk-based service levels and verified fixes.',
		domain: 'security_operations', severity: 'high', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('vulnerability-response', 'operational_record', 'Recent vulnerability and incident samples show detection, severity, ownership, service-level performance, correction, verification, and root-cause action.')],
		sources: ['NIST_SSDF', 'ISO_27001', 'ISO_12207']
	},
	{
		id: 'SQA-PRI-001', title: 'Validate privacy scope, minimization, and rights',
		objective: 'Verify lawful and disclosed data purposes, minimization, consent or choice where applicable, retention and deletion, data-subject or consumer rights, and processor or sharing behavior.',
		domain: 'privacy', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core'], 'all', ['handles_personal_data']),
		evidenceRequirements: [evidence('privacy-assessment', 'privacy_record', 'Current data inventory and privacy assessment mapping purposes, categories, locations, recipients, retention, rights, and controls.'), evidence('privacy-test-results', 'test_result', 'End-to-end tests of applicable notice, preference, access, correction, deletion, export, restriction, and retention behavior.')],
		sources: ['GDPR', 'CCPA', 'ISO_27001']
	},
	{
		id: 'SQA-PRI-002', title: 'Verify personal-data protection and residency',
		objective: 'Test access boundaries, encryption, logging minimization, pseudonymization where appropriate, deletion propagation, backup handling, transfers, localization, and declared residency constraints.',
		domain: 'data_protection', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core'], 'all', ['handles_personal_data']),
		evidenceRequirements: [evidence('data-protection-results', 'security_report', 'Technical data-flow and control tests across stores, logs, backups, exports, and third parties.'), evidence('residency-record', 'privacy_record', 'Approved transfer and residency scope with tested enforcement where promised or required.')],
		sources: ['GDPR', 'CCPA', 'ISO_27001']
	},
	{
		id: 'SQA-OPS-001', title: 'Verify production observability and operational control',
		objective: 'Confirm health, service-level, security, audit, capacity, and business-critical signals are accurate, bounded, protected, actionable, and exercised through incident and recovery procedures.',
		domain: 'operations', severity: 'high', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('operational-assurance', 'operational_record', 'Monitoring, alert, incident, capacity, backup, restore, continuity, and audit-log exercises with outcomes.')],
		sources: ['ISO_12207', 'ISO_25010', 'ISO_27001']
	},
	{
		id: 'SQA-CHG-001', title: 'Control configuration, change, release, and disposal',
		objective: 'Uniquely identify baselines and artifacts, authorize and assess changes, reproduce builds, verify releases and rollback, retain required records, and securely retire software and data.',
		domain: 'configuration_change', severity: 'high', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core']),
		evidenceRequirements: [evidence('configuration-control', 'configuration_record', 'Release baseline, impact analysis, build provenance, deployment, rollback, retention, and retirement configuration evidence.'), evidence('change-release-approval', 'approval_record', 'Authorized change and release disposition tied to the assessed baseline.')],
		sources: ['ISO_12207', 'ISO_90003', 'NIST_SSDF']
	},
	{
		id: 'SQA-LOC-001', title: 'Validate localization and regional behavior',
		objective: 'Test supported languages, text expansion, Unicode and input methods, dates, time zones, numbers, currency, addresses, sorting, cultural expectations, legal notices, and regional service or residency behavior.',
		domain: 'localization', severity: 'medium', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core'], 'any', ['localized', 'multi_region']),
		evidenceRequirements: [evidence('locale-matrix', 'test_result', 'Locale and region matrix with representative functional, layout, content, format, time-zone, and data-location results.')],
		sources: ['ISO_25010', 'ISO_29119']
	},
	{
		id: 'SQA-AI-001', title: 'Assure AI-specific data, model, and system risks',
		objective: 'Version data, models, prompts, tools, and evaluations; test misuse, injection, leakage, harmful failure modes, robustness, monitoring, human oversight, and controlled model or behavior changes.',
		domain: 'ai_assurance', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['core'], 'all', ['ai_enabled']),
		evidenceRequirements: [evidence('ai-risk-assessment', 'risk_register', 'AI-specific threat, misuse, data, model, tool, and human-impact risks with controls and residual decisions.'), evidence('ai-evaluation', 'test_result', 'Versioned task, safety, security, robustness, privacy, and regression evaluations with thresholds and representative failure sets.')],
		sources: ['NIST_SSDF_AI', 'NIST_SSDF', 'ISO_29119']
	},
	{
		id: 'SQA-MED-001', title: 'Classify medical software and intended use risk',
		objective: 'Document intended use, users, patient and operator context, device-software functions, software safety classification, documentation level, hazards, and regulatory pathway assumptions.',
		domain: 'medical_risk', severity: 'critical', mandatory: true, automationLevel: 'manual',
		applicability: applicability(['medical']),
		evidenceRequirements: [evidence('medical-risk-file', 'risk_register', 'Approved intended-use, classification, hazard, documentation-level, and regulatory applicability rationale.'), evidence('regulatory-review', 'regulatory_record', 'Qualified regulatory review of jurisdiction and submission obligations.')],
		sources: ['FDA_DEVICE_SOFTWARE', 'IEC_62304', 'ISO_14971']
	},
	{
		id: 'SQA-MED-002', title: 'Trace medical risk controls through V&V',
		objective: 'Trace hazards, software requirements, architecture, risk controls, tests, anomalies, residual risk, and intended-use validation with rigor proportionate to patient and user harm.',
		domain: 'medical_validation', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['medical']),
		evidenceRequirements: [evidence('medical-traceability', 'traceability_matrix', 'Complete hazard-to-control-to-requirement-to-test-to-result-to-anomaly traceability.'), evidence('medical-validation', 'validation_record', 'Approved device-level intended-use validation and unresolved-anomaly rationale.')],
		sources: ['FDA_DEVICE_SOFTWARE', 'IEC_62304', 'ISO_14971', 'IEEE_1012']
	},
	{
		id: 'SQA-MED-003', title: 'Control the medical software life cycle and post-market feedback',
		objective: 'Apply controlled development, maintenance, configuration, problem resolution, cybersecurity, production or QMS software assurance where relevant, and post-production risk feedback.',
		domain: 'medical_lifecycle', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['medical']),
		evidenceRequirements: [evidence('medical-lifecycle', 'audit_record', 'Life-cycle and problem-resolution records linked to the released configuration.'), evidence('post-market-review', 'operational_record', 'Post-market, vulnerability, complaint, and anomaly monitoring with risk-file feedback.'), evidence('csa-record', 'validation_record', 'Risk-based assurance for applicable production or quality-management software.')],
		sources: ['IEC_62304', 'ISO_14971', 'FDA_CSA', 'FDA_DEVICE_SOFTWARE']
	},
	{
		id: 'SQA-AVN-001', title: 'Establish airborne software level and assurance plans',
		objective: 'Define system safety allocation, software level, life-cycle plans, standards, transition criteria, tool assumptions, and certification coordination for the specific airborne context.',
		domain: 'aviation_planning', severity: 'critical', mandatory: true, automationLevel: 'manual',
		applicability: applicability(['aviation']),
		evidenceRequirements: [evidence('airborne-plans', 'regulatory_record', 'Approved airborne software planning set, software level rationale, and authority or designee coordination evidence.')],
		sources: ['FAA_DO178C', 'IEEE_1012']
	},
	{
		id: 'SQA-AVN-002', title: 'Demonstrate airborne traceability, verification, and independence',
		objective: 'Maintain life-cycle traceability, verify requirements and code with level-appropriate reviews and tests, resolve structural coverage gaps, and apply required independence.',
		domain: 'aviation_verification', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['aviation']),
		evidenceRequirements: [evidence('airborne-trace', 'traceability_matrix', 'Requirements-to-design-to-code-to-test-to-result traceability with derived requirement and anomaly treatment.'), evidence('airborne-coverage', 'coverage_report', 'Level-appropriate requirements and structural coverage results with gap analysis.'), evidence('airborne-independent-review', 'verification_record', 'Independent verification records appropriate to software level.')],
		sources: ['FAA_DO178C', 'IEEE_1012']
	},
	{
		id: 'SQA-AVN-003', title: 'Control airborne configuration and accomplishment evidence',
		objective: 'Protect life-cycle data, baselines, builds, tools, problem reports, quality records, and release evidence needed to show planned objectives were satisfied.',
		domain: 'aviation_configuration', severity: 'critical', mandatory: true, automationLevel: 'manual',
		applicability: applicability(['aviation']),
		evidenceRequirements: [evidence('airborne-configuration', 'configuration_record', 'Reproducible software configuration index, environment, build, tool, problem, and release records.'), evidence('airborne-accomplishment', 'approval_record', 'Reviewed accomplishment summary and unresolved issue disposition.')],
		sources: ['FAA_DO178C']
	},
	{
		id: 'SQA-FSA-001', title: 'Establish the functional-safety life cycle and integrity level',
		objective: 'Define item or system boundaries, hazards, risk classification, safety integrity targets, safety plan, responsibilities, independence, and confirmation measures.',
		domain: 'functional_safety', severity: 'critical', mandatory: true, automationLevel: 'manual',
		applicability: applicability(['functional_safety']),
		evidenceRequirements: [evidence('safety-lifecycle-plan', 'safety_case', 'Approved hazard analysis, integrity classification, safety plan, roles, independence, and acceptance rationale.')],
		sources: ['IEC_61508', 'ISO_26262', 'IEEE_1012']
	},
	{
		id: 'SQA-FSA-002', title: 'Trace and verify safety requirements and mechanisms',
		objective: 'Trace hazards and safety goals to technical and software requirements, architecture, independence or freedom-from-interference measures, fault responses, tests, and residual risk.',
		domain: 'safety_verification', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['functional_safety']),
		evidenceRequirements: [evidence('safety-trace', 'traceability_matrix', 'Hazard-to-safety-goal-to-requirement-to-mechanism-to-verification traceability.'), evidence('safety-verification', 'verification_record', 'Fault, boundary, timing, degraded-mode, independence, and safety-mechanism verification results.')],
		sources: ['IEC_61508', 'ISO_26262']
	},
	{
		id: 'SQA-FSA-003', title: 'Control safety-related tools, changes, operation, and retirement',
		objective: 'Assess tool confidence, qualify tools where required, control configuration and changes, analyze impact, verify production and field behavior, manage incidents, and preserve safety through decommissioning.',
		domain: 'safety_lifecycle_control', severity: 'critical', mandatory: true, automationLevel: 'manual',
		applicability: applicability(['functional_safety']),
		evidenceRequirements: [evidence('safety-tool-change', 'configuration_record', 'Tool confidence, configuration, change-impact, re-verification, field monitoring, and retirement evidence.'), evidence('safety-confirmation', 'approval_record', 'Required confirmation review or assessment disposition.')],
		sources: ['IEC_61508', 'ISO_26262']
	},
	{
		id: 'SQA-PCI-001', title: 'Define and minimize the payment-data environment',
		objective: 'Confirm whether the system stores, processes, transmits, or can affect payment account data; document flows and dependencies; minimize scope; and protect stored and transmitted data.',
		domain: 'payment_scope', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['payment']),
		evidenceRequirements: [evidence('cde-scope', 'risk_register', 'Validated payment-data flows, cardholder-data environment boundary, connected systems, third parties, and scope-reduction controls.'), evidence('payment-data-controls', 'security_report', 'Tests of storage minimization, masking, cryptography, key handling, and transmission protections.')],
		sources: ['PCI_DSS']
	},
	{
		id: 'SQA-PCI-002', title: 'Verify payment access, segmentation, logging, and monitoring',
		objective: 'Test least privilege, strong authentication, network segmentation, secure configuration, malware defenses where applicable, audit trails, alerting, and periodic scope validation.',
		domain: 'payment_security', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['payment']),
		// Browser activity can support the technical security report, but cannot attest
		// the payment-data environment or network-segmentation boundary. Keep that
		// independent/documentary evidence behind the trusted-reviewer workflow.
		evidenceRequirements: [evidence('payment-control-tests', 'security_report', 'Technical tests of identity, access, segmentation, configuration, logging, monitoring, and alert response.'), evidence('payment-scope-validation', 'audit_record', 'Current independently reviewed scope and segmentation validation with exceptions and compensating or customized controls identified.')],
		sources: ['PCI_DSS']
	},
	{
		id: 'SQA-PCI-003', title: 'Operate payment vulnerability management and security testing',
		objective: 'Apply secure development, inventory and patching, vulnerability scans, public-application protection, penetration testing, change detection, incident response, and service-provider oversight.',
		domain: 'payment_assurance', severity: 'critical', mandatory: true, automationLevel: 'hybrid',
		applicability: applicability(['payment']),
		evidenceRequirements: [evidence('payment-vulnerability-evidence', 'security_report', 'Current scan, patch, public-application, change-detection, and finding-remediation evidence.'), evidence('payment-penetration-test', 'penetration_test', 'Applicable internal, external, and segmentation penetration-test evidence from a competent assessor.'), evidence('payment-governance', 'audit_record', 'Security policy, incident exercise, personnel responsibilities, and service-provider oversight records.')],
		sources: ['PCI_DSS', 'NIST_SSDF']
	}
];

function assertPlainObject(value, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object.`);
	}
}

function assertExactKeys(value, allowed, label) {
	const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
	if (unexpected.length > 0) {
		throw new TypeError(`${label} has unsupported fields: ${unexpected.join(', ')}.`);
	}
}

function assertNonEmptyString(value, label, maximum = 2_000) {
	if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
		throw new TypeError(`${label} must be a non-empty string no longer than ${maximum} characters.`);
	}
}

function deepFreeze(value) {
	if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export function validateSqaCatalog(catalog) {
	assertPlainObject(catalog, 'SQA catalog');
	assertExactKeys(catalog, ['schemaVersion', 'catalogVersion', 'publishedAt', 'disclaimer', 'sources', 'profiles', 'attributes', 'controls'], 'SQA catalog');
	if (catalog.schemaVersion !== 1) throw new TypeError('SQA catalog schemaVersion must be 1.');
	assertNonEmptyString(catalog.catalogVersion, 'SQA catalog catalogVersion', 64);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(catalog.publishedAt)) {
		throw new TypeError('SQA catalog publishedAt must be a canonical UTC timestamp.');
	}
	assertNonEmptyString(catalog.disclaimer, 'SQA catalog disclaimer', 1_000);
	assertPlainObject(catalog.sources, 'SQA catalog sources');
	assertPlainObject(catalog.profiles, 'SQA catalog profiles');
	if (!Array.isArray(catalog.attributes) || !Array.isArray(catalog.controls)) {
		throw new TypeError('SQA catalog attributes and controls must be arrays.');
	}

	const sourceIds = new Set();
	for (const [key, source] of Object.entries(catalog.sources)) {
		assertPlainObject(source, `SQA source ${key}`);
		assertExactKeys(source, ['id', 'title', 'publisher', 'version', 'url', 'scope'], `SQA source ${key}`);
		if (source.id !== key) throw new TypeError(`SQA source key ${key} must match its id.`);
		if (sourceIds.has(source.id)) throw new TypeError(`Duplicate SQA source id: ${source.id}.`);
		sourceIds.add(source.id);
		for (const field of ['id', 'title', 'publisher', 'version', 'scope']) {
			assertNonEmptyString(source[field], `SQA source ${key}.${field}`);
		}
		try {
			const url = new URL(source.url);
			if (url.protocol !== 'https:') throw new Error('not HTTPS');
		} catch {
			throw new TypeError(`SQA source ${key}.url must be an HTTPS URL.`);
		}
	}

	const profileIds = new Set();
	for (const [key, profile] of Object.entries(catalog.profiles)) {
		assertPlainObject(profile, `SQA profile ${key}`);
		assertExactKeys(profile, ['id', 'title', 'description'], `SQA profile ${key}`);
		if (profile.id !== key) throw new TypeError(`SQA profile key ${key} must match its id.`);
		if (profileIds.has(profile.id)) throw new TypeError(`Duplicate SQA profile id: ${profile.id}.`);
		profileIds.add(profile.id);
		assertNonEmptyString(profile.title, `SQA profile ${key}.title`);
		assertNonEmptyString(profile.description, `SQA profile ${key}.description`);
	}
	if (!profileIds.has('core')) throw new TypeError('SQA catalog must define the core profile.');

	const attributeIds = new Set();
	for (const attribute of catalog.attributes) {
		assertNonEmptyString(attribute, 'SQA product attribute', 64);
		if (!/^[a-z][a-z0-9_]*$/.test(attribute)) throw new TypeError(`Invalid SQA product attribute: ${attribute}.`);
		if (attributeIds.has(attribute)) throw new TypeError(`Duplicate SQA product attribute: ${attribute}.`);
		attributeIds.add(attribute);
	}

	const controlIds = new Set();
	for (const control of catalog.controls) {
		assertPlainObject(control, 'SQA control');
		assertExactKeys(control, ['id', 'title', 'objective', 'domain', 'severity', 'mandatory', 'automationLevel', 'applicability', 'evidenceRequirements', 'sources'], `SQA control ${control.id ?? '<unknown>'}`);
		if (!/^SQA-[A-Z]{2,4}-\d{3}$/.test(control.id)) throw new TypeError(`Invalid SQA control id: ${control.id}.`);
		if (controlIds.has(control.id)) throw new TypeError(`Duplicate SQA control id: ${control.id}.`);
		controlIds.add(control.id);
		assertNonEmptyString(control.title, `${control.id}.title`, 200);
		assertNonEmptyString(control.objective, `${control.id}.objective`, 2_000);
		if (!/^[a-z][a-z0-9_]*$/.test(control.domain)) throw new TypeError(`${control.id}.domain is invalid.`);
		if (!SQA_CONTROL_SEVERITIES.includes(control.severity)) throw new TypeError(`${control.id}.severity is invalid.`);
		if (typeof control.mandatory !== 'boolean') throw new TypeError(`${control.id}.mandatory must be boolean.`);
		if (!SQA_AUTOMATION_LEVELS.includes(control.automationLevel)) throw new TypeError(`${control.id}.automationLevel is invalid.`);
		assertPlainObject(control.applicability, `${control.id}.applicability`);
		assertExactKeys(control.applicability, ['profiles', 'mode', 'attributes'], `${control.id}.applicability`);
		if (!Array.isArray(control.applicability.profiles) || control.applicability.profiles.length === 0) throw new TypeError(`${control.id} must select at least one profile.`);
		if (!['always', 'any', 'all'].includes(control.applicability.mode)) throw new TypeError(`${control.id}.applicability.mode is invalid.`);
		if (!Array.isArray(control.applicability.attributes)) throw new TypeError(`${control.id}.applicability.attributes must be an array.`);
		for (const profile of control.applicability.profiles) {
			if (!profileIds.has(profile)) throw new TypeError(`${control.id} references unknown profile ${profile}.`);
		}
		for (const attribute of control.applicability.attributes) {
			if (!attributeIds.has(attribute)) throw new TypeError(`${control.id} references unknown attribute ${attribute}.`);
		}
		if (control.applicability.mode === 'always' && control.applicability.attributes.length > 0) throw new TypeError(`${control.id} always-applicable controls cannot name attributes.`);
		if (control.applicability.mode !== 'always' && control.applicability.attributes.length === 0) throw new TypeError(`${control.id} conditional applicability requires attributes.`);
		if (!Array.isArray(control.evidenceRequirements) || control.evidenceRequirements.length === 0) throw new TypeError(`${control.id} requires evidence requirements.`);
		const requirementIds = new Set();
		for (const requirement of control.evidenceRequirements) {
			assertPlainObject(requirement, `${control.id} evidence requirement`);
			assertExactKeys(requirement, ['id', 'type', 'description', 'minimum'], `${control.id} evidence requirement`);
			if (!/^[a-z][a-z0-9-]*$/.test(requirement.id)) throw new TypeError(`${control.id} evidence id is invalid.`);
			if (requirementIds.has(requirement.id)) throw new TypeError(`${control.id} has duplicate evidence id ${requirement.id}.`);
			requirementIds.add(requirement.id);
			if (!SQA_EVIDENCE_TYPES.includes(requirement.type)) throw new TypeError(`${control.id} evidence type ${requirement.type} is invalid.`);
			assertNonEmptyString(requirement.description, `${control.id}.${requirement.id}.description`, 1_000);
			if (!Number.isSafeInteger(requirement.minimum) || requirement.minimum < 1 || requirement.minimum > 20) throw new TypeError(`${control.id}.${requirement.id}.minimum is invalid.`);
		}
		if (!Array.isArray(control.sources) || control.sources.length === 0) throw new TypeError(`${control.id} must reference at least one source.`);
		for (const source of control.sources) {
			if (!sourceIds.has(source)) throw new TypeError(`${control.id} references unknown source ${source}.`);
		}
	}
	return catalog;
}

export const SQA_CATALOG = deepFreeze(validateSqaCatalog({
	schemaVersion: 1,
	catalogVersion: SQA_CATALOG_VERSION,
	publishedAt: '2026-08-17T00:00:00.000Z',
	disclaimer: SQA_NO_CERTIFICATION_DISCLAIMER,
	sources: SQA_SOURCES,
	profiles: SQA_PROFILES,
	attributes: [...SQA_PRODUCT_ATTRIBUTES],
	controls: CONTROLS
}));

function normalizeStringSelection(values, allowed, label, defaults = []) {
	const selected = values === undefined ? defaults : values;
	if (!Array.isArray(selected)) throw new TypeError(`${label} must be an array.`);
	const unique = [];
	for (const value of selected) {
		if (typeof value !== 'string' || !allowed.has(value)) throw new TypeError(`Unknown ${label.slice(0, -1)}: ${String(value)}.`);
		if (!unique.includes(value)) unique.push(value);
	}
	return unique;
}

/** Resolve controls for selected profiles and product attributes. Core is always included. */
export function resolveSqaScope({ profiles, attributes } = {}, catalog = SQA_CATALOG) {
	validateSqaCatalog(catalog);
	const profileSet = new Set(Object.keys(catalog.profiles));
	const attributeSet = new Set(catalog.attributes);
	const selectedProfiles = normalizeStringSelection(profiles, profileSet, 'profiles', ['core']);
	if (!selectedProfiles.includes('core')) selectedProfiles.unshift('core');
	const selectedAttributes = normalizeStringSelection(attributes, attributeSet, 'attributes');

	const applicableControls = [];
	const excludedControls = [];
	for (const control of catalog.controls) {
		if (!control.applicability.profiles.some(profile => selectedProfiles.includes(profile))) continue;
		const { mode, attributes: required } = control.applicability;
		const applies = mode === 'always'
			|| (mode === 'any' && required.some(attribute => selectedAttributes.includes(attribute)))
			|| (mode === 'all' && required.every(attribute => selectedAttributes.includes(attribute)));
		if (applies) applicableControls.push(control);
		else excludedControls.push({
			controlId: control.id,
			reason: `Requires product attribute ${mode === 'all' ? 'set' : 'selection'}: ${required.join(', ')}.`
		});
	}

	return {
		catalogVersion: catalog.catalogVersion,
		profiles: selectedProfiles,
		attributes: selectedAttributes,
		applicableControls,
		excludedControls
	};
}

export function getSqaControl(controlId, catalog = SQA_CATALOG) {
	return catalog.controls.find(control => control.id === controlId);
}
