import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { parseVisits, pingUrl, visitCounter } from '../visitors';

// One ping per page load, however often the component mounts (React StrictMode mounts it twice in dev).
let pinged = false;

/**
 * The sidebar line "1,234 visits". On the published site it counts this page load and shows the total;
 * anywhere else, or when GoatCounter cannot be reached (offline, a content blocker), it renders nothing.
 */
export default function VisitorCount() {
  const [visits, setVisits] = useState<number | null>(null);

  useEffect(() => {
    const counter = visitCounter(location.hostname);
    if (!counter) return;
    let live = true;
    const run = () => {
      if (!pinged) {
        pinged = true;
        fetch(pingUrl(counter.ping, navigator.webdriver), { mode: 'no-cors', cache: 'no-store', keepalive: true }).catch(() => {});
      }
      fetch(counter.count)
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => { if (live) setVisits(parseVisits(body)); })
        .catch(() => {});
    };
    // Like GoatCounter's own client: a tab opened in the background counts once someone looks at it.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisible);
      run();
    };
    if (document.visibilityState === 'visible') run();
    else document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (visits === null) return null;
  return (
    <div className="flex items-center gap-2">
      <Users size={14} aria-hidden />{visits.toLocaleString('en-US')} {visits === 1 ? 'visit' : 'visits'}
    </div>
  );
}
