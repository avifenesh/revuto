import { json } from '@sveltejs/kit';
import { getDashboardSnapshot } from '$lib/server/snapshot.js';

export const prerender = false;

export async function GET() {
  return json(await getDashboardSnapshot());
}
