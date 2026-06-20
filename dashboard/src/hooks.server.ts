import process from 'node:process';

import type { Handle } from '@sveltejs/kit';

declare global {
  var __revutoDashboardShutdownListener: boolean | undefined;
}

if (!globalThis.__revutoDashboardShutdownListener) {
  globalThis.__revutoDashboardShutdownListener = true;
  process.once('sveltekit:shutdown', () => {
    process.exit(0);
  });
}

export const handle: Handle = ({ event, resolve }) => resolve(event);
