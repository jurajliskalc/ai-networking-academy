// docs/PORTFOLIO_TOUR.md walks a reader through the flagship incident (sim-03) with a list of commands and
// the output lines that matter. This test replays that list against the simulator, so the page cannot
// promise evidence the lab does not show, or a fix that does not solve it.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src/sim/fabric';
import { exec } from '../src/sim/shell';
import { labState, runChecks } from '../src/sim/lab';
import type { SimLab } from '../src/types';

const root = path.resolve(__dirname, '../..');
const tour = fs.readFileSync(path.join(root, 'docs/PORTFOLIO_TOUR.md'), 'utf8').replace(/\r\n/g, '\n');

/** The fenced block that follows an HTML comment starting with `<!-- <marker>`. */
function block(marker: string): { arg: string; lines: string[] } {
  const m = tour.match(new RegExp(`<!-- ${marker}:([^\\n]*?)-->\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``));
  if (!m) throw new Error(`docs/PORTFOLIO_TOUR.md: no "${marker}" block`);
  return { arg: m[1].trim(), lines: m[2].split('\n') };
}

const squash = (s: string) => s.trim().replace(/\s+/g, ' ');
const peakBusbw = (out: string) => Math.max(0, ...out.split('\n').filter((l) => /^\s+\d+\s+\d+\s+float/.test(l)).map((l) => Number(l.trim().split(/\s+/)[7])));

describe('portfolio tour: the flagship incident walkthrough', () => {
  const commands = block('tour-commands');
  const labId = commands.arg.split(/\s/)[0];
  const lab = yaml.load(fs.readFileSync(path.join(root, 'content/labs/sim', `${labId}.yaml`), 'utf8')) as SimLab & { start?: string };

  // Replay the documented commands exactly as a reader would type them, following ssh and exit.
  const state = labState(lab.faults);
  let host = lab.start ?? 'node01';
  const outputs: { host: string; cmd: string; out: string }[] = [];
  const failedBefore = runChecks(state, lab.checks).filter((r) => !r.pass).length;
  for (const cmd of commands.lines.filter((l) => l.trim())) {
    const r = exec({ state, host }, cmd);
    outputs.push({ host, cmd, out: r.out });
    if (r.host) host = r.host;
  }
  const printed = new Set(outputs.flatMap((o) => o.out.split('\n')).map(squash));

  it('links to the lab it replays', () => {
    expect(tour).toContain(`#/labs/${labId}`);
    expect(lab.id).toBe(labId);
  });

  it('runs every documented command without a shell error', () => {
    expect(outputs.length).toBeGreaterThan(5);
    for (const o of outputs) expect(o.out, o.cmd).not.toMatch(/command not found|No such file|usage:|Error:|Invalid/);
  });

  it('quotes only output lines the simulator really prints for those commands', () => {
    const quoted = block('tour-evidence').lines.filter((l) => l.trim() && !l.startsWith('#'));
    expect(quoted.length).toBeGreaterThan(4);
    for (const line of quoted) expect(printed.has(squash(line)), `not printed by the simulator: ${line}`).toBe(true);
  });

  it('shows the symptom first and full speed after the fix', () => {
    const runs = outputs.filter((o) => o.cmd.startsWith('all_reduce_perf'));
    expect(runs).toHaveLength(2);
    expect(peakBusbw(runs[0].out)).toBeLessThan(140);
    expect(peakBusbw(runs[1].out)).toBeGreaterThan(360);
  });

  it('ends with the lab solved: broken before the walkthrough, every check passing after it', () => {
    expect(failedBefore).toBeGreaterThan(0);
    expect(runChecks(state, lab.checks).filter((r) => !r.pass).map((r) => r.check.description)).toEqual([]);
    expect(CHECKS.allreduce_min_busbw(state, { value: 360 })).toBe(true);
  });

  it('includes the lab\'s documented fix', () => {
    for (const line of (lab as SimLab & { fix: string[] }).fix) expect(commands.lines).toContain(line.slice(line.indexOf(':') + 1).trim());
  });
});
