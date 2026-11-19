/**
 * Launcher and progress helpers for QA-engine runs. (The file keeps its
 * historical name because the stored run flag is still qaExecutionMode
 * "hybrid": reasoning model + JEV on top of deterministic detectors.)
 */
import { browserExecutionEngine } from './qaBrowserStatus.js';

export function hybridAvailabilityMessage(config) {
	const qa = config?.hybridQa;
	if (!qa) return '';
	const reasoner = qa.reasonerConfigured ? `${qa.reasoner} explores and reviews visuals` : 'no reasoning-model key configured';
	const jev = qa.classifierConfigured ? `${qa.classifier} verifies findings` : 'no JEV key configured';
	return `QA engine ready · ${reasoner} · ${jev}.`;
}

/** Kept for the live view: engine frames always show the page being tested. */
export function holdPrimaryPreview() {
	return false;
}

export function viewportStatusText() {
	return '';
}

/** Progress for the header card: completed engine phases out of all phases. */
export function hybridScenarioProgress(session) {
	if (session?.mode !== 'qa' || session.hybrid?.version !== 2) return null;
	const phases = session.hybrid.phases ?? [];
	const done = phases.filter(phase => ['done', 'skipped', 'failed'].includes(phase.status)).length;
	return { total: phases.length, done, percent: phases.length ? Math.round(done / phases.length * 100) : 0 };
}

/** Engine runs render their results in the QA evidence workspace instead. */
export function renderHybridQa() {
	return null;
}

/** Explicit launcher selection for a single-browser engine run. */
export function hybridLaunchOptions({ mode, envIds, configurations }) {
	if (!mode || mode === 'legacy') return null;
	if (mode !== 'hybrid') throw new Error('Unknown QA execution mode.');
	if (envIds?.length !== 1) throw new Error('Choose one browser configuration for this run, or use the browser matrix to test several.');
	const environment = configurations.find(item => item.envId === envIds[0]);
	if (!environment || environment.availability !== 'AVAILABLE') throw new Error('The selected browser is no longer available. Use the recommended browser or refresh the browser list.');
	const engine = browserExecutionEngine(environment);
	if (!engine) throw new Error('Refresh browser details to load the verified execution engine. Your test setup is kept.');
	return { qaExecutionMode: 'hybrid', environmentId: environment.envId, engine };
}
