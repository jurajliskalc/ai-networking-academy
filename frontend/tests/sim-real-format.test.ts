// The simulator's host-tool output must keep the layout real tools print. Each expectation below was checked
// against output captured on ConnectX-5 hosts (Ubuntu 26.04, inbox and DOCA-OFED 3.4 stacks); see
// labs/hw-toolkit/tests/captures/. Values differ from the lab (the simulator models 400G ConnectX-7 nodes).
import { describe, expect, it } from 'vitest';
import { createFabric, type FabricState } from '../src/sim/fabric';
import { exec } from '../src/sim/shell';
import { labState } from '../src/sim/lab';

const sh = (s: FabricState, host: string, cmd: string) => exec({ state: s, host }, cmd).out;

describe('host tools match the real output format', () => {
  it('ibv_devices and ibv_devinfo', () => {
    const s = createFabric();
    expect(sh(s, 'node01', 'ibv_devices')).toMatch(/^ {4}device {10}\t {3}node GUID\n {4}------ {10}\t-{16}\n {4}mlx5_0 {10}\t[0-9a-f]{16}\n/);
    expect(sh(s, 'node01', 'ibv_devinfo -d mlx5_9')).toBe("IB device 'mlx5_9' wasn't found\n");
    expect(sh(s, 'node01', 'ibv_devinfo -d mlx5_0')).toMatch(/^hca_id:\tmlx5_0\n\ttransport:\t\t\tInfiniBand \(0\)\n[\s\S]*\t\t\tactive_mtu:\t\t4096 \(5\)\n[\s\S]*\t\t\tlink_layer:\t\tEthernet\n/);
  });

  it('ib_write_bw header, address lines and result row', () => {
    const s = createFabric();
    const out = sh(s, 'node01', 'ib_write_bw -d mlx5_0 -x 3 -q 2 -F --report_gbits node02');
    const lines = out.split('\n').map((l) => l.split(':')[0].trim());
    const order = ['Dual-port', 'Number of qps', 'Connection type', 'PCIe relax order', 'ibv_wr* API', 'TX depth', 'CQ Moderation',
      'CQE Poll Batch', 'Mtu', 'Link type', 'GID index', 'Max inline data', 'rdma_cm QPs', 'Data ex. method', 'NUMA node'];
    expect(lines.filter((l) => order.includes(l))).toEqual(order);
    expect(out).toMatch(/ PCIe relax order: ON\t\tLock-free {6}: OFF\n/);
    expect(out.match(/^ local address: LID 0000 QPN 0x[0-9a-f]{4} PSN 0x[0-9a-f]+ RKey 0x[0-9a-f]+ VAddr 0x[0-9a-f]{14}\n GID: (\d+:){15}\d+\n/gm)).toHaveLength(2);
    expect(out.match(/^ remote address: /gm)).toHaveLength(2);
    expect(out).toMatch(/\n 65536 {6}5000 {13}\d+\.\d\d {12,13}\d+\.\d\d {1,2}\t\t {5}\d\.\d{6}\n-{87}\n$/);
    const d = sh(s, 'node01', 'ib_write_bw -d mlx5_0 -x 3 -D 5 -F --report_gbits node02');
    expect(d).toMatch(/^ WARNING: BW peak won't be measured in this run\.\n/);
    expect(d).toMatch(/\n 65536 {6}\d+ +0\.00 {15}\d+\.\d\d/);
    expect(sh(s, 'node01', 'ib_write_bw -d mlx5_0 -x 3 --report_gbits nosuchhost')).toBe(
      "Couldn't connect to nosuchhost:18515\nUnable to open file descriptor for socket connection\n Unable to init the socket connection\n");
  });

  it('ping with DF larger than the local MTU', () => {
    const s = createFabric();
    const out = sh(s, 'node01', 'ping -M do -s 9000 -c 2 10.0.1.0');
    expect(out).toMatch(/\) 9000\(9028\) bytes of data\.\nping: sendmsg: Message too long\nping: sendmsg: Message too long\n\n--- /);
    expect(out).toMatch(/2 packets transmitted, 0 received, \+2 errors, 100% packet loss, time 1000ms\n\n$/);
  });

  it('mlnx_qos layout and errors', () => {
    const s = createFabric();
    const nd = s.hosts.node01.nics[0].netdev;
    const q = sh(s, 'node01', `mlnx_qos -i ${nd}`);
    expect(q).not.toMatch(/default priority/);
    expect(q).toMatch(/\nReceive buffer size \(bytes\): \d+,\d+,0,0,0,0,0,0,max_buffer_size=262016\nCable len: 7\nPFC configuration:\n\tpriority {4}0 {3}1 {3}2 {3}3 {3}4 {3}5 {3}6 {3}7\n\tenabled {5}(\d {3}){8}\n\tbuffer {6}(\d {3}){8}\ntc: 0 ratelimit: unlimited, tsa: vendor\n\t priority:  1\n/);
    expect(sh(s, 'node01', `mlnx_qos -i ${nd} --pfc 0,0,0,1`)).toBe('pfc list must have 8 items\n');
    expect(sh(s, 'node01', `mlnx_qos -i ${nd} --trust foo`)).toBe('Invalid trust state command. Refer to the help.\n');
  });

  it('InfiniBand tools (checked against ConnectX-5 ports in IB mode, with and without OpenSM)', () => {
    const s = labState([{ type: 'ib_fabric' }]);
    // ibstat <ca> <port>: flat block that starts with "CA: '<ca>'"
    expect(sh(s, 'node02', 'ibstat mlx5_3 1')).toMatch(/^CA: 'mlx5_3'\nPort 1:\nState: Active\nPhysical state: LinkUp\nRate: \d+\nBase lid: \d+\nLMC: 0\nSM lid: \d+\nCapability mask: 0x[0-9a-f]{8}\nPort GUID: 0x[0-9a-f]{16}\nLink layer: InfiniBand\n$/);
    // IB-mode rdma link has no netdev field
    expect(sh(s, 'node02', 'rdma link')).toMatch(/^link mlx5_0\/1 subnet_prefix fe80:0000:0000:0000 lid \d+ sm_lid \d+ lmc 0 state ACTIVE physical_state LINK_UP \n/);
    expect(sh(s, 'node02', 'rdma link')).not.toMatch(/netdev/);
    expect(sh(s, 'node01', 'perfquery')).toMatch(/^# Port counters: Lid \d+ port 1 \(CapMask: 0x5A00\)\nPortSelect:\.{22}1\n/);
    // Without an SM: LID 65535, and the MAD tools fail after ibwarn lines
    const n = labState([{ type: 'ib_fabric' }, { type: 'sm_down' }]);
    expect(sh(n, 'node02', 'ibstat mlx5_3 1')).toMatch(/\nState: Initializing\nPhysical state: LinkUp\n[\s\S]*\nBase lid: 65535\nLMC: 0\nSM lid: 0\n/);
    expect(sh(n, 'node02', 'sminfo')).toMatch(/\nsminfo: iberror: failed: query\n$/);
    expect(sh(n, 'node01', 'perfquery')).toMatch(/^ibwarn: [\s\S]*dport \(Lid 65535\)\nperfquery: iberror: failed: classportinfo query\n$/);
  });

  it('rdma statistic, ethtool -m and mlxlink', () => {
    const s = createFabric();
    expect(sh(s, 'node01', 'rdma statistic show link mlx5_0/1')).toMatch(/^link mlx5_0\/1 \n( {4}[a-z_]+ \d+ \n)+$/);
    const nd = s.hosts.node01.nics[0].netdev;
    expect(sh(s, 'node01', `ethtool -m ${nd}`)).toMatch(/\tModule temperature {24}: \d+\.\d\d degrees C \/ \d+\.\d\d degrees F\n/);
    const m = sh(s, 'node01', 'mlxlink -d mlx5_0 -c');
    for (const label of ['State', 'Physical state', 'Speed', 'FEC', 'Status Opcode', 'Group Opcode', 'Recommendation', 'Raw Physical BER'])
      expect(m).toMatch(new RegExp(`\\n${label.replace(/ /g, ' ')} {${35 - label.length}}: `));
    const c = m.slice(m.indexOf('Physical Counters'));
    const order = ['Time Since Last Clear', 'Effective Physical Errors', 'Raw Physical Errors Per Lane', 'Effective Physical BER', 'Raw Physical BER', 'Link Down Counter', 'Link Error Recovery Counter'];
    expect(order.map((l) => c.indexOf(l))).toEqual([...order.map((l) => c.indexOf(l))].sort((x, y) => x - y));
  });
});
