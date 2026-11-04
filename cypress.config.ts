import { defineConfig } from 'cypress';
import { unlinkSync } from 'fs';
import { registerStorageProviderTasks } from './cypress/support/storageProviders';

export default defineConfig({
  projectId: 'onnqy3',
  e2e: {
    baseUrl: 'http://localhost:5055',
    video: true,
    setupNodeEvents(on) {
      registerStorageProviderTasks(on);
      on('before:browser:launch', (browser, launchOptions) => {
        if (
          process.env.CYPRESS_NON_FORWARDING_NETWORK === 'true' &&
          browser.family === 'chromium'
        ) {
          launchOptions.args.push(
            '--no-sandbox',
            '--disable-background-networking',
            '--disable-features=ServiceWorker',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
          );
        }

        return launchOptions;
      });
      on('after:spec', (_spec, results) => {
        if (!results?.video) {
          return;
        }

        const failed = results.tests.some((test) =>
          test.attempts.some((attempt) => attempt.state === 'failed')
        );

        if (!failed) {
          unlinkSync(results.video);
        }
      });
    },
  },
  expose: {
    ADMIN_EMAIL: 'admin@seerr.dev',
    ADMIN_PASSWORD: 'test1234',
    USER_EMAIL: 'demo@seerr.dev',
    USER_PASSWORD: 'test1234',
  },
  retries: {
    runMode: 2,
    openMode: 0,
  },
});
