import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Keep capture deterministic: the HTML exposes a timeline, independent of wall time.
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'assets/readme');
const frames = path.join(root, '.build/reports/readme-demo/frames');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
await mkdir(frames, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('../assets/readme/demo.html', import.meta.url).href);
  await page.evaluate(() => document.fonts.ready);
  for (let frame = 0; frame < 360; frame++) {
    await page.evaluate(time => window.renderFrame(time), frame / 20);
    await page.locator('#scene').screenshot({ path: path.join(frames, `${String(frame).padStart(4, '0')}.png`) });
    if (frame % 60 === 0) console.log(`Rendered ${frame}/360 frames`);
  }
  await page.evaluate(() => window.renderFrame(18));
  await page.locator('#scene').screenshot({ path: path.join(output, 'poster.png') });
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
}
const run = args => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
run(['-framerate', '20', '-i', path.join(frames, '%04d.png'), '-frames:v', '360', '-c:v', 'libx264', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(output, 'demo.mp4')]);
run(['-i', path.join(output, 'demo.mp4'), '-filter_complex', 'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3', '-loop', '0', path.join(output, 'demo.gif')]);
console.log('Created assets/readme/{demo.mp4,demo.gif,poster.png}');
