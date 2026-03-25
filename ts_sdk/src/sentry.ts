import * as Sentry from '@sentry/browser';
import { config } from './config';

const version = '0.1.0'; // SDK version

export const initSentry = () => {
  if (config.SENTRY_DSN !== '' && !Sentry.getClient()) {
    console.debug('Initializing Sentry...');
    console.debug('Running in environment mode', config.DEPLOY_ENV);
    Sentry.init({
      dsn: config.SENTRY_DSN,
      release: `flowpad@${version}`,
      environment: config.DEPLOY_ENV.toLowerCase(),

      // Performance monitoring - 100% sampling for comprehensive coverage
      tracesSampleRate: 1.0,

      // Session Replay - 100% sampling for comprehensive coverage
      replaysSessionSampleRate: 1.0,
      replaysOnErrorSampleRate: 1.0,

      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.replayIntegration({
          maskAllText: false,
          workerUrl: '/assets/worker.min.js',
        }),
        Sentry.replayCanvasIntegration(),
      ],
    });
    console.debug('Sentry initialized successfully');
  } else {
    console.debug('SENTRY_DSN is not set');
  }
};
