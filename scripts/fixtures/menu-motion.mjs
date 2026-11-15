// An explicit visual contract: the same closed panel opens with a CSS opacity
// transition. The seeded defect stops at 0.55; reduced motion removes it.
export function menuMotionFixture({ broken = false, ambiguous = false, network = false } = {}) {
  const button = '<button type="button" id="menu-toggle" aria-expanded="false" aria-controls="main-menu">Main menu</button>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Menu motion fixture</title><link rel="icon" href="data:,">
<style>
body { margin: 36px; color: #142640; background: #f3f7fc; font: 16px system-ui, sans-serif; }
header { max-width: 620px; }
button, nav { padding: 12px 20px; border-radius: 8px; border: 1px solid #284c75; }
button { color: white; background: #284c75; margin-bottom: 12px; }
nav { max-width: 320px; background: white; opacity: 0; pointer-events: none; transition: opacity 240ms linear; }
nav[aria-hidden="false"] { opacity: ${broken ? 0.55 : 1}; pointer-events: auto; }
nav a { display: block; margin: 5px; color: #254e83; }
@media (prefers-reduced-motion: reduce) { nav { transition: none; } }
</style></head>
<body><header><h1>Menu motion fixture</h1><p>Open the menu to reveal its navigation links.</p>
${button}${ambiguous ? button.replace('menu-toggle', 'second-toggle') : ''}
<nav id="main-menu" aria-label="Main navigation" aria-hidden="true"><a href="/help">Help</a><a href="/about">About</a></nav>
</header><main><a href="/help">Read the guide</a></main>
<script>
const control = document.querySelector('#menu-toggle');
const panel = document.querySelector('#main-menu');
control.addEventListener('click', () => {
  const opening = control.getAttribute('aria-expanded') === 'false';
  control.setAttribute('aria-expanded', String(opening));
  panel.setAttribute('aria-hidden', String(!opening));
  ${network ? "if (opening) fetch('/write', {method: 'POST'}).catch(() => {});" : ''}
});
</script></body></html>`;
}
