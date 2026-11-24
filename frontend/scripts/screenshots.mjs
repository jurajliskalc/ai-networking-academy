// Regenerates the images in docs/screenshots/ from the production build, so they cannot show stale counts,
// labels or behaviour. Usage: npm run build && npm run screenshots
//   (no flag)  page screenshots for the README and cropped details for the five-minute tour (PNG)
//   --tour     frames for the animations: the flagship incident solved step by step, the ECMP modes, the
//              ring all-reduce and the driver-stack switch, written to test-results/tour-frames/<name>/;
//              `npm run tour-gif` runs this and assembles docs/screenshots/<name>.gif
// Like `npm run e2e` it drives the installed Google Chrome (CHROME_PATH overrides the binary).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(FRONTEND, '..', 'docs', 'screenshots');
const FRAMES = path.join(FRONTEND, 'test-results', 'tour-frames');
const port = Number(execFileSync(process.execPath, ['-e', "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"]).toString());
const base = `http://127.0.0.1:${port}/`;
const compiled = (rel) => JSON.parse(fs.readFileSync(path.join(FRONTEND, 'dist', 'content', rel), 'utf8'));

/** Type one command into the simulated shell and wait until its output has been printed. */
async function run(page, cmd) {
  const input = page.getByRole('textbox', { name: 'Terminal input' });
  const log = page.getByRole('log');
  const before = await log.textContent();
  await input.fill(cmd);
  await input.press('Enter');
  await page.waitForFunction((t) => document.querySelector('[role="log"]')?.textContent !== t, before);
}

/** A page with no stored progress, in the dark NOC scheme. */
async function openPage(browser, url, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(base + url);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

const widget = (page) => page.locator('section[aria-label^="Interactive:"]').first();

/**
 * Screenshot the part of the page from the top of `top` down to the bottom of `until` (default: all of
 * `top`). The sticky app header is hidden so that it cannot cover the element.
 */
async function crop(page, file, top, until = top, pad = 0) {
  await page.addStyleTag({ content: 'header.sticky{visibility:hidden!important}' });
  await top.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 8));
  await page.waitForTimeout(350);
  const a = await top.boundingBox();
  const b = await until.boundingBox();
  await page.screenshot({ path: file, clip: { x: a.x, y: a.y, width: a.width, height: Math.min(b.y + b.height + pad, a.y + a.height) - a.y } });
}

// ---------- page screenshots (README) ----------
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

// ---------- cropped details (five-minute tour) ----------
const QUIZ = 'quiz-pfc-priority-flow-control';
const QUIZ_QUESTION = 4; // the incast scenario: sequence errors and no PFC frames anywhere
const DETAILS = [
  {
    file: 'tour-ladder.png', url: '#/visualize/bandwidth-ladder',
    shoot: (p, f) => crop(p, f, widget(p), p.getByText('GPUDirect RDMA to the NIC crosses', { exact: false }), 28),
  },
  {
    file: 'tour-rail.png', url: '#/visualize/rail-path-explorer',
    shoot: (p, f) => crop(p, f, widget(p), p.getByText('leaves node A on NIC 5'), 24),
  },
  {
    // One quiz question after "Check answer": every option carries its explanation.
    file: 'tour-quiz.png', url: `#/quiz/${QUIZ}`,
    shoot: async (p, f) => {
      const quiz = compiled(`quizzes/${QUIZ}.json`);
      for (const [k, q] of quiz.questions.entries()) {
        for (const o of q.options.filter((x) => x.correct)) await p.getByText(o.text, { exact: true }).click();
        await p.getByRole('button', { name: 'Check answer', exact: true }).click();
        if (k === QUIZ_QUESTION) break;
        await p.getByRole('button', { name: 'Next', exact: true }).click();
      }
      const card = p.getByText(`Question ${QUIZ_QUESTION + 1} / ${quiz.questions.length}`).locator('xpath=ancestor::div[contains(@class,"rounded")][1]');
      await crop(p, f, card, p.getByText('Correct', { exact: true }), 22);
    },
  },
  {
    file: 'tour-verified-note.png', url: '#/lesson/pfc-priority-flow-control',
    shoot: (p, f) => crop(p, f, p.getByRole('note', { name: 'Verified on real hardware' }).filter({ hasText: 'silently cleared PFC' }).first()),
  },
];

// ---------- animation frames ----------
const SWEEP = 'all_reduce_perf -b 8 -e 8G -f 2 -g 1';
const TOUR_LAB = 'sim-03-pfc-priority-mismatch';
// The flagship incident, solved with the commands of docs/PORTFOLIO_TOUR.md. `clear` only tidies the frame.
const INCIDENT = [
  { caption: 'The ticket: jobs run at a third of normal speed, yet ib_write_bw shows line rate on every rail' },
  { caption: '1 · Reproduce it: the all-reduce peaks near 130 GB/s of bus bandwidth (healthy: about 372)', cmds: [SWEEP] },
  { caption: '2 · The leaf on rail 5 pauses priority 3 toward node03 412,377 times, and still drops', cmds: ['clear', 'ssh leaf06', 'nv show interface swp3 counters'] },
  { caption: '3 · node03 has pause counters for priority 4 only, and the transport is retransmitting', cmds: ['clear', 'ssh node03', 'ethtool -S enp170s0np0 | grep pause', 'rdma statistic show link mlx5_5/1'] },
  { caption: '4 · Root cause: the NIC enables PFC on priority 4, the fabric uses priority 3', cmds: ['clear', 'mlnx_qos -i enp170s0np0'] },
  { caption: '5 · Fix the PFC vector and run the collective again: back to 372 GB/s', cmds: ['mlnx_qos -i enp170s0np0 --pfc 0,0,0,1,0,0,0,0', 'clear', 'exit', SWEEP] },
  { caption: '6 · Commit the diagnosis and grade: the lab checks the state of the fabric', grade: true },
];

const frameDir = (name) => {
  const dir = path.join(FRAMES, name);
  fs.mkdirSync(dir, { recursive: true });
  return (i) => path.join(dir, `${String(i).padStart(2, '0')}.png`);
};

async function incidentFrames(browser) {
  const frame = frameDir('incident-tour');
  const lab = compiled('index.json').labs.find((l) => l.id === TOUR_LAB);
  const page = await openPage(browser, `#/labs/${TOUR_LAB}`, { width: 1280, height: 760 });
  await page.getByRole('textbox', { name: 'Terminal input' }).waitFor();
  // Frames are shown at about 1000 px in the README. Hiding the navigation sidebar gives the terminal the
  // width an nccl-tests row needs without shrinking the text; nothing else about the page is changed.
  await page.addStyleTag({ content: String.raw`aside[aria-label="Sidebar"]{display:none!important}.lg\:ml-64{margin-left:0!important}` });
  for (const [i, step] of INCIDENT.entries()) {
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
    await page.screenshot({ path: frame(i) });
  }
  await page.context().close();
}

/** Four elephant flows on four spines, routed three ways. */
async function ecmpFrames(browser) {
  const frame = frameDir('tour-ecmp');
  const page = await openPage(browser, '#/visualize/ecmp-collision', { width: 1280, height: 1100 });
  for (const [i, mode] of ['Static ECMP', 'Adaptive routing', 'Packet spraying'].entries()) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await crop(page, frame(i), widget(page), page.getByText('of leaf A uplink capacity'), 26);
  }
  await page.context().close();
}

/** A ring all-reduce over four GPUs: the initial state and its six steps. */
async function allreduceFrames(browser) {
  const frame = frameDir('tour-allreduce');
  const page = await openPage(browser, '#/visualize/allreduce-sim', { width: 1280, height: 1100 });
  const ring = widget(page).locator('svg').first();
  for (let i = 0; i <= 6; i++) {
    if (i) await page.getByRole('button', { name: 'Step', exact: true }).click();
    await crop(page, frame(i), widget(page), ring, 18);
  }
  await page.context().close();
}

/** The same three commands on the same adapter with the distribution's stack and with NVIDIA DOCA-OFED. */
async function stackFrames(browser) {
  const frame = frameDir('tour-stack');
  const page = await openPage(browser, '#/lesson/rdma-on-linux', { width: 1280, height: 1000 });
  const group = page.locator('.stack-group').filter({ hasText: 'node_type ca protocol roce' }).first();
  for (const [i, stack] of ['Distro inbox', 'NVIDIA DOCA-OFED'].entries()) {
    await group.getByRole('group', { name: 'Driver stack' }).getByRole('button', { name: stack }).click();
    await crop(page, frame(i), group);
  }
  await page.context().close();
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
  if (only.includes('--tour')) {
    fs.rmSync(FRAMES, { recursive: true, force: true });
    for (const frames of [incidentFrames, ecmpFrames, allreduceFrames, stackFrames]) await frames(browser);
    console.log(`frames in test-results/tour-frames/: ${fs.readdirSync(FRAMES).join(', ')} (assemble with: npm run tour-gif)`);
  } else {
    const wanted = (s) => !only.length || only.includes(s.file);
    for (const shot of SHOTS.filter(wanted)) {
      // A fresh context per shot: no progress, lab state or imported report carries over.
      const page = await openPage(browser, shot.url, { width: 1440, height: 1000 });
      await shot.ready(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, shot.file) });
      await page.context().close();
      console.log(`docs/screenshots/${shot.file}`);
    }
    for (const shot of DETAILS.filter(wanted)) {
      const page = await openPage(browser, shot.url, { width: 1280, height: 1100 });
      await shot.shoot(page, path.join(OUT, shot.file));
      await page.context().close();
      console.log(`docs/screenshots/${shot.file}`);
    }
  }
} finally {
  await browser?.close();
  server.kill();
}
