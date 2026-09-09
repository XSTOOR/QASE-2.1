import { createServer } from 'node:http';

/** Controlled app for real browser and model qualification; never served by Qase production. */
export async function startMediaFixture({ port = 0 } = {}) {
	const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Team practice studio</title>
<style>body{font:18px system-ui;margin:30px auto;padding:0 20px;max-width:850px;line-height:1.5}button,input,a{font:inherit;margin:8px;padding:8px}section{padding:16px;border:1px solid #bbb;margin:20px 0}button:focus,a:focus{outline:3px solid blue}</style>
<body><header><h1>Team practice studio</h1><p>Practice a microphone check before your team meeting. This is an isolated qualification fixture with no real attendees.</p><nav><a href="#practice">Practice</a><a href="#pricing">Pricing</a><a href="/privacy">Privacy</a></nav></header>
<main><section id="practice"><h2>Microphone practice</h2><p>Audio stays in this tab. Start the microphone, check input, mute/unmute, then stop. No audio is uploaded.</p>
<button id="start">Start microphone</button><button id="mute" disabled>Mute microphone</button><button id="stop" disabled>Stop microphone</button>
<p id="status" role="status" aria-live="polite">Microphone off</p><p id="meter">Input level: 0</p><p id="recording">Recorded bytes: 0</p></section>
<section><h2>Meeting links</h2><a id="meeting" href="/meeting/test-room" target="_blank" rel="noopener">Open test meeting</a><a id="expired" href="/meeting/expired" target="_blank" rel="noopener">Open expired test meeting</a><p>Expected: the test-room opens a prejoin screen; the expired link clearly explains expiry. Stop at prejoin, without joining.</p></section>
<section id="pricing"><h2>Pricing</h2><p>Free browser practice for small remote teams. Pilot plan: $9 per team per month (display only; no checkout).</p></section>
<section><h2>Try validation</h2><form id="form"><label for="email">Work email</label><input id="email" type="email" required><button>Validate email</button><p id="form-status" role="status"></p></form></section></main>
<script>
let stream, recorder, context, frame, bytes = 0;
const statusNode = document.querySelector('#status');
const start = document.querySelector('#start'), mute = document.querySelector('#mute'), stop = document.querySelector('#stop');
start.onclick = async () => { try {
stream = await navigator.mediaDevices.getUserMedia({audio:true});
context = new AudioContext(); await context.resume(); const analyser = context.createAnalyser(); context.createMediaStreamSource(stream).connect(analyser);
const values = new Uint8Array(analyser.fftSize); const measure = () => {analyser.getByteTimeDomainData(values); const peak = Math.max(...values.map(v=>Math.abs(v-128))); document.querySelector('#meter').textContent = 'Input level: '+peak; frame=requestAnimationFrame(measure);}; measure();
recorder = new MediaRecorder(stream); bytes=0; recorder.ondataavailable = e => {bytes += e.data.size; document.querySelector('#recording').textContent='Recorded bytes: '+bytes;}; recorder.start(200);
statusNode.textContent='Microphone active'; start.disabled=true; mute.disabled=false; stop.disabled=false;
} catch(error){ statusNode.textContent='Microphone unavailable: '+error.name+'. Allow microphone permission and try again.'; } };
mute.onclick=()=>{const track=stream.getAudioTracks()[0];track.enabled=!track.enabled;mute.textContent=track.enabled?'Mute microphone':'Unmute microphone';statusNode.textContent=track.enabled?'Microphone active':'Microphone muted';};
stop.onclick=async()=>{if(recorder?.state==='recording')recorder.stop();stream?.getTracks().forEach(t=>t.stop());cancelAnimationFrame(frame);await context?.close();statusNode.textContent='Microphone off';start.disabled=false;mute.disabled=true;mute.textContent='Mute microphone';stop.disabled=true;};
document.querySelector('#form').onsubmit=e=>{e.preventDefault();document.querySelector('#form-status').textContent='Email format accepted locally. Nothing was sent.';};
</script></body></html>`;
	const server = createServer((req, res) => {
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		res.setHeader('Referrer-Policy', 'no-referrer');
		res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
		res.setHeader('Cache-Control', 'no-store');
		if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
		if (req.url === '/meeting/expired') { res.statusCode = 410; res.end('<h1>Meeting link expired</h1><p>Ask the organizer for a new link.</p>'); return; }
		if (req.url === '/meeting/test-room') { res.end('<html lang="en"><title>Test meeting prejoin</title><h1>Ready to join test-room</h1><p>Prejoin only. No participants are connected. Microphone is off.</p><button>Join meeting</button><a href="/">Back to studio</a></html>'); return; }
		if (req.url === '/privacy') { res.end('<html lang="en"><title>Privacy</title><h1>Privacy</h1><p>Microphone capture stays in browser memory until the tab is closed. No accounts, uploads, or analytics. Synthetic practice audio only during qualification.</p><a href="/">Back to studio</a></html>'); return; }
		res.end(html);
	});
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
	return { server, url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
