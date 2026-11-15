// Public sample only: no API requests, credentials, session writes, or live runs.
const $ = id => document.getElementById(id);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const demo = $('journey-demo');
const pause = $('motion-pause');
const replay = $('motion-replay');
const captions = ['Following the sample journey', 'Checking the pricing page', 'Comparing expected and observed content', 'Evidence linked to the finding'];
let elapsed = 0;
let last = null;
let frame = null;
let visible = false;
let paused = false;
let complete = reduced.matches;
const duration = 4200;

function renderStage(stage) {
  demo.dataset.stage = String(stage);
  $('demo-caption').textContent = captions[stage];
}
function stopFrame() {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  last = null;
}
function tick(now) {
  frame = null;
  if (last !== null) elapsed += now - last;
  last = now;
  renderStage(elapsed < 1000 ? 0 : elapsed < 2000 ? 1 : elapsed < 3100 ? 2 : 3);
  if (elapsed >= duration) {
    complete = true;
    last = null;
    pause.hidden = true;
    return;
  }
  frame = requestAnimationFrame(tick);
}
function syncPlayback() {
  stopFrame();
  pause.textContent = paused ? 'Resume' : 'Pause';
  pause.hidden = complete || reduced.matches;
  replay.hidden = reduced.matches;
  if (reduced.matches) {
    complete = true;
    renderStage(3);
    return;
  }
  if (!paused && !complete && visible && !document.hidden) frame = requestAnimationFrame(tick);
}
document.querySelector('.motion-controls').hidden = false;
pause.addEventListener('click', () => { paused = !paused; syncPlayback(); });
replay.addEventListener('click', () => {
  elapsed = 0;
  complete = false;
  paused = false;
  renderStage(0);
  syncPlayback();
});
const observer = new IntersectionObserver(entries => {
  visible = entries[0].isIntersecting;
  syncPlayback();
}, { threshold: .2 });
observer.observe(demo);
document.addEventListener('visibilitychange', syncPlayback);
reduced.addEventListener('change', syncPlayback);
window.addEventListener('pagehide', stopFrame);
window.addEventListener('pageshow', syncPlayback);
syncPlayback();

let healthy = false;
const dialog = $('evidence-dialog');
const opener = $('open-evidence');
function updateEvidence() {
  $('evidence-heading').textContent = healthy ? 'Pricing' : '[ Heading missing ]';
  $('evidence-heading').classList.toggle('healthy', healthy);
  $('evidence-observed').textContent = healthy ? 'A matching heading is visible' : 'No matching visible heading';
  $('evidence-result').textContent = healthy ? 'Passed assertion' : 'Failed assertion';
}
for (const button of document.querySelectorAll('[data-scenario]')) {
  button.addEventListener('click', () => {
    healthy = button.dataset.scenario === 'healthy';
    for (const item of document.querySelectorAll('[data-scenario]')) item.setAttribute('aria-pressed', String(item === button));
    $('sample-step-icon').textContent = healthy ? '✓' : '!';
    $('sample-step-icon').classList.toggle('failed', !healthy);
    $('sample-step-status').textContent = healthy ? 'Content check passed' : 'Content check failed';
    $('sample-outcome').textContent = healthy ? 'Passed assertion' : 'Failed assertion';
    $('sample-outcome').classList.toggle('failed', !healthy);
    $('sample-title').textContent = healthy ? 'The page opened. The expected heading is visible.' : 'The page opened. The expected heading didn’t.';
    $('sample-observed').textContent = healthy ? 'The URL matches and the “Pricing” heading is visible.' : 'The URL matches, but no visible “Pricing” heading was found.';
    $('sample-detail-note').textContent = healthy ? 'Both the destination and heading satisfy the sample specification.' : 'A successful page load cannot satisfy this assertion.';
    $('sample-explanation').textContent = healthy ? 'This sample assertion passed. It does not establish coverage of other features or browsers.' : 'Next step: restore the heading, then rerun this journey to verify the change.';
    $('sample-announcement').textContent = healthy ? 'Healthy sample selected. Pricing assertion passed.' : 'Seeded defect selected. Pricing assertion failed.';
    updateEvidence();
  });
}
opener.addEventListener('click', () => { updateEvidence(); dialog.showModal(); $('close-evidence').focus(); });
$('close-evidence').addEventListener('click', () => dialog.close());
$('close-evidence-bottom').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => opener.focus());
