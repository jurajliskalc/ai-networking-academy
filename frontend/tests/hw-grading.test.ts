// Check grading in the browser: the same verdicts as aina_hw.grade_check (labs/hw-toolkit/tests/test_grading.py),
// so a lab cannot be marked verified without its required measurements.
import { describe, expect, it } from 'vitest';
import { fromPastedText, parseCheckJson, parsePerf, parseRequirements, regrade, verdictDetail, type CheckRecord } from '../src/hw/checks';

const paste = (text: string) => fromPastedText('hw-x', text);

describe('check grading', () => {
  it('a skipped required measurement is inconclusive, not verified', () => {
    const r = paste('REQUIRE: 2 transport NCCL used RDMA\nPASS: tools installed\nSKIP: no RDMA transport\n');
    expect([r.verdict, r.passed, r.functional, r.complete, r.missing]).toEqual(['INCONCLUSIVE', false, true, false, ['transport']]);
    expect(verdictDetail(r)).toBe('Nothing failed, but the run is incomplete (not measured: NCCL used RDMA).');
  });

  it('a measurement below its target is not verified', () => {
    const r = paste('REQUIRE: 5 bw bandwidth\nPASS: tools\nWARN: 35% of line rate\nMET: bw\nPERF: bw low\n');
    expect([r.verdict, r.passed, r.complete, r.performance]).toEqual(['BELOW_TARGET', false, true, 'low']);
    expect(verdictDetail(r)).toContain('below the performance target: bw');
  });

  it('declared tasks that never ran make the run inconclusive', () => {
    const r = paste('TASKS: 1 2 3\nTASK: 1 Setup\nPASS: setup ok\n');
    expect([r.verdict, r.passed, r.notrun]).toEqual(['INCONCLUSIVE', false, [2, 3]]);
    expect(verdictDetail(r)).toContain('tasks 2, 3 not run');
  });

  it('passes only when everything required was measured and on target', () => {
    const r = paste('TASKS: 5\nREQUIRE: 5 bw bandwidth\nPASS: tools\nTASK: 5 Bandwidth\nPASS: 96%\nMET: bw\nPERF: bw ok\n');
    expect([r.verdict, r.passed, r.performance, r.met]).toEqual(['PASSED', true, 'ok', ['bw']]);
  });

  it('failures win, and output without requirements grades as before', () => {
    expect(paste('REQUIRE: 1 x y\nPASS: a\nFAIL: b\nMET: x\n').verdict).toBe('FAILED');
    expect([paste('PASS: a\nWARN: b\n').verdict, paste('PASS: a\nWARN: b\n').passed]).toEqual(['PASSED', true]);
  });

  it('parses requirement and performance lines like the toolkit', () => {
    expect(parseRequirements('REQUIRE: 1 a x\nREQUIRE: 2 a y\nREQUIRE: x b\n')).toEqual([{ task: 1, key: 'a', text: 'x' }]);
    expect(parsePerf('PERF: bw ok\nPERF: bw low\nPERF: bw ok\nPERF: lat ok\n')).toEqual({ bw: 'low', lat: 'ok' });
  });

  it('recomputes the verdict from a toolkit file instead of trusting it', () => {
    const file = {
      schema: 'aina.hw.check/1', lab: 'hw-02', host: 'a', finished: '2026-10-23T20:00:00Z', exit_code: 0, passed: true, verdict: 'PASSED',
      results: [{ status: 'PASS', text: 'tools' }], counts: { PASS: 1, FAIL: 0, WARN: 0, SKIP: 0 }, tasks: [], only_task: null,
      required: [{ task: 5, key: 'bw', text: 'bandwidth' }], met: [], perf: {},
    };
    const r = parseCheckJson(file);
    expect([r.verdict, r.passed, r.missing]).toEqual(['INCONCLUSIVE', false, ['bw']]);
    // A single-task run owes only its task's and the prerequisites' requirements, and never verifies the lab.
    const one = parseCheckJson({ ...file, only_task: 3, required: [...file.required, { task: 0, key: 'tools', text: 't' }], met: ['tools'] });
    expect([one.verdict, one.passed, one.missing]).toEqual(['PASSED', false, []]);
  });

  it('re-grades a record stored by an older version', () => {
    const old = { schema: 'aina.hw.check/1', lab: 'hw-01', host: 'a', finished: 'f', passed: true, counts: { PASS: 2, FAIL: 0, WARN: 0, SKIP: 0 },
      results: [{ status: 'PASS', text: 'a' }, { status: 'PASS', text: 'b' }], source: 'toolkit' } as unknown as CheckRecord;
    const r = regrade(old);
    expect([r.verdict, r.passed, r.required, r.tasks, r.only_task]).toEqual(['PASSED', true, [], [], null]);
  });
});
