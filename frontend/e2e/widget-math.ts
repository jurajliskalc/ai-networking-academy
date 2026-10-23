// The pure functions the widgets export, loaded for the browser tests. Playwright's own TypeScript loader
// hangs on .tsx files that contain JSX (seen with @playwright/test 1.49 on Windows), so the widget modules
// are bundled once with esbuild (a vite dependency) into a CommonJS file under node_modules/.cache, where
// `react` and the other packages resolve, and required from there. Type-only imports are erased, so the
// types still come straight from the widget sources.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import type * as Pcie from '../src/widgets/PcieBandwidth';
import type * as IbSpeeds from '../src/widgets/IbSpeeds';
import type * as Dscp from '../src/widgets/DscpMapper';
import type * as Nccl from '../src/widgets/NcclTestsReader';
import type * as Headroom from '../src/widgets/HeadroomCalculator';
import type * as Subnet from '../src/widgets/SubnetCalculator';
import type * as BerFec from '../src/widgets/BerFec';
import type * as Straggler from '../src/widgets/StragglerTail';
import type * as Collective from '../src/widgets/CollectiveExplorer';
import type * as Pkey from '../src/widgets/PkeyMembership';
import type * as Frame from '../src/widgets/EthernetFrame';

const MODULES = {
  pcie: 'PcieBandwidth', ibSpeeds: 'IbSpeeds', dscp: 'DscpMapper', nccl: 'NcclTestsReader', headroom: 'HeadroomCalculator',
  subnet: 'SubnetCalculator', berFec: 'BerFec', straggler: 'StragglerTail', collective: 'CollectiveExplorer', pkey: 'PkeyMembership', frame: 'EthernetFrame',
} as const;

export interface WidgetMath {
  pcie: typeof Pcie; ibSpeeds: typeof IbSpeeds; dscp: typeof Dscp; nccl: typeof Nccl; headroom: typeof Headroom;
  subnet: typeof Subnet; berFec: typeof BerFec; straggler: typeof Straggler; collective: typeof Collective; pkey: typeof Pkey; frame: typeof Frame;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'node_modules', '.cache', `e2e-widget-math-${process.pid}.cjs`);
fs.mkdirSync(path.dirname(out), { recursive: true });
buildSync({
  stdin: {
    contents: Object.entries(MODULES).map(([k, f]) => `export * as ${k} from './src/widgets/${f}';`).join('\n'),
    resolveDir: root, sourcefile: 'e2e-widget-math.ts', loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external', outfile: out, logLevel: 'error',
});

export const math = createRequire(import.meta.url)(out) as WidgetMath;
fs.rmSync(out, { force: true }); // loaded and cached; no need to keep it
