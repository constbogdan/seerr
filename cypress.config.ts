import { defineConfig } from 'cypress';

export default defineConfig({
  projectId: 'onnqy3',
  e2e: {
    baseUrl: 'http://localhost:5055',
    video: true,
    setupNodeEvents(on) {
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
    },
  },
  env: {
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
