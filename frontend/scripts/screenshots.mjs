// Regenerates the README screenshots in docs/screenshots/ from the production build, so they cannot show
// stale counts or labels. Usage: npm run build && npm run screenshots
// Like `npm run e2e` it drives the installed Google Chrome (CHROME_PATH overrides the binary).
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(FRONTEND, '..', 'docs', 'screenshots');
const port = Number(execFileSync(process.execPath, ['-e', "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"]).toString());
const base = `http://127.0.0.1:${port}/`;

/** Type one command into the simulated shell and wait until its output has been printed. */
async function run(page, cmd) {
  const input = page.getByRole('textbox', { name: 'Terminal input' });
  const log = page.getByRole('log');
  const before = await log.textContent();
  await input.fill(cmd);
  await input.press('Enter');
  await page.waitForFunction((t) => document.querySelector('[role="log"]')?.textContent !== t, before);
}

const SHOTS = [
  { file: 'dashboard.png', url: '#/', ready: (p) => p.getByRole('heading', { level: 1 }).waitFor() },
  {
    // The flagship incident with the evidence on screen: healthy and broken pause counters, then the leaf.
    file: 'incident.png', url: '#/labs/sim-03-pfc-priority-mismatch',
    ready: async (p) => {
      await p.getByRole('textbox', { name: 'Terminal input' }).waitFor();
      // Load the fabric once (counters only move under load), then compare a healthy rail with the broken one.
      for (const cmd of ['all_reduce_perf -b 8 -e 8G -f 2 -g 1', 'clear', 'ssh node03', 'ethtool -S enp154s0np0 | grep pause', 'ethtool -S enp170s0np0 | grep pause', 'ssh leaf06', 'nv show interface swp3 counters']) await run(p, cmd);
      await p.evaluate(() => window.scrollTo(0, 0));
    },
  },
  {
    file: 'hw-health.png', url: '#/hw/connect',
    ready: async (p) => {
      await p.getByRole('button', { name: 'Load demo report' }).click();
      await p.getByText('MTU differs between hosts').waitFor();
      // Put the review heading just under the sticky header.
      await p.getByRole('heading', { name: 'Fabric health review' }).evaluate((h) => window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 110));
    },
  },
  { file: 'verified.png', url: '#/verified', ready: (p) => p.getByRole('heading', { level: 1, name: 'Verified on hardware' }).waitFor() },
  { file: 'pfc-ecn.png', url: '#/visualize/pfc-ecn-sim', ready: (p) => p.getByRole('heading', { level: 1 }).waitFor() },
];

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: FRONTEND, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(base)).ok) break; } catch { /* not listening yet */ }
    if (i > 100) throw new Error('vite preview did not start: run "npm run build" first');
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const only = process.argv.slice(2);
  for (const shot of SHOTS.filter((s) => !only.length || only.includes(s.file))) {
    // A fresh context per shot: no progress, lab state or imported report carries over.
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(base + shot.url);
    await shot.ready(page);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, shot.file) });
    await context.close();
    console.log(`docs/screenshots/${shot.file}`);
  }
} finally {
  await browser?.close();
  server.kill();
}
