// The visit counter's rules: where a visit is counted, the exact GoatCounter URLs, and how the count is read.
// The request and response shapes follow GoatCounter's documentation (help/pixel, help/visitor-counter)
// and its server source (handlers/count.go, handlers/vcounter.go), read on 2026-11-24.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GOATCOUNTER_CODE, PUBLISHED_URL, parseVisits, pingUrl, visitCounter } from '../src/visitors';

describe('visit counter: where visits are counted', () => {
  it('counts on the published host, with one fixed path for the whole app', () => {
    expect(visitCounter('jurajliskalc.github.io')).toEqual({
      ping: `https://${GOATCOUNTER_CODE}.goatcounter.com/count?p=%2Fai-networking-academy`,
      count: `https://${GOATCOUNTER_CODE}.goatcounter.com/counter/%2Fai-networking-academy.json`,
    });
  });

  it('makes no request anywhere else: a laptop, a preview server, a LAN address, a fork', () => {
    for (const host of ['localhost', '127.0.0.1', '192.168.1.20', '', 'someone-else.github.io', 'github.io', 'jurajliskalc.github.io.example.org']) {
      expect(visitCounter(host), host).toBeNull();
    }
  });

  it('is off without a site code, and never builds a URL from a malformed one', () => {
    for (const code of ['', ' ', 'a.b', 'a/b', 'evil.example.org/x?', '-a', 'a-', 'UPPER']) {
      expect(visitCounter('jurajliskalc.github.io', code), JSON.stringify(code)).toBeNull();
    }
    expect(visitCounter('jurajliskalc.github.io', 'my-site-2')?.ping).toBe('https://my-site-2.goatcounter.com/count?p=%2Fai-networking-academy');
  });

  it('follows the published URL: a site at the root of its own domain is counted as "/"', () => {
    expect(visitCounter('academy.example.org', 'code', 'https://academy.example.org/')).toEqual({
      ping: 'https://code.goatcounter.com/count?p=%2F',
      count: 'https://code.goatcounter.com/counter/%2F.json',
    });
    expect(visitCounter('jurajliskalc.github.io', 'code', 'https://academy.example.org/')).toBeNull();
  });

  it('is published where the README says the live academy is', () => {
    const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(PUBLISHED_URL);
  });
});

describe('visit counter: the ping', () => {
  const ping = 'https://code.goatcounter.com/count?p=%2Fai-networking-academy';

  it('carries the path and a cache buster, and nothing about the visitor', () => {
    const u = new URL(pingUrl(ping, false, 'k3x9a'));
    expect([...u.searchParams.entries()]).toEqual([['p', '/ai-networking-academy'], ['rnd', 'k3x9a']]);
  });

  it('flags a WebDriver-driven browser as a bot (153), so automated runs are not counted as people', () => {
    expect(new URL(pingUrl(ping, true, 'k3x9a')).searchParams.get('b')).toBe('153');
  });

  it('gets a fresh cache buster each time', () => {
    const a = new URL(pingUrl(ping, false)).searchParams.get('rnd');
    const b = new URL(pingUrl(ping, false)).searchParams.get('rnd');
    expect(a).toMatch(/^[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });
});

describe('visit counter: reading the count', () => {
  it('reads the count whatever thousands separator the GoatCounter account uses', () => {
    expect(parseVisits({ count_unique: '1,234', count: '1,234' })).toBe(1234);
    expect(parseVisits({ count: '1 234 567' })).toBe(1234567);
    expect(parseVisits({ count: '1.234' })).toBe(1234);
    expect(parseVisits({ count: "12'345" })).toBe(12345);
    expect(parseVisits({ count: '0' })).toBe(0);
    expect(parseVisits({ count: '7' })).toBe(7);
  });

  it('rejects anything that is not a formatted whole number', () => {
    for (const body of [null, undefined, 'x', 42, {}, { count: 1234 }, { count: '' }, { count: 'many' }, { count: '1.2k' }, { count: '<b>5</b>' }, { count: '1'.repeat(13) }]) {
      expect(parseVisits(body), JSON.stringify(body)).toBeNull();
    }
  });
});
