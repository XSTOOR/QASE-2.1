import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const comparator = fileURLToPath(new URL('../scripts/compare-menu-motion-frames.py', import.meta.url));
export async function compareMenuFrames(frames, signal) {
  const unavailable = reason => ({ outcome: 'inconclusive', reason });
  if (frames.length !== 3 || frames.some(frame => !frame.region || frame.bytes.length > 2_000_000)) {
    return unavailable('Three bounded screenshots of the visible menu region are required.');
  }
  if (frames.some(frame => JSON.stringify(frame.region) !== JSON.stringify(frames[0].region))) {
    return unavailable('The menu region moved between screenshots.');
  }
  const payload = JSON.stringify({ region: frames[0].region, frames: frames.map(f => f.bytes.toString('base64')) });
  try {
    const stdout = await new Promise((resolve,reject) => {
      const child = execFile(process.env.QASE_OPENCV_PYTHON || 'python', ['-I', comparator, '--live'],
        { signal, windowsHide: true, timeout: 8000, maxBuffer: 32_768 }, (error, output) => error ? reject(error) : resolve(output));
      child.stdin.on('error', reject);
      child.stdin.end(payload);
    });
    return JSON.parse(stdout);
  } catch {
    signal?.throwIfAborted();
    return unavailable('OpenCV could not compare the menu frames on this host.');
  }
}
