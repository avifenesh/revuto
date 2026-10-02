const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
  'EAI_AGAIN', 'ENOTFOUND', 'ERR_SOCKET_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);
const TRANSIENT_HTTP_STATUS = new Set([408, 500, 502, 503, 504]);

function errorChain(err: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 6) return;
    seen.add(value);
    const error = value as Record<string, unknown>;
    result.push(error);
    visit(error.cause, depth + 1);
    if (Array.isArray(error.errors)) for (const child of error.errors.slice(0, 8)) visit(child, depth + 1);
  };
  visit(err, 0);
  return result;
}

function errorStatus(error: Record<string, unknown>): number | undefined {
  const response = error.response as { status?: unknown } | undefined;
  const status = error.status ?? error.statusCode ?? response?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

export function isSurrealTransportError(err: unknown): boolean {
  const errors = errorChain(err);
  if (errors.some(error => error.name === 'AbortError')) return false;
  return errors.some(error =>
    (typeof error.code === 'string' && TRANSPORT_CODES.has(error.code)) ||
    error.name === 'TimeoutError' ||
    (error.name === 'TypeError' && error.message === 'fetch failed') ||
    TRANSIENT_HTTP_STATUS.has(errorStatus(error) ?? 0),
  );
}

/** Each request gets its own deadline; keep caller cancellation effective too. */
export function createSurrealFetch(timeoutMs = 15_000, fetchImpl = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (input instanceof Request) signals.push(input.signal);
    if (init?.signal) signals.push(init.signal);
    return fetchImpl(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

/** Only use for reads and initialization statements safe to replay after a lost response. */
export async function retrySurrealRead<T>(fn: () => Promise<T>): Promise<T> {
  const waits = [100, 300];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= waits.length || !isSurrealTransportError(err)) throw err;
      await new Promise(resolve => setTimeout(resolve, waits[attempt]));
    }
  }
}

/** Error metadata only: server messages may contain SQL, values, or credentials. */
export function surrealErrorMessage(err: unknown): string {
  const details = new Set<string>();
  for (const error of errorChain(err)) {
    if (typeof error.name === 'string' && /^(?:[A-Za-z][A-Za-z0-9]*Error|Error)$/.test(error.name)) details.add(error.name);
    if (typeof error.code === 'string' && TRANSPORT_CODES.has(error.code)) details.add(error.code);
    if (error.name === 'TypeError' && error.message === 'fetch failed') details.add('fetch failed');
    const status = errorStatus(error);
    if (status !== undefined) details.add(`HTTP ${status}`);
  }
  return [...details].join(', ') || 'unknown error';
}
