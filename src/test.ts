import { test as base } from 'e2e';
import type { Browser } from '@e2e-dev/web';
import { createRouteGuard } from './network.ts';

/** e2e's `test`, with the config's network policy applied before every test body. */
export const test = base.extend<{ browser: Browser }>().extend<{ networkPolicy: void }>({
  networkPolicy: async ({ browser }, use) => {
    const guard = createRouteGuard();
    if (guard) await browser.route('**/*', guard);
    await use();
  },
});
