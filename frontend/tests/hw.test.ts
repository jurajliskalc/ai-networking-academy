import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import type { HandsOnLab, HwVariable } from '../src/types';
import { defaults, derive, fill, parseEnv, pfcVector, placeholders, sanitizeProfile, switchConfig, toEnv, validateProfile } from '../src/hw/profile';
import { dataPort, detectedProfile, parseReport, readiness, review, type Report } from '../src/hw/report';
import { fromPastedText, mergeChecks, parseCheckJson, parseCheckLines } from '../src/hw/checks';
import { emptyProgress, recordHwCheck } from '../src/progress';
import demo from '../src/hw/demo-report.json';

const ROOT = path.resolve(__dirname, '..', '..');
const hw = yaml.load(fs.readFileSync(path.join(ROOT, 'content/hardware/hardware.yaml'), 'utf8')) as { variables: HwVariable[] };
const VARS = hw.variables;
const P = defaults(VARS);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const lab = (over: Partial<HandsOnLab>): HandsOnLab => ({
  id: 'x', kind: 'handson', title: 'x', level: 2, estimated_minutes: 1, environment: 'hardware', lessons: [], files: null, verified: false,
  summary: '', tier: 1, fabric: 'roce', requires: ['two-rdma-hosts'], changes_config: false, toc: [], ...over,
});

describe('lab profile', () => {
  it('derives the traffic class from the DSCP', () => {
    expect(P.TCLASS).toBe('106');
    expect(derive({ ...P, ROCE_DSCP: '24' }).TCLASS).toBe('98');
  });

  it('sanitizes stored values', () => {
    const p = sanitizeProfile({ FABRIC: 'token-ring', MTU: ' 4200 ', TCLASS: '1', EVIL: 'x' }, VARS);
    expect(p.FABRIC).toBe('roce');
    expect(p.MTU).toBe('4200');
    expect(p.TCLASS).toBe('106');
    expect(p.EVIL).toBeUndefined();
  });

  it('validates what would break generated files', () => {
    expect(validateProfile(P)).toEqual({});
    const e = validateProfile({ ...P, A_IP: '300.1.1.1', B_IP: P.A_IP, CNP_DSCP: P.ROCE_DSCP, ROCE_PRIO: '9' });
    expect(Object.keys(e).sort()).toEqual(['A_IP', 'CNP_DSCP', 'ROCE_PRIO']);
    expect(validateProfile({ ...P, B_IP: P.A_IP }).B_IP).toMatch(/own data IP/);
  });

  it('fills SHELL_CASE placeholders only', () => {
    expect(fill('ib_write_bw -d {{A_RDMA_DEV}} -x {{GID_INDEX}} {{NOPE}} {{.State.Pid}}', P)).toBe('ib_write_bw -d mlx5_0 -x 3 {{NOPE}} {{.State.Pid}}');
    expect(placeholders('{{A_IP}} {{B_IP}} {{A_IP}}')).toEqual(['A_IP', 'B_IP']);
    expect(fill('ssh {{SSH_USER}}@{{HOST_B}}', P)).toBe('ssh node-b');
    expect(fill('ssh {{SSH_USER}}@{{HOST_B}}', { ...P, SSH_USER: 'lab' })).toBe('ssh lab@node-b');
  });

  it('round-trips lab.env, quoting what bash needs quoted', () => {
    const p: Record<string, string> = { ...P, LAB_NAME: "Bob's lab #2", SSH_USER: '' };
    const env = toEnv(p, VARS);
    expect(env).toContain(`LAB_NAME='Bob'\\''s lab #2'`);
    expect(env).toContain('AINA_DIR=~/ai-networking-academy');
    const back = parseEnv(env);
    for (const v of VARS) expect(back[v.name], v.name).toBe(p[v.name]);
  });

  it('builds the PFC vector and switch snippets', () => {
    expect(pfcVector('3')).toBe('0,0,0,1,0,0,0,0');
    const cum = switchConfig({ ...P, SWITCH_OS: 'cumulus', HOST_COUNT: '3' });
    expect(cum).toContain('nv set interface swp3 link mtu 9216');
    expect(cum).toContain('nv set qos roce mode lossless');
    expect(switchConfig({ ...P, SWITCH_OS: 'cumulus', ROCE_DSCP: '24' })).toContain('NOTE: your profile uses DSCP 24');
    expect(switchConfig(P)).toContain('back to back');
  });
});

describe('toolkit consistency', () => {
  const plain = (v: string) => v.replace(/^~\//, '$HOME/');
  it('lib.sh defaults match hardware.yaml', () => {
    const lib = fs.readFileSync(path.join(ROOT, 'labs/hw-toolkit/lib.sh'), 'utf8');
    const found = Object.fromEntries([...lib.matchAll(/"\$\{([A-Z_]+):=([^}]*)\}"/g)].map((m) => [m[1], m[2]]));
    for (const v of VARS) if (found[v.name] !== undefined) expect(plain(found[v.name]), v.name).toBe(plain(v.default ?? ''));
    expect(Object.keys(found).length).toBeGreaterThan(25);
  });
  it('lab.env.example matches hardware.yaml', () => {
    const env = parseEnv(fs.readFileSync(path.join(ROOT, 'labs/hw-toolkit/lab.env.example'), 'utf8'));
    for (const v of VARS) expect(env[v.name], v.name).toBe(v.default ?? derive(defaults(VARS))[v.name]);
  });
});

describe('inventory report and health review', () => {
  const report = parseReport(demo);

  it('parses reports and single-host facts, rejects others', () => {
    expect(report.hosts.map((h) => h.role)).toEqual(['A', 'B']);
    expect(parseReport(report.hosts[0]).hosts).toHaveLength(1);
    expect(() => parseReport({ schema: 'nope' })).toThrow(/Unknown schema/);
    expect(() => parseReport({ schema: 'aina.hw.report/1', hosts: [{}] })).toThrow(/malformed/);
  });

  it('picks the profile device as the data port', () => {
    expect(dataPort(report.hosts[1], P)?.dev.name).toBe('mlx5_0');
  });

  it('flags the demo problems', () => {
    const f = review(report, P, new Date('2026-10-23'));
    const ids = f.map((x) => `${x.severity}:${x.id}`);
    for (const want of ['error:mtu-mismatch', 'error:pfc-mismatch', 'warn:pcie-down', 'warn:active-mtu', 'warn:trust', 'warn:fw-mismatch', 'warn:memlock', 'warn:phy-errors', 'info:seq-errors', 'info:governor'])
      expect(ids, want).toContain(want);
    expect(f[0].severity).toBe('error');
    expect(ids).not.toContain('warn:gid-index');
  });

  it('is quiet about a healthy pair', () => {
    const r = clone(report) as Report;
    const a = r.hosts[0];
    const b = clone(a);
    b.role = 'B';
    b.host.hostname = 'node-b';
    b.netdevs[0].ipv4 = ['192.168.50.12/24'];
    r.hosts = [a, b];
    const f = review(r, P, new Date('2026-10-23'));
    expect(f.filter((x) => x.severity !== 'info')).toEqual([]);
  });

  it('detects InfiniBand ports without a subnet manager', () => {
    const r = clone(report) as Report;
    for (const h of r.hosts) for (const d of h.rdma) for (const port of d.ports) Object.assign(port, { link_layer: 'InfiniBand', state: 'INIT', lid: 0, sm_lid: 0, gids: [] });
    const f = review(r, { ...P, FABRIC: 'ib' });
    expect(f.find((x) => x.id === 'port-state')?.detail).toMatch(/subnet manager/);
    expect(f.find((x) => x.id === 'mtu-profile')).toBeUndefined(); // IPoIB MTU is not the Ethernet profile MTU
  });

  it('treats a past link-down as information, not an error', () => {
    const r = clone(report) as Report;
    for (const h of r.hosts) for (const d of h.rdma) for (const port of d.ports) port.counters = { link_downed: 2 };
    const f = review(r, P, new Date('2026-10-23'));
    expect(f.find((x) => x.id === 'link-downed')?.severity).toBe('info');
    expect(f.find((x) => x.id === 'port-errors')).toBeUndefined();
  });

  it('decides which labs can run', () => {
    expect(readiness(lab({}), P, report).status).toBe('ready');
    expect(readiness(lab({}), P, null).status).toBe('unknown');
    expect(readiness(lab({ requires: ['gpu'], fabric: 'any', tier: 3 }), P, report).status).toBe('blocked');
    expect(readiness(lab({ requires: ['lossless-switch', 'root'] }), P, report).status).toBe('blocked');
    expect(readiness(lab({ requires: ['lossless-switch', 'root'] }), { ...P, SWITCH_OS: 'sonic' }, report).status).toBe('ready');
    expect(readiness(lab({ fabric: 'ib' }), P, report).items.at(-1)).toEqual({ id: 'fabric', state: 'missing', note: 'needs InfiniBand' });
  });

  it('fills the profile from detected values', () => {
    const { next, changes } = detectedProfile(report, { ...P, B_RDMA_DEV: 'mlx5_9', GID_INDEX: '1' });
    expect(next.B_RDMA_DEV).toBe('mlx5_0');
    expect(next.GID_INDEX).toBe('3');
    expect(changes).toContain('GID_INDEX: 1 → 3');
    expect(detectedProfile(report, P).changes).toEqual([]);
  });
});

describe('check results', () => {
  const rec = {
    schema: 'aina.hw.check/1', lab: 'hw-02-roce-first-traffic', host: 'node-a', finished: '2026-10-22T10:00:00+00:00', exit_code: 0, passed: true,
    results: [{ status: 'PASS', text: 'ok' }, { status: 'WARN', text: 'meh' }],
  };

  it('parses lines and records', () => {
    expect(parseCheckLines('PASS: a\nINFO: b\n FAIL: c\nnoise').map((x) => x.status)).toEqual(['PASS', 'FAIL']);
    const r = parseCheckJson(rec);
    expect(r.passed).toBe(true);
    expect(r.counts).toEqual({ PASS: 1, FAIL: 0, WARN: 1, SKIP: 0 });
  });

  it('does not trust a hand-edited passed flag', () => {
    expect(parseCheckJson({ ...rec, results: [...rec.results, { status: 'FAIL', text: 'x' }] }).passed).toBe(false);
    expect(parseCheckJson({ ...rec, exit_code: 1 }).passed).toBe(false);
    expect(() => parseCheckJson({ schema: 'aina.hw.report/1' })).toThrow();
  });

  it('accepts pasted output and keeps the newest record per lab', () => {
    expect(() => fromPastedText('x', 'hello')).toThrow(/No PASS/);
    const p = fromPastedText('x', 'PASS: a\nPASS: b', new Date('2026-10-21'));
    expect(p.passed && p.source === 'pasted').toBe(true);
    const merged = mergeChecks({ x: p }, [{ ...p, finished: '2026-10-20T00:00:00Z', passed: false }]);
    expect(merged.x.passed).toBe(true);
  });

  it('marks labs verified and never un-solves them', () => {
    const r = parseCheckJson(rec);
    let prog = recordHwCheck(emptyProgress(), r.lab, r);
    expect(prog.labs[r.lab].solved).toBe(true);
    expect(prog.labs[r.lab].evidence?.host).toBe('node-a');
    expect(recordHwCheck(prog, r.lab, r)).toBe(prog); // same result imported twice
    prog = recordHwCheck(prog, r.lab, { ...r, finished: '2026-10-23T00:00:00Z', passed: false });
    expect(prog.labs[r.lab].solved).toBe(true);
    expect(prog.labs[r.lab].evidence?.finished).toBe(rec.finished);
  });
});
