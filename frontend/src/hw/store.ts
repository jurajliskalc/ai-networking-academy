// Real-hardware state in the browser: the lab profile, the last imported inventory report and the newest
// check result per lab. Separate from learner progress (aina.progress.v1) because it describes a lab, not a
// learner, and it can hold host names and IPs; nothing leaves the browser.
import { useCallback, useSyncExternalStore } from 'react';
import { regrade, type CheckRecord, type LabTasks } from './checks';
import type { Profile } from './profile';
import type { Report } from './report';

export const HW_KEY = 'aina.hw.v1';

function regradeAll(checks: Record<string, CheckRecord>): Record<string, CheckRecord> {
  const out: Record<string, CheckRecord> = {};
  for (const [lab, r] of Object.entries(checks)) {
    try { if (r && Array.isArray(r.results) && r.counts) out[lab] = regrade(r); } catch { /* drop a damaged record */ }
  }
  return out;
}

export interface HwState {
  profile: Profile | null; // raw saved values; sanitize with the variable list before use
  report: Report | null;
  reportSource: string | null; // "file name", "agent http://127.0.0.1:8765" or "demo"
  checks: Record<string, CheckRecord>;
  /** Per-task progress per lab (full runs overlaid by `aina-hw check LAB --task N` runs). */
  tasks: Record<string, LabTasks>;
  agentUrl: string;
  /** When the agent last answered (ISO time): lab pages offer the live counters after that. */
  agentAt: string | null;
}

const empty = (): HwState => ({ profile: null, report: null, reportSource: null, checks: {}, tasks: {}, agentUrl: 'http://127.0.0.1:8765', agentAt: null });

function load(): HwState {
  try {
    const raw = JSON.parse(localStorage.getItem(HW_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return empty();
    return {
      ...empty(),
      profile: raw.profile && typeof raw.profile === 'object' ? raw.profile : null,
      report: raw.report && typeof raw.report === 'object' && Array.isArray(raw.report.hosts) ? raw.report : null,
      reportSource: typeof raw.reportSource === 'string' ? raw.reportSource : null,
      // Re-graded on load: records saved by an older version have no verdict.
      checks: raw.checks && typeof raw.checks === 'object' ? regradeAll(raw.checks as Record<string, CheckRecord>) : {},
      tasks: raw.tasks && typeof raw.tasks === 'object' && !Array.isArray(raw.tasks) ? raw.tasks : {},
      agentUrl: typeof raw.agentUrl === 'string' ? raw.agentUrl : empty().agentUrl,
      agentAt: typeof raw.agentAt === 'string' ? raw.agentAt : null,
    };
  } catch {
    return empty();
  }
}

let state: HwState = typeof localStorage === 'undefined' ? empty() : load();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === HW_KEY) {
      state = load();
      emit();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

export function setHw(fn: (s: HwState) => HwState) {
  const next = fn(state);
  if (next === state) return; // no change: no write, no re-render
  state = next;
  try {
    localStorage.setItem(HW_KEY, JSON.stringify(state));
  } catch {
    /* quota or private mode: state lives for this session only */
  }
  emit();
}

export function useHw(): [HwState, (fn: (s: HwState) => HwState) => void] {
  const s = useSyncExternalStore(subscribe, () => state, () => state);
  return [s, useCallback(setHw, [])];
}
