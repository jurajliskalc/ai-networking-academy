import { Link } from 'react-router-dom';
import { useIndex } from '../../content';
import { Card, Loading } from '../../components/ui';
import { CodeBox, HwShell } from './shared';
import { LivePanel } from './LivePanel';

export default function HwLive() {
  const { data: ix, error } = useIndex();
  if (!ix) return <Loading error={error} />;
  return (
    <HwShell ix={ix}>
      <p className="mb-6 max-w-3xl text-muted">
        Watch the lab ports while traffic runs: RDMA bandwidth, pause frames, CNPs, ECN marks and out-of-sequence packets, as rates from the
        counters the <Link to="/hw/toolkit" className="text-data underline underline-offset-2">aina-hw agent</Link> reads once a second. Read-only: it changes nothing on the hosts.
      </p>
      <Card className="mb-6 p-5">
        <LivePanel />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <CodeBox title="on host A" code={'cd ~/ai-networking-academy/labs/hw-toolkit\n./aina-hw serve --live-remote     # host A locally, host B over one SSH session\n# terminal only, no browser:\n./aina-hw live'} />
        <CodeBox title="on your laptop" code={'ssh -L 8765:127.0.0.1:8765 <host A>\n# then press Start above'} />
      </div>
    </HwShell>
  );
}
