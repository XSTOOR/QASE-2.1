// Visual effects only. This module does not read account data, call APIs,
// delay authentication, intercept form input, or unlock the application.
const gate = document.getElementById('auth-gate');
const canvas = document.getElementById('entry-motion');
const toggle = document.getElementById('entry-motion-toggle');
const context = canvas?.getContext('2d');

if (gate && canvas && context && toggle) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  let width = 0;
  let height = 0;
  let frame;
  let previousTime = 0;
  let elapsed = 0;
  let paused = false;
  let visible = !document.hidden;
  let pointerX = 0;
  let pointerY = 0;
  let smoothX = 0;
  let smoothY = 0;
  let seed = 7419;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const stars = Array.from({ length: 100 }, () => ({
    x: random() * 2 - 1, y: random() * 2 - 1,
    z: random(), size: random() * 1.3 + .3, phase: random() * Math.PI * 2
  }));

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (!gate.hidden) draw();
  }

  function project(x, y, z, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const rotatedX = x * c + z * s;
    const rotatedZ = z * c - x * s;
    const tilt = .92 + smoothY * .05;
    const rotatedY = y * Math.cos(tilt) - rotatedZ * Math.sin(tilt);
    const depth = y * Math.sin(tilt) + rotatedZ * Math.cos(tilt);
    const perspective = 950 / (950 + depth);
    return {
      x: width * (width < 781 ? .5 : .3) + rotatedX * perspective + smoothX * 13,
      y: height * .53 + rotatedY * perspective + smoothY * 9,
      z: depth
    };
  }

  function drawCore(time) {
    const radius = Math.min(width * .27, height * .4, 410);
    const angle = time * .000075 + .3;
    const meridians = width < 781 ? 14 : 24;
    const detail = width < 781 ? 28 : 44;
    const corePoint = (u, v) => {
      const ring = radius * .78 + Math.cos(v) * radius * .18;
      return project(ring * Math.cos(u), Math.sin(v) * radius * .18, ring * Math.sin(u), angle);
    };
    context.lineWidth = .7;
    for (let i = 0; i < meridians; i++) {
      const u = i / meridians * Math.PI * 2;
      const center = corePoint(u, 0);
      context.strokeStyle = `rgba(105,218,147,${.08 + (center.z + radius) / (radius * 2) * .13})`;
      context.beginPath();
      for (let j = 0; j <= detail; j++) {
        const point = corePoint(u, j / detail * Math.PI * 2);
        if (j === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      }
      context.stroke();
    }
    for (let j = 0; j < 10; j++) {
      const v = j / 10 * Math.PI * 2;
      context.strokeStyle = j % 3 === 0 ? '#81e5ab3d' : '#61c68c20';
      context.beginPath();
      for (let i = 0; i <= 100; i++) {
        const point = corePoint(i / 100 * Math.PI * 2, v);
        if (i === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      }
      context.stroke();
    }
    // Traveling vertices give the wireframe a visible sense of depth and rotation.
    for (let i = 0; i < 5; i++) {
      const point = corePoint(i * Math.PI * .4 + time * .0001, i * 1.3);
      const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, 19);
      glow.addColorStop(0, '#b4f7be80');
      glow.addColorStop(.15, '#81efb128');
      glow.addColorStop(1, '#81efb100');
      context.fillStyle = glow;
      context.fillRect(point.x - 19, point.y - 19, 38, 38);
      context.fillStyle = '#b7f5c4a0';
      context.fillRect(point.x - 1, point.y - 1, 2, 2);
    }
  }

  function draw() {
    context.clearRect(0, 0, width, height);
    const centerX = width * .35 + smoothX * 15;
    const horizon = height * .62;
    const floor = context.createLinearGradient(0, horizon, 0, height);
    floor.addColorStop(0, '#47846200');
    floor.addColorStop(1, '#47846225');
    context.strokeStyle = floor;
    context.lineWidth = .6;
    context.beginPath();
    for (let i = -14; i <= 20; i++) {
      context.moveTo(centerX + i * 10, horizon);
      context.lineTo(centerX + i * 160, height);
    }
    for (let i = 0; i < 16; i++) {
      const progress = (i / 16 + (elapsed * .000012) % (1 / 16)) ** 2;
      const y = horizon + progress * (height - horizon);
      context.moveTo(0, y);
      context.lineTo(width, y);
    }
    context.stroke();
    for (const star of stars.slice(0, width < 781 ? 40 : stars.length)) {
      const depth = .3 + ((star.z + elapsed * .000008) % 1) * .7;
      const x = width * .5 + star.x * width * .65 * depth + smoothX * depth * 18;
      const y = height * .5 + star.y * height * .7 * depth + smoothY * depth * 14;
      const alpha = .13 + depth * .3;
      context.fillStyle = `rgba(156,231,177,${alpha})`;
      const size = star.size * depth;
      context.fillRect(x, y, size, size);
      if (star.size > 1.45) {
        context.fillStyle = `rgba(156,231,177,${alpha * .35})`;
        context.fillRect(x - 3, y, 7, .5);
        context.fillRect(x, y - 3, .5, 7);
      }
    }
    drawCore(elapsed);
  }

  function animate(time) {
    frame = undefined;
    if (gate.hidden || !visible || paused || reduced.matches) return;
    if (!previousTime) previousTime = time;
    const delta = time - previousTime;
    if (delta >= 1000 / 30) {
      elapsed += Math.min(delta, 70);
      previousTime = time;
      smoothX += (pointerX - smoothX) * .08;
      smoothY += (pointerY - smoothY) * .08;
      gate.style.setProperty('--pointer-x', smoothX.toFixed(3));
      gate.style.setProperty('--pointer-y', smoothY.toFixed(3));
      draw();
    }
    frame = requestAnimationFrame(animate);
  }

  function sync() {
    cancelAnimationFrame(frame);
    frame = undefined;
    previousTime = 0;
    gate.dataset.motion = reduced.matches ? 'reduced' : paused ? 'paused' : 'running';
    toggle.disabled = reduced.matches;
    toggle.setAttribute('aria-pressed', String(paused || reduced.matches));
    toggle.textContent = reduced.matches ? 'Motion reduced' : paused ? '▷ Resume motion' : 'Ⅱ Pause motion';
    if (reduced.matches) {
      pointerX = pointerY = smoothX = smoothY = 0;
      gate.style.setProperty('--pointer-x', '0');
      gate.style.setProperty('--pointer-y', '0');
    }
    if (gate.hidden || !visible) return;
    draw();
    if (!paused && !reduced.matches) frame = requestAnimationFrame(animate);
  }

  toggle.addEventListener('click', () => { paused = !paused; sync(); });
  gate.addEventListener('pointermove', event => {
    if (!finePointer.matches || reduced.matches || paused || gate.hidden) return;
    pointerX = (event.clientX / width - .5) * 2;
    pointerY = (event.clientY / height - .5) * 2;
  }, { passive: true });
  gate.addEventListener('pointerleave', () => { pointerX = pointerY = 0; });
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; sync(); });
  window.addEventListener('pagehide', () => { visible = false; sync(); });
  window.addEventListener('pageshow', () => { visible = !document.hidden; sync(); });
  reduced.addEventListener('change', sync);
  new MutationObserver(sync).observe(gate, { attributes: true, attributeFilter: ['hidden'] });
  resize();
  sync();
}
