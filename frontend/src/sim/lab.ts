import { applyFaults, CHECKS, createFabric, type FabricState, type Fault } from './fabric';
import type { SimCheck } from '../types';

export function labState(faults: Fault[] | Record<string, unknown>[]): FabricState {
  return applyFaults(createFabric(), faults as Fault[]);
}

export function runChecks(s: FabricState, checks: SimCheck[]): { check: SimCheck; pass: boolean }[] {
  return checks.map((c) => {
    const fn = CHECKS[c.check];
    if (!fn) throw new Error(`unknown check ${c.check}`);
    return { check: c, pass: fn(s, c.args ?? {}) };
  });
}

/** "host: command" lines, as used by a lab's `fix` list. */
export function parseFixLine(line: string): { host: string; cmd: string } {
  const i = line.indexOf(':');
  return { host: line.slice(0, i).trim(), cmd: line.slice(i + 1).trim() };
}
