import 'dotenv/config';
import { createApplication } from './app.js';
import { createInstanceAccess } from './instanceAccess.js';
import { createOperationalControls } from './operations.js';
import { createOperationalLogger } from './operationalLogger.js';
import { createConfiguredApplicationServices } from './serviceFactory.js';
import { createConfiguredDrytisIntegration } from './drytisIntegrationFactory.js';
import { closeApplicationBrowsers, drainHttpServer, installShutdownHandlers } from './processLifecycle.js';
import { createRunKeepalive, isRunStatusActive } from './keepalive.js';
import { createRunResume } from './runResume.js';
import { listRunSnapshots, loadRunSnapshot } from './agent.js';
import { runWithRequestActor } from './requestActor.js';
import { recordEvent, durationBucket } from './analytics.js';
import { createInviteService } from './invites.js';
// RT1 (#14680): local branded-browser registry feeds browser executability.
import { probeLocalBrowsers, playwrightLaunchProbe } from './localBrowserRegistry.js';
import { setLocalRegistrySnapshot } from './browserSupportResolution.js';
import * as path from 'node:path';

/** Local analytics counters live beside the session store. */
const ANALYTICS_DIR = path.join(process.cwd(), '.qase', 'analytics');

// Validate process-local operational limits and metrics credentials before
// opening PostgreSQL or Redis clients.
const logger = createOperationalLogger({ component: 'qase-api' });
const operations = createOperationalControls({ logger });
const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('PORT must be an integer from 1 to 65535.');
const host = String(process.env.QASE_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
const {
	services, mode: runStoreMode, executionMode, tenantContext, pool, executionQueue
} = await createConfiguredApplicationServices();
// RT1 (#14680): probe the REAL local branded binaries at boot (Chrome/Brave/
// Opera where installed) and feed the support resolver. Launch-verified with
// a short-lived Playwright start — a binary that exists but cannot launch is
// recorded as such, never as executable. TTL re-probes keep it fresh.
try {
	const localBrowsers = await probeLocalBrowsers({ launchProbe: playwrightLaunchProbe(), force: true });
	setLocalRegistrySnapshot(localBrowsers);
	logger.info?.('local-browser-registry', {
		brands: localBrowsers.brands.map((b) => ({ code: b.code, status: b.status, version: b.version, launchVerified: b.launchVerified }))
	});
	// Refresh the snapshot on the registry's TTL cadence (launch probes are
	// cheap, bounded, and keep availability truthful after binary changes).
	setInterval(() => {
		probeLocalBrowsers({ launchProbe: playwrightLaunchProbe(), force: true })
			.then(setLocalRegistrySnapshot)
			.catch(() => { /* keep the last good snapshot */ });
	}, 5 * 60 * 1000).unref?.();
} catch (error) {
	logger.error?.('local-browser-registry probe failed', error);
	// Honest degraded state: no snapshot → branded codes resolve their
	// engine fallback; nothing claims a branded binary that was not verified.
	setLocalRegistrySnapshot(null);
}
const access = createInstanceAccess({ tenantContext });

// Inbound-traffic keepalive: workspace containers pause after an idle window.
// During an agent run the server is busy but receives almost no inbound HTTP,
// so the container can be paused mid-run and the run dies on the next resume.
// Loopback self-pings do NOT count as edge traffic, so the keepalive must
// target the PUBLIC site URL (QASE_PUBLIC_URL) when available; loopback is
// only a fallback for local development.
const keepaliveUrl = process.env.QASE_PUBLIC_URL
	? `${process.env.QASE_PUBLIC_URL.replace(/\/+$/, '')}/healthz`
	: `http://127.0.0.1:${port}/healthz`;
const keepalive = createRunKeepalive({
	getUrl: () => keepaliveUrl,
	logger,
	// Ground truth from the live runtime records: a run whose agent loop is
	// actually in flight keeps the keepalive armed even when the run bus has
	// been quiet for the whole quiet window (a single long model generation
	// can stream nothing for minutes).
	isActive: () => {
		try {
			return Boolean(services.runs.listLive?.().some(entry => entry?.record?.running));
		} catch {
			return false;
		}
	}
});
if (typeof services.runs.setStatus === 'function') {
	const setStatus = services.runs.setStatus.bind(services.runs);
	services.runs.setStatus = async (session, status, detail) => {
		const runStartedBefore = session.runStartedAt;
		await setStatus(session, status, detail);
		if (isRunStatusActive(status)) keepalive.noteActive();
		// Local usage analytics: count run starts (first turn only) and finished
		// runs with a duration bucket so the "users don't watch the agent"
		// hypothesis has real data.
		try {
			if (status === 'running' && runStartedBefore === undefined) {
				recordEvent(ANALYTICS_DIR, 'run_started', { dimensions: { mode: session.mode, ...(session.cohort ? { cohort: session.cohort } : {}) } });
			}
			if (['done', 'error', 'interrupted'].includes(status)) {
				const elapsed = typeof session.runStartedAt === 'number' ? Date.now() - session.runStartedAt : undefined;
				recordEvent(ANALYTICS_DIR, 'run_finished', {
					dimensions: { mode: session.mode, status, duration_bucket: durationBucket(elapsed), ...(session.cohort ? { cohort: session.cohort } : {}) }
				});
			}
		} catch { /* analytics must never break the run */ }
	};
}
if (typeof services.events.subscribeGlobal === 'function') {
	// Run-bus events (messages, activity, live frames) only flow while a run
	// is in flight, so they are a precise liveness signal.
	services.events.subscribeGlobal((_sessionId, event) => {
		if (event?.type === 'status' ? isRunStatusActive(event.status) : true) keepalive.noteActive();
		// Token usage committed after each turn feeds the model-token metrics.
		if (event?.type === 'usage' && event.usage && typeof event.usage.totalTokens === 'number') {
			const mode = event.mode === 'sqa' || event.mode === 'founder' ? event.mode : 'qa';
			operations.observeTokens({ kind: 'input', mode, value: event.usage.inputTokens });
			operations.observeTokens({ kind: 'output', mode, value: event.usage.outputTokens });
			operations.observeTokens({ kind: 'total', mode, value: event.usage.totalTokens });
		}
	});
}
const drytisIntegration = createConfiguredDrytisIntegration({
	services,
	tenantContext,
	pool,
	runStoreMode,
	logger
});

let shuttingDown = false;
const { app, demoEnabled } = createApplication({
	services, access, executionQueue, operations, logger,
	inviteService: createInviteService(),
	drytisIntegrationApi: drytisIntegration?.api,
	drytisDelivery: drytisIntegration ? {
		deliveryClient: drytisIntegration.deliveryClient,
		ticketsTarget: drytisIntegration.ticketsTarget,
		founderHandoffTarget: drytisIntegration.founderHandoffTarget
	} : undefined,
	isDraining: () => shuttingDown
});

// Chromium is a child process; without this it can outlive the server process.
let server;
installShutdownHandlers({
	logger,
	onDraining: signal => {
		shuttingDown = true;
		logger.info('process.draining', { signal });
	},
	steps: [
		() => { keepalive.stop(); },
		() => drainHttpServer(server),
		() => closeApplicationBrowsers(services),
		() => services.lifecycle.close()
	]
});

const config = await services.configuration.getPublic();
server = app.listen(port, host, () => {
	if (process.env.NODE_ENV === 'production') {
		logger.info('process.started', {
			host, port, storeMode: runStoreMode, executionMode,
			accessMode: 'embedded-instance', drytisIntegration: Boolean(drytisIntegration),
			provider: config.provider, model: config.model
		});
		if (config.problem) logger.warn('configuration.problem', { errorName: 'ConfigurationError' });
	} else {
	console.log('\n  Qase — autonomous QA agent');
	console.log(`  http://${host}:${port}`);
	console.log(`  run store: ${runStoreMode}`);
	console.log(`  execution: ${executionMode}`);
	console.log('  access: Drytis-owned embedded instance');
	console.log(`  Drytis integration: ${drytisIntegration ? 'enabled' : 'disabled'}`);
	console.log(`  ${config.provider} · ${config.model}${config.baseUrl ? ` · ${config.baseUrl}` : ''}`);
	if (demoEnabled) {
		console.log(`  practice target: http://${host}:${port}/demo  (demo@qase.dev / demo1234)`);
	}
	console.log('');
	if (config.problem) {
		console.log(`  ! ${config.problem}\n`);
	}
	}

	// Boot-time recovery: any run that was actively running when the previous
	// process died (container pause/restart) resumes automatically instead of
	// staying `interrupted`. Deferred so the listener is fully up first, and
	// never blocking — failures are logged inside runResume.
	if (typeof services.agent?.runTurn === 'function') {
		const resumeTimer = setTimeout(() => {
			const runResume = createRunResume({
				logger,
				// Session-owner actor context so per-user model configuration,
				// memory, and run ownership resolve correctly during recovery.
				withRequestActor: actor => work => runWithRequestActor(actor, work),
				// Snapshot loader — without this every snapshot read resolves to
				// the factory default (null) and no candidate ever resumes.
				loadSnapshot: loadRunSnapshot
			});
			void runResume.resumeAll({
				listSnapshots: listRunSnapshots,
				// Safety net for a lost snapshot directory: resumable interrupted
				// sessions found in the store still become candidates. Unscoped
				// owner (undefined) — boot-time recovery runs outside any request
				// actor, and each resume re-enters the OWNER's actor context via
				// withRequestActor, so per-user config still applies to the turn.
				listInterrupted: async () => {
					const summaries = await services.runs.listInterrupted?.() ?? [];
					if (summaries.length) return summaries;
					// Fallback: unscoped scan of recent sessions.
					const all = await services.runs.listAll?.() ?? [];
					const loaded = await Promise.all(
						all.filter(s => s?.status === 'interrupted').map(s => services.runs.getAny?.(s.id) ?? s)
					);
					return loaded.filter(Boolean);
				},
				// Unscoped get — same reason as listInterrupted: the boot actor is
				// the default tenant actor and would hide user-owned sessions.
				get: id => services.runs.getAny?.(id) ?? services.runs.get(id),
				ensureRuntime: async session => services.agent.ensureRuntime(session),
				runTurn: (session, options) => services.agent.runTurn(session, options),
				addMessage: services.runs.addMessage.bind(services.runs),
				setStatus: services.runs.setStatus.bind(services.runs),
				// Fails activities still "running" from before the restart so they
				// cannot veto the recovery turn's report publication.
				updateActivity: services.runs.updateActivity.bind(services.runs)
			});
		}, 5_000);
		resumeTimer.unref?.();
	}
});
