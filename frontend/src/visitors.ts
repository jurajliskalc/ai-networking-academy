// The visit counter in the sidebar. The published site, and only that site, tells GoatCounter about one
// page load and reads the count of visits back. GoatCounter's own script is not loaded: these are the two
// documented endpoints (https://www.goatcounter.com/help/pixel and /help/visitor-counter), called directly.
// What is sent, and what is not, is described in docs/ARCHITECTURE.md ("Outside requests").

/** Where the published academy lives. Visits are counted on this host and nowhere else. */
export const PUBLISHED_URL = 'https://jurajliskalc.github.io/ai-networking-academy/';

/** GoatCounter site code, as in https://<code>.goatcounter.com. An empty string turns the counter off. */
export const GOATCOUNTER_CODE = 'jurajliska';

export interface VisitCounter {
  /** GET this to count one page load (the `/count` endpoint, which answers with a 1x1 GIF). */
  ping: string;
  /** GET this to read the number of visits: `{"count": "1,234"}`. */
  count: string;
}

/**
 * The GoatCounter URLs for a page served from `hostname`, or null when visits are not counted there: a
 * laptop, `vite preview`, a fork on another host, or no site code.
 */
export function visitCounter(hostname: string, code: string = GOATCOUNTER_CODE, published: string = PUBLISHED_URL): VisitCounter | null {
  const site = new URL(published);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(code) || hostname !== site.hostname) return null;
  // One fixed path for the whole app (never the route the learner is on), in the form GoatCounter stores
  // paths: a leading slash and no trailing one.
  const path = encodeURIComponent(`/${site.pathname.replace(/^\/+|\/+$/g, '')}`);
  const base = `https://${code}.goatcounter.com`;
  return { ping: `${base}/count?p=${path}`, count: `${base}/counter/${path}.json` };
}

/**
 * The ping with the two extras GoatCounter's own client sends: `b=153` marks a WebDriver-driven browser
 * so automated runs are not counted as people, and `rnd` stops a cache from answering for the server.
 */
export function pingUrl(ping: string, automated: boolean, rnd: string = Math.random().toString(36).slice(2, 7)): string {
  return `${ping}${automated ? '&b=153' : ''}&rnd=${encodeURIComponent(rnd)}`;
}

/**
 * Reads the counter's answer as a number. GoatCounter formats `count` with the account's thousands
 * separator (a comma, a dot, a thin space ...), so only the digits are kept.
 */
export function parseVisits(body: unknown): number | null {
  const count = (body as { count?: unknown } | null)?.count;
  if (typeof count !== 'string' || /[a-z]/i.test(count)) return null;
  const digits = count.replace(/\D/g, '');
  return digits && digits.length <= 12 ? Number(digits) : null;
}
