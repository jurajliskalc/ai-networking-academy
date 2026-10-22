// Browser interaction tests (npm run e2e). They drive the installed Google Chrome (channel "chrome"),
// never a downloaded Playwright browser, against `vite preview` of the built app in dist/.
// Run `npm run build` first. CHROME_PATH overrides the browser binary; E2E_PORT pins the port.
import { execFileSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

// Pick a free port once in the runner process; workers inherit it through the environment.
if (!process.env.E2E_PORT) {
  process.env.E2E_PORT = execFileSync(process.execPath, ['-e', "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"]).toString().trim();
}
const port = Number(process.env.E2E_PORT);
const chrome = process.env.CHROME_PATH ? { launchOptions: { executablePath: process.env.CHROME_PATH } } : { channel: 'chrome' };

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}/`,
    ...devices['Desktop Chrome'],
    ...chrome,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
