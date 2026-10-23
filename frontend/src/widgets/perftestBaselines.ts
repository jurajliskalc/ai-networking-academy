// Measured perftest results from one real pair of hosts, shown next to the PerftestExplorer model so learners can
// compare a model with reality. One pair, one setup, one day: reference points, not a benchmark of ConnectX-5.
// Every number is copied from the raw output of the runs named in `source` (captures and the hw-02 lab run of
// 2026-10-23, see docs/HARDWARE_VERIFICATION.md); BW values are perftest's "BW average" in Gb/s (--report_gbits).
import type { Model } from './PerftestExplorer';

export const CX5_SETUP = {
  title: 'Real ConnectX-5 measurement',
  hardware: '2x NVIDIA ConnectX-5 MCX556A-ECAT (PCIe Gen3 x16), back to back with a 1 m DAC, no switch',
  hosts: 'Dell R640, Ubuntu 26.04.1 VMs on ESXi with the adapters in PCI passthrough',
  link: '100 Gb/s Ethernet (RoCEv2, IPv4 GID index 3, MTU 9000 so path MTU 4096); InfiniBand runs on the second port at 4X EDR (100 Gb/s)',
  stack: 'NVIDIA DOCA-OFED 3.4.0, perftest 26.04.16, kernel 7.0.0-38-generic, firmware 16.29.1016 / 16.34.1002',
  date: '2026-10-23',
  linkGbps: 100,
} as const;

export interface BwPoint { size: number; bwGbps: number; mpps: number }
export interface LatPoint { size: number; tMinUs: number; tTypicalUs: number }

/** `ib_write_bw -d mlx5_0 -x 3 -a -F --report_gbits` (5000 iterations per size, one QP, not CPU-pinned). */
export const CX5_BW_SWEEP: BwPoint[] = [
  { size: 2, bwGbps: 0.077293, mpps: 4.830796 }, { size: 4, bwGbps: 0.21, mpps: 6.406565 }, { size: 8, bwGbps: 0.42, mpps: 6.492297 },
  { size: 16, bwGbps: 0.82, mpps: 6.432604 }, { size: 32, bwGbps: 1.65, mpps: 6.440736 }, { size: 64, bwGbps: 3.33, mpps: 6.507025 },
  { size: 128, bwGbps: 6.6, mpps: 6.446805 }, { size: 256, bwGbps: 13.16, mpps: 6.428173 }, { size: 512, bwGbps: 26.23, mpps: 6.403559 },
  { size: 1024, bwGbps: 49.1, mpps: 5.993852 }, { size: 2048, bwGbps: 78.62, mpps: 4.798423 }, { size: 4096, bwGbps: 93.75, mpps: 2.861133 },
  { size: 8192, bwGbps: 97.11, mpps: 1.481755 }, { size: 16384, bwGbps: 97.0, mpps: 0.740087 }, { size: 32768, bwGbps: 97.11, mpps: 0.370437 },
  { size: 65536, bwGbps: 97.13, mpps: 0.185268 }, { size: 131072, bwGbps: 97.05, mpps: 0.092557 }, { size: 262144, bwGbps: 91.11, mpps: 0.043445 },
  { size: 524288, bwGbps: 90.86, mpps: 0.021663 }, { size: 1048576, bwGbps: 90.84, mpps: 0.010829 }, { size: 2097152, bwGbps: 91.1, mpps: 0.00543 },
  { size: 4194304, bwGbps: 91.15, mpps: 0.002716 }, { size: 8388608, bwGbps: 91.22, mpps: 0.001359 },
];

/** `numactl --cpunodebind=N --membind=N ib_write_lat -d mlx5_0 -x 3 -a -F` (hw-02 lab run, 1000 iterations per size). */
export const CX5_LAT_SWEEP: LatPoint[] = [
  { size: 2, tMinUs: 0.87, tTypicalUs: 0.89 }, { size: 4, tMinUs: 0.87, tTypicalUs: 0.89 }, { size: 8, tMinUs: 0.87, tTypicalUs: 0.89 },
  { size: 16, tMinUs: 0.87, tTypicalUs: 0.89 }, { size: 32, tMinUs: 0.92, tTypicalUs: 0.94 }, { size: 64, tMinUs: 0.92, tTypicalUs: 0.94 },
  { size: 128, tMinUs: 0.97, tTypicalUs: 0.99 }, { size: 256, tMinUs: 1.35, tTypicalUs: 1.37 }, { size: 512, tMinUs: 1.45, tTypicalUs: 1.47 },
  { size: 1024, tMinUs: 1.58, tTypicalUs: 1.61 }, { size: 2048, tMinUs: 1.82, tTypicalUs: 1.94 }, { size: 4096, tMinUs: 2.3, tTypicalUs: 2.34 },
  { size: 8192, tMinUs: 2.95, tTypicalUs: 3.03 }, { size: 16384, tMinUs: 4.37, tTypicalUs: 4.57 }, { size: 32768, tMinUs: 6.47, tTypicalUs: 6.67 },
  { size: 65536, tMinUs: 9.16, tTypicalUs: 9.38 }, { size: 131072, tMinUs: 14.6, tTypicalUs: 15.14 }, { size: 262144, tMinUs: 26.7, tTypicalUs: 27.38 },
  { size: 524288, tMinUs: 49.06, tTypicalUs: 49.83 }, { size: 1048576, tMinUs: 95.22, tTypicalUs: 96.68 }, { size: 2097152, tMinUs: 185.49, tTypicalUs: 187.27 },
  { size: 4194304, tMinUs: 366.74, tTypicalUs: 369.97 }, { size: 8388608, tMinUs: 731.86, tTypicalUs: 735.94 },
];

export interface Run {
  id: string;
  group: 'qps' | 'bidir' | 'mtu' | 'transport';
  label: string;
  command: string;
  transport: 'roce4' | 'ib';
  size: number;
  mtu: number;
  qps: number;
  bidir: boolean;
  /** BW average, Gb/s (with -b: both directions together). */
  bwGbps?: number;
  /** ib_write_lat t_min / t_typical at 2 bytes, microseconds. */
  latMinUs?: number;
  latTypicalUs?: number;
  source: 'hw-02 lab run' | 'capture';
}

/** Single runs on the same pair. Runs in one group come from the same session unless `source` differs. */
export const CX5_RUNS: Run[] = [
  { id: 'q1', group: 'qps', label: '1 QP', command: 'ib_write_bw -d mlx5_0 -x 3 -F --report_gbits', transport: 'roce4', size: 65536, mtu: 4096, qps: 1, bidir: false, bwGbps: 95.43, source: 'hw-02 lab run' },
  { id: 'q4', group: 'qps', label: '4 QPs', command: 'ib_write_bw -d mlx5_0 -x 3 -q 4 -F --report_gbits', transport: 'roce4', size: 65536, mtu: 4096, qps: 4, bidir: false, bwGbps: 96.83, source: 'hw-02 lab run' },
  { id: 'bidir', group: 'bidir', label: 'Bidirectional (-b), both directions', command: 'ib_write_bw -d mlx5_0 -x 3 -b -F --report_gbits', transport: 'roce4', size: 65536, mtu: 4096, qps: 1, bidir: true, bwGbps: 180.78, source: 'hw-02 lab run' },
  { id: 'm1024-4k', group: 'mtu', label: 'Path MTU 1024, 4 KiB', command: 'ib_write_bw -d mlx5_0 -x 3 -m 1024 -s 4096 -F --report_gbits', transport: 'roce4', size: 4096, mtu: 1024, qps: 1, bidir: false, bwGbps: 83.14, source: 'hw-02 lab run' },
  { id: 'm4096-4k', group: 'mtu', label: 'Path MTU 4096, 4 KiB', command: 'ib_write_bw -d mlx5_0 -x 3 -m 4096 -s 4096 -F --report_gbits', transport: 'roce4', size: 4096, mtu: 4096, qps: 1, bidir: false, bwGbps: 77.13, source: 'hw-02 lab run' },
  { id: 'm1024-64k', group: 'mtu', label: 'Path MTU 1024, 64 KiB', command: 'ib_write_bw -d mlx5_0 -x 3 -m 1024 -F --report_gbits', transport: 'roce4', size: 65536, mtu: 1024, qps: 1, bidir: false, bwGbps: 89.81, source: 'capture' },
  { id: 'm4096-64k', group: 'mtu', label: 'Path MTU 4096, 64 KiB', command: 'ib_write_bw -d mlx5_0 -x 3 -F --report_gbits', transport: 'roce4', size: 65536, mtu: 4096, qps: 1, bidir: false, bwGbps: 95.73, source: 'capture' },
  { id: 'm1024-1m', group: 'mtu', label: 'Path MTU 1024, 1 MiB', command: 'ib_write_bw -d mlx5_0 -x 3 -m 1024 -s 1048576 -F --report_gbits', transport: 'roce4', size: 1048576, mtu: 1024, qps: 1, bidir: false, bwGbps: 89.67, source: 'hw-02 lab run' },
  { id: 'm4096-1m', group: 'mtu', label: 'Path MTU 4096, 1 MiB', command: 'ib_write_bw -d mlx5_0 -x 3 -m 4096 -s 1048576 -F --report_gbits', transport: 'roce4', size: 1048576, mtu: 4096, qps: 1, bidir: false, bwGbps: 92.89, source: 'hw-02 lab run' },
  { id: 'roce', group: 'transport', label: 'RoCEv2, 100GbE', command: 'ib_write_bw / ib_write_lat -d mlx5_0 -x 3 -F', transport: 'roce4', size: 65536, mtu: 4096, qps: 1, bidir: false, bwGbps: 95.73, latMinUs: 0.98, latTypicalUs: 1.0, source: 'capture' },
  { id: 'ib', group: 'transport', label: 'InfiniBand, 4X EDR', command: 'ib_write_bw / ib_write_lat -d mlx5_1 -F', transport: 'ib', size: 65536, mtu: 4096, qps: 1, bidir: false, bwGbps: 94.79, latMinUs: 0.83, latTypicalUs: 0.85, source: 'capture' },
];

/** The model settings closest to this setup within the widget's controls (alpha from the 2-byte t_typical, message-rate
 *  ceiling rounded from the ~6.4 M msgs/s the sweep shows for small messages). */
export const CX5_MODEL: Model = { t: 'roce4', mtu: 4096, gbps: 100, alphaUs: 0.9, mrM: 5 };

/** Measured large-message efficiency: the 8 MiB BW average as a share of the 100 Gb/s line rate, in percent. */
export const cx5LargeMessagePct = () => (100 * CX5_BW_SWEEP[CX5_BW_SWEEP.length - 1].bwGbps) / CX5_SETUP.linkGbps;
