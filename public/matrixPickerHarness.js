// Minimal DOM for exercising picker interactions without a browser or network.
import { renderMatrixPicker } from './matrixPicker.js';
import { normalizeSingleSelection } from './singleRunSelection.js';
import { createSelectionState, computeExplicitSelection } from './qaConfigMatrix.js';

export function pickerHarness() {
	const document = { activeElement: null, createElement: tag => new Node(tag) };
	class Node {
		constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.value = ''; this.textContent = ''; this.listeners = {}; this.classList = { add() {} }; }
		append(...children) { for (const child of children) { if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(n => n !== child); child.parentElement = this; this.children.push(child); } }
		replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
		setAttribute(key, value) { this.attributes[key] = value; }
		focus() { document.activeElement = this; }
		dispatchEvent(event) { this.listeners[event.type]?.(); }
		querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]).filter(n => n.dataset.pickerFocus); }
	}
	const row = (id, device, browserCode, extra = {}) => ({ envId: id, device, browserCode, browser: browserCode, manufacturer: 'Microsoft', platform: 'windows', deviceType: 'desktop', availability: 'AVAILABLE', browserVersion: '151', ...extra });
	const index = [row('old', 'Desktop', 'chrome', { browserVersion: '100' }), row('desktop', 'Desktop', 'chrome'), row('ff', 'Desktop', 'firefox'), row('phone', 'Pixel 9', 'chrome', { platform: 'android', manufacturer: 'Google', deviceType: 'mobile' }), row('blocked', 'Phone', 'safari', { availability: 'UNAVAILABLE', availabilityReason: 'Browser not installed' })];
	const hosts = Object.fromEntries(['root', 'browsers', 'devices', 'summary', 'search'].map(key => [key, new Node('div')]));
	hosts.root.append(hosts.browsers, hosts.devices, hosts.summary); const searchBar = new Node('div'); searchBar.append(hosts.search); hosts.root.append(searchBar);
	let selection = normalizeSingleSelection(index, createSelectionState()); let applications = 0;
	const view = { limit: 8 };
	const render = () => renderMatrixPicker({ document, hosts, index, families: [], selection, search: hosts.search.value, view, render, apply: next => { applications++; selection = next; render(); }, brandIcon: () => new Node('svg') });
	hosts.search.listeners.input = render;
	const nodes = () => hosts.root.querySelectorAll();
	const get = key => nodes().find(node => node.dataset.pickerFocus === key);
	const text = node => [node.textContent, ...node.children.map(text)].join(' ');
	render();
	return { document, hosts, index, view, render, get, nodes, text, ids: () => computeExplicitSelection(index, selection), applications: () => applications,
		click(key) { const node = get(key); if (!node || node.disabled) throw new Error(`Unavailable control: ${key}`); node.onclick(); },
		filter(key, value) { const node = get(key); node.value = value; node.onchange(); }, search(value) { hosts.search.value = value; render(); } };
}
