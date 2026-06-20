import { json } from '@sveltejs/kit';
import { ACTION_TIMEOUT_MS, runDashboardAction } from '$lib/server/actions.js';

export const prerender = false;

export async function POST({ request }) {
  let body: { action?: unknown; target?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  if (typeof body.action !== 'string') {
    return json({ ok: false, error: 'action must be a string' }, { status: 400 });
  }
  if (body.target !== undefined && typeof body.target !== 'string') {
    return json({ ok: false, error: 'target must be a string' }, { status: 400 });
  }

  const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
    setTimeout(() => resolve({ ok: false, error: 'action timed out' }), ACTION_TIMEOUT_MS);
  });
  const result = await Promise.race([runDashboardAction(body.action, body.target), timeout]);
  return json(result, { status: result.ok ? 200 : 400 });
}
