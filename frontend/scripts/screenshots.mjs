// Regenerates the README screenshots in docs/screenshots/ from the production build, so they cannot show
// stale counts or labels. Usage: npm run build && npm run screenshots
// With --tour it instead solves the flagship incident step by step and writes one captioned frame per step
// to test-results/tour-frames/; `npm run tour-gif` then assembles docs/screenshots/incident-tour.gif.
// Like `npm run e2e` it drives the installed Google Chrome (CHROME_PATH overrides the binary).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
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

// The flagship incident, solved with the commands of docs/PORTFOLIO_TOUR.md. `clear` only tidies the frame.
const TOUR_LAB = 'sim-03-pfc-priority-mismatch';
const SWEEP = 'all_reduce_perf -b 8 -e 8G -f 2 -g 1';
const TOUR = [
  { caption: 'The ticket: jobs run at a third of normal speed, yet ib_write_bw shows line rate on every rail' },
  { caption: '1 · Reproduce it: the all-reduce peaks near 130 GB/s of bus bandwidth (healthy: about 372)', cmds: [SWEEP] },
  { caption: '2 · The leaf on rail 5 pauses priority 3 toward node03 412,377 times, and still drops', cmds: ['clear', 'ssh leaf06', 'nv show interface swp3 counters'] },
  { caption: '3 · node03 has pause counters for priority 4 only, and the transport is retransmitting', cmds: ['clear', 'ssh node03', 'ethtool -S enp170s0np0 | grep pause', 'rdma statistic show link mlx5_5/1'] },
  { caption: '4 · Root cause: the NIC enables PFC on priority 4, the fabric uses priority 3', cmds: ['clear', 'mlnx_qos -i enp170s0np0'] },
  { caption: '5 · Fix the PFC vector and run the collective again: back to 372 GB/s', cmds: ['mlnx_qos -i enp170s0np0 --pfc 0,0,0,1,0,0,0,0', 'clear', 'exit', SWEEP] },
  { caption: '6 · Commit the diagnosis and grade: the lab checks the state of the fabric', grade: true },
];

async function tourFrames(browser) {
  const dir = path.join(FRONTEND, 'test-results', 'tour-frames');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const lab = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'dist', 'content', 'index.json'), 'utf8')).labs.find((l) => l.id === TOUR_LAB);
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${base}#/labs/${TOUR_LAB}`);
  await page.getByRole('textbox', { name: 'Terminal input' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Frames are shown at about 1000 px in the README. Hiding the navigation sidebar gives the terminal the
  // width an nccl-tests row needs without shrinking the text; nothing else about the page is changed.
  await page.addStyleTag({ content: String.raw`aside[aria-label="Sidebar"]{display:none!important}.lg\:ml-64{margin-left:0!important}` });
  for (const [i, step] of TOUR.entries()) {
    for (const cmd of step.cmds ?? []) await run(page, cmd);
    if (step.grade) {
      await page.getByText(lab.diagnosis.options.find((o) => o.correct).text, { exact: true }).click();
      await page.getByRole('button', { name: 'Commit diagnosis', exact: true }).click();
      await page.getByRole('button', { name: 'Grade the fabric', exact: true }).click();
      const done = page.getByText('Incident resolved. Root cause identified and the fabric verifies clean.');
      await done.waitFor();
      await done.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    } else await page.evaluate((y) => window.scrollTo(0, y), step.cmds ? 160 : 0); // 160 px brings the whole terminal into view
    // The caption is a bar across the top of the frame (over the app header), in the app's accent colours.
    await page.evaluate((text) => {
      const bar = document.getElementById('tour-caption') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'tour-caption' }));
      bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;min-height:58px;box-sizing:border-box;padding:15px 24px;font:600 19px/1.3 Inter,system-ui,sans-serif;text-align:center;background:var(--accent);color:var(--on-accent)';
      bar.textContent = text;
    }, step.caption);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(dir, `${String(i).padStart(2, '0')}.png`) });
  }
  await context.close();
  console.log(`${TOUR.length} frames in test-results/tour-frames/ (assemble with: npm run tour-gif)`);
}

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
  if (only.includes('--tour')) await tourFrames(browser);
  else for (const shot of SHOTS.filter((s) => !only.length || only.includes(s.file))) {
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
