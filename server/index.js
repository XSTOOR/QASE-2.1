import 'dotenv/config';
import { createApplication } from './app.js';
import { createConfiguredApplicationServices } from './serviceFactory.js';

const { services, mode: runStoreMode } = await createConfiguredApplicationServices();

const { app, demoEnabled } = createApplication({ services });
const port = Number(process.env.PORT ?? 5173);
const host = String(process.env.QASE_HOST ?? '127.0.0.1').trim() || '127.0.0.1';

// Chromium is a child process; without this it can outlive the server process.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, async () => {
		if (shuttingDown) {
			process.exit(1);
		}
		shuttingDown = true;
		let summaries = [];
		try {
			summaries = await services.runs.list();
		} catch {
			// Database readiness may be the reason for shutdown; pool cleanup and
			// process-local browser cleanup must still continue.
		}
		await Promise.all(summaries.map(summary => {
			services.agent.stop(summary.id);
			return services.agent.closeBrowser(summary.id);
		}));
		await services.lifecycle.close();
		process.exit(0);
	});
}

app.listen(port, host, () => {
	const config = services.configuration.getPublic();
	console.log('\n  Qase — autonomous QA agent');
	console.log(`  http://${host}:${port}`);
	console.log(`  run store: ${runStoreMode}`);
	console.log(`  ${config.provider} · ${config.model}${config.baseUrl ? ` · ${config.baseUrl}` : ''}`);
	if (demoEnabled) {
		console.log(`  practice target: http://${host}:${port}/demo  (demo@qase.dev / demo1234)`);
	}
	console.log('');
	if (config.problem) {
		console.log(`  ! ${config.problem} Set it in the dashboard under Settings, or in .env.\n`);
	}
});
