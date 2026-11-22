#!/usr/bin/env node
/**
 * Prints what the QA agent did in a run, for reviewing and improving it:
 * screens and panels it mapped, pop-ups it closed, the plan with outcomes,
 * and each AI journey step by step (tool → what it saw). Reads the local run
 * store (.qase/sessions.json). Never prints secrets: run state is redacted.
 *
 *   node scripts/qa-run-review.mjs            latest QA run
 *   node scripts/qa-run-review.mjs <run id>   a specific run
 */
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), '.qase', 'sessions.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
let sessions = Array.isArray(raw) ? raw : raw.sessions ?? raw;
if (!Array.isArray(sessions)) sessions = Object.values(sessions);
const qa = sessions.filter(item => item?.mode === 'qa' && item.hybrid?.architecture === 'adaptive').sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
const run = process.argv[2] ? qa.find(item => item.id.startsWith(process.argv[2])) : qa.at(-1);
if (!run) { console.error('No adaptive QA run found.'); process.exit(1); }
const state = run.hybrid;
const pathOf = url => { try { const u = new URL(url); return `${u.pathname}${u.search}`; } catch { return url; } };
const line = text => console.log(text);

line(`Run ${run.id} · ${run.targetUrl} · ${run.status} · ${Math.round((state.elapsedMs ?? 0) / 60000)} min`);
line(`Signed in: ${state.signedIn ? `yes (${state.graph?.auth?.verifiedBy ?? ''})` : `no — ${state.graph?.auth?.blockedReason ?? 'no sign-in'}`}; re-auth ${state.graph?.auth?.reauthentications ?? 0}`);
line(`Pop-ups closed: ${(state.overlaysDismissed ?? []).join(' | ') || 'none'}`);
line('\nSCREENS');
for (const [url, page] of Object.entries(state.graph?.pages ?? {})) line(`  ${pathOf(url).padEnd(48)} ${String(page.discoveredBy).padEnd(9)} ${page.auth ?? ''} ${page.status ?? ''} "${page.heading || page.title || ''}"${page.via ? ` ← click "${page.via.label}"` : ''}`);
line('\nPANELS / TABS / DIALOGS');
for (const view of state.graph?.views ?? []) line(`  "${view.label}" on ${pathOf(view.url)} → ${view.kind} "${view.heading}"`);
line(`\nPLAN (${state.plan?.scenarios?.length ?? 0} scenarios, ${state.plan?.revisions?.length ?? 0} revisions)`);
for (const item of state.plan?.scenarios ?? []) line(`  ${String(item.state).padEnd(14)} ${item.title.slice(0, 90)}${item.reason ? ` — ${item.reason.slice(0, 100)}` : ''}`);
for (const item of (state.plan?.scenarios ?? []).filter(scenario => scenario.unit === 'explore')) {
	line(`\nJOURNEY: ${item.goal ?? item.title}\n  state: ${item.state}${item.reason ? ` (${item.reason})` : ''}`);
	for (const step of item.trail ?? []) line(`  ${step}`);
	for (const text of item.evidence ?? []) line(`  » ${text}`);
}
line(`\nLIMITATIONS\n${(state.limitations ?? []).map(item => `  - ${item.message}`).join('\n') || '  none'}`);
line(`\nFINDINGS: ${(run.findings ?? []).length}${run.report ? ` · verdict ${run.report.verdict} · gate ${run.report.qaEngine?.completion?.status}` : ''}`);
