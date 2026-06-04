import { getDashboardSnapshot } from '$lib/server/snapshot.js';

export const prerender = false;

export async function load() {
  return {
    snapshot: await getDashboardSnapshot()
  };
}
