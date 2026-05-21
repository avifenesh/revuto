/**
 * Minimal fake OpenAI-compatible /chat/completions server for tests. Lets the
 * real @ai-sdk/openai-compatible provider + generateText tool loop run with no
 * GPU/network — the `script` decides the next tool call (or final text) based on
 * how many tool results the conversation already contains.
 */
import { createServer } from 'node:http';

export type FakeDecision = { tool: string; args: unknown } | { text: string };
/** Called per request with the number of tool-result messages seen so far. */
export type FakeScript = (toolResultsSoFar: number) => FakeDecision;

export interface FakeServer {
  readonly url: string;
  getCalls(): number;
  close(): Promise<void>;
}

export function startFakeOpenAI(script: FakeScript): Promise<FakeServer> {
  return new Promise((resolve) => {
    let calls = 0;
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (!url.endsWith('/chat/completions') && !url.endsWith('/embeddings')) { res.writeHead(404).end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls++;

        // Embeddings: return a small deterministic vector per input.
        if (url.endsWith('/embeddings')) {
          let input: unknown = [];
          try { input = JSON.parse(body).input; } catch { /* ignore */ }
          const values = Array.isArray(input) ? input : [input];
          const data = values.map((_, i) => ({ object: 'embedding', index: i, embedding: Array.from({ length: 8 }, (_, k) => ((i + k + 1) % 7) / 7) }));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data, model: 'fake', usage: { prompt_tokens: 1, total_tokens: 1 } }));
          return;
        }

        let messages: Array<{ role?: string }> = [];
        try { messages = JSON.parse(body).messages ?? []; } catch { /* ignore */ }
        const toolResults = messages.filter((m) => m.role === 'tool').length;
        const d = script(toolResults);
        const message = 'text' in d
          ? { role: 'assistant', content: d.text }
          : { role: 'assistant', content: null, tool_calls: [{ id: `call_${calls}`, type: 'function', function: { name: d.tool, arguments: JSON.stringify(d.args) } }] };
        const payload = {
          id: `cmpl_${calls}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'fake',
          choices: [{ index: 0, finish_reason: 'text' in d ? 'stop' : 'tool_calls', message }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        getCalls: () => calls,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
