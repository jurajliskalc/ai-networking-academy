import { Button } from '../components/ui';

export default function NotFound() {
  return (
    <div className="py-24 text-center">
      <h1 className="font-mono text-6xl font-bold text-accent"><span className="sr-only">Page not found: </span><span>404</span></h1>
      <p className="mt-3 text-muted">Destination host unreachable. This page is not in the routing table.</p>
      <div className="mt-6"><Button to="/">Back to the dashboard</Button></div>
    </div>
  );
}
