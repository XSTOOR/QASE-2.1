import test from 'node:test';
import assert from 'node:assert/strict';
import { browserExecutionEngine, focusedBrowserConfiguration, qaBrowserStatus, renderQaBrowserStatus } from './qaBrowserStatus.js';
import { hybridLaunchOptions } from './hybridQaView.js';

const chrome = { envId: 'desktop-chrome', browser: 'Chrome', browserVersion: '151', browserCode: 'chrome', platform: 'macos', device: 'Desktop', os: 'macOS', osVersion: '26', availability: 'AVAILABLE', executionEngine: 'chromium', executionType: 'browser_emulation' };
const config = { hybridQa: { available: true } };
const input = () => ({ fetchState: 'ready', mode: 'hybrid', config, configurations: [chrome], envIds: [chrome.envId] });

test('compact engine metadata validates the selected browser and gives an honest visible summary', () => {
  const model = qaBrowserStatus(input());
  assert.equal(model.state, 'ready'); assert.equal(model.title, 'Chrome 151');
  assert.match(model.detail, /Desktop.*macOS 26/); assert.match(model.detail, /not a physical device/);
  assert.equal(model.action, 'change');
  assert.deepEqual(hybridLaunchOptions(input()), { qaExecutionMode: 'hybrid', environmentId: chrome.envId, engine: 'chromium' });
});

test('engine resolution accepts explicit host metadata only, never browser name inference', () => {
  assert.equal(browserExecutionEngine({ browserCode: 'chrome' }), null);
  assert.equal(browserExecutionEngine({ executionEngine: 'invented' }), null);
  assert.equal(browserExecutionEngine({ browserSupport: { engine: 'firefox' } }), 'firefox');
  const withoutEngine = { ...chrome, executionEngine: undefined };
  const model = qaBrowserStatus({ ...input(), configurations: [withoutEngine] });
  assert.equal(model.state, 'blocked'); assert.equal(model.action, 'reload');
  assert.match(model.title, /refresh/); assert.match(model.detail, /listed as available/);
  assert.throws(() => hybridLaunchOptions({ ...input(), configurations: [withoutEngine] }), /Refresh browser details/);
  assert.match(qaBrowserStatus({ ...input(), configurations: [withoutEngine], envIds: [] }).title, /details need a refresh/);
});

test('focus chooses a genuinely available compatible browser, preserving legacy selection behavior', () => {
  const unknown = { ...chrome, envId: 'old', executionEngine: undefined };
  const firefox = { ...chrome, envId: 'firefox', browserCode: 'firefox', executionEngine: 'firefox' };
  assert.equal(focusedBrowserConfiguration([unknown, firefox], true).envId, 'firefox');
  assert.equal(focusedBrowserConfiguration([unknown, firefox], false).envId, 'old');
  assert.equal(focusedBrowserConfiguration([{ ...chrome, availability: 'UNAVAILABLE' }], true), null);
});

test('loading, failed fetch, missing selection and multi-browser hybrid expose direct recovery actions', () => {
  assert.equal(qaBrowserStatus({ ...input(), fetchState: 'loading' }).state, 'loading');
  assert.equal(qaBrowserStatus({ ...input(), fetchState: 'loading' }).action, null);
  assert.equal(qaBrowserStatus({ ...input(), fetchState: 'error' }).action, 'reload');
  assert.equal(qaBrowserStatus({ ...input(), envIds: [] }).action, 'recommended');
  assert.equal(qaBrowserStatus({ ...input(), envIds: ['a', 'b'] }).action, 'recommended');
  assert.equal(qaBrowserStatus({ ...input(), configurations: [], envIds: [] }).action, 'reload');
  assert.equal(qaBrowserStatus({ ...input(), config: {} }).action, 'config');
});

test('unavailable or removed selections remain blocked; legacy multi-browser coverage stays available', () => {
  const unavailable = { ...chrome, availability: 'UNAVAILABLE', availabilityReason: 'Provider disconnected.' };
  const blocked = qaBrowserStatus({ ...input(), configurations: [unavailable] });
  assert.match(blocked.detail, /Provider disconnected/); assert.equal(blocked.state, 'blocked');
  assert.equal(qaBrowserStatus({ ...input(), envIds: ['removed'] }).state, 'blocked');
  const multiple = qaBrowserStatus({ ...input(), mode: 'legacy', envIds: [chrome.envId, 'other'], configurations: [chrome, { ...chrome, envId: 'other' }] });
  assert.equal(multiple.state, 'ready'); assert.match(multiple.title, /2 browser/);
});

test('status renderer uses text content, visible state and explicit action metadata', () => {
  const nodes = new Map(); const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, { dataset: {} }); return nodes.get(id); } };
  renderQaBrowserStatus({ state: 'blocked', title: '<img src=x>', detail: 'No automatic fallback', action: 'reload', actionLabel: 'Refresh browser details' }, document);
  assert.equal(nodes.get('qa-browser-status-title').textContent, '<img src=x>');
  assert.equal(nodes.get('qa-browser-status').dataset.state, 'blocked');
  assert.equal(nodes.get('qa-browser-status-action').dataset.action, 'reload');
  assert.equal(nodes.get('qa-browser-status-action').hidden, false);
  renderQaBrowserStatus({ state: 'loading', title: 'Loading', detail: '', action: null }, document);
  assert.equal(nodes.get('qa-browser-status-action').hidden, true);
});
