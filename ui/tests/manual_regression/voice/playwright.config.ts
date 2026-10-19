import { defineConfig, devices } from '@playwright/test';

/**
 * The voice matrix in a real browser. Chromium's fake media devices stand in for a person at the
 * microphone: `VOICE_MIC_WAV` is played as the mic, once (`%noloop`), from the moment the app opens
 * it; permission is granted up front, so the browser call is the real WebRTC path end to end.
 */
const micWav = process.env.VOICE_MIC_WAV || '';

export default defineConfig({
  testDir: '.',
  testMatch: '*.md.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.VITE_PORT || '4097'}`,
    headless: true,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        ...(micWav ? [`--use-file-for-fake-audio-capture=${micWav}%noloop`] : []),
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], permissions: ['microphone'] } }],
});
