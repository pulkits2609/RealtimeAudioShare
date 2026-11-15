import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './verification/playwright',
  globalSetup: './scripts/test-stack.mjs',
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: 'http://127.0.0.1:15173',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    headless: true,
    colorScheme: 'light',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio',
        '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
  },
});
