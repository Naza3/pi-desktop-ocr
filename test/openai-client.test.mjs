import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenAIClient, OpenAIError, normalizeOpenAIBaseUrl } from '../src/openai-client.mjs';

const INPUT = { modelId: 'Org/GLM-OCR:Q8_0', imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', prompt: 'Text Recognition:', maxTokens: 8192 };
const USAGE = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
const frame = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`;
const chunk = (content, finish = null) => ({ id: 'server-generated-id', object: 'chat.completion.chunk', model: 'server-model-alias', choices: [{ index: 0, delta: { ...(content === undefined ? {} : { content }) }, finish_reason: finish }] });
const stream = ({ text = '# 识别结果\n你好', finish = 'stop', usage = true } = {}) => frame(chunk(text)) + frame(chunk(undefined, finish))
  + (usage ? frame({ id: 'server-generated-id', object: 'chat.completion.chunk', choices: [], usage: USAGE }) : '') + frame('[DONE]');
function json(response, value, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
function sse(response, text) { response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' }); response.end(text); }
async function fixture(t, handler, options = {}) {
  const requests = [], failures = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const bytes of request) chunks.push(bytes);
      const body = Buffer.concat(chunks).toString();
      const row = { method: request.method, path: request.url, headers: request.headers, body: body ? JSON.parse(body) : null };
      requests.push(row);
      if (handler) return await handler(row, response, request);
      if (row.path === '/v1/models') return json(response, { object: 'list', data: [{ id: INPUT.modelId }] });
      return sse(response, stream());
    } catch (error) { failures.push(error); response.destroy(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return { baseUrl, requests, client: new OpenAIClient({ baseUrl, timeoutSeconds: 10, ...options }), server };
}

test('URL normalization retains only explicit local HTTP ports and standard v1', () => {
  for (const source of ['http://localhost:8080', 'http://127.0.0.1:8080/', 'http://localhost:8080/v1', 'http://localhost:8080/v1/']) {
    assert.equal(normalizeOpenAIBaseUrl(source), 'http://127.0.0.1:8080/v1');
  }
  assert.equal(normalizeOpenAIBaseUrl('http://127.0.0.1:80/v1'), 'http://127.0.0.1:80/v1');
  for (const source of ['http://localhost', 'http://localhost:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:080', 'https://localhost:8080/v1',
    'http://127.1:8080', 'http://2130706433:8080', 'http://[::1]:8080', 'http://example.com:8080', 'http://user@localhost:8080',
    'http://localhost:8080/v1/models', 'http://localhost:8080//v1', 'http://localhost:8080/%761', 'http://localhost:8080?x=1', 'http://localhost:8080/#x']) {
    assert.throws(() => normalizeOpenAIBaseUrl(source), { code: 'invalid_address' });
  }
  assert.equal(new OpenAIClient().baseUrl, 'http://127.0.0.1:8080/v1');
});

test('API keys are optional, bounded and never serialized or permitted to inject headers', () => {
  const secret = 'private-model-api-key';
  assert.ok(!JSON.stringify(new OpenAIClient({ token: secret })).includes(secret));
  for (const token of ['a'.repeat(4097), 'abc\r\nX-Injected: true', 'abc\0', '🔑', null]) assert.throws(() => new OpenAIClient({ token }), { code: 'invalid_token' });
  for (const timeoutSeconds of [0, 86401, 1.5, '10']) assert.throws(() => new OpenAIClient({ timeoutSeconds }), { code: 'invalid_timeout' });
  assert.ok(new OpenAIError('fixed_code', '固定消息') instanceof Error);
});

test('connect uses only standard models endpoint and does not claim vision or runtime identity', async (t) => {
  const f = await fixture(t);
  const result = await f.client.connect();
  assert.deepEqual(result, { instanceId: null, status: { state: 'ready', active_request: null, queued_jobs: 0 }, models: [{ id: INPUT.modelId, display_name: INPUT.modelId, loadable: true, available: true }] });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/v1/models');
  assert.equal(f.requests[0].headers.authorization, undefined);
});

test('explicit API key is sent only to the configured local endpoint', async (t) => {
  const f = await fixture(t, undefined, { token: 'local-secret' });
  await f.client.connect();
  assert.equal(f.requests[0].headers.authorization, 'Bearer local-secret');
});

test('unsupported model-list endpoints permit manual model IDs without parsing error bodies', async (t) => {
  for (const status of [404, 405]) await t.test(String(status), async (t) => {
    const f = await fixture(t, (_row, response) => { response.writeHead(status); response.end('not JSON, private response text'); });
    assert.deepEqual((await f.client.connect()).models, []);
    assert.equal(f.requests.length, 1);
  });
});

test('model list rejects malformed JSON, oversized data and invalid or duplicate IDs', async (t) => {
  const values = [{ data: [{ id: 'a b' }] }, { data: [{ id: 'a'.repeat(257) }] }, { data: [{ id: 'A' }, { id: 'A' }] }, { data: null }, { data: Array.from({ length: 4097 }, (_, i) => ({ id: String(i) })) }];
  for (let i = 0; i < values.length; i++) await t.test(String(i), async (t) => {
    const f = await fixture(t, (_row, response) => json(response, values[i]));
    await assert.rejects(f.client.connect(), { code: 'invalid_response' });
  });
  await t.test('JSON bytes cap', async (t) => {
    const f = await fixture(t, (_row, response) => json(response, { data: [], ignored: 'x'.repeat(4 * 1024 * 1024) }));
    await assert.rejects(f.client.connect(), { code: 'response_too_large' });
  });
  await t.test('bad UTF8', async (t) => {
    const f = await fixture(t, (_row, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(Buffer.from([0xff])); });
    await assert.rejects(f.client.connect(), { code: 'invalid_response' });
  });
  await t.test('malformed JSON', async (t) => {
    const f = await fixture(t, (_row, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{broken'); });
    await assert.rejects(f.client.connect(), { code: 'invalid_response' });
  });
});

test('HTTP errors never forward remote messages, tokens or redirects and never replay', async (t) => {
  for (const status of [301, 307, 400, 401, 403, 429, 500]) await t.test(String(status), async (t) => {
    const secret = 'DO-NOT-EXPOSE';
    const f = await fixture(t, (_row, response) => { response.writeHead(status, { Location: 'http://example.com/private', 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: secret, message: secret } })); }, { token: secret });
    await assert.rejects(f.client.recognize(INPUT), (error) => {
      assert.equal(error.status, status);
      assert.ok(!JSON.stringify(error).includes(secret));
      assert.ok(!error.message.includes(secret));
      assert.equal(error.cleanupConfirmed, true);
      return true;
    });
    assert.equal(f.requests.length, 1);
  });
});

test('OCR sends image first, preserves split UTF8 and CRLF, and reports no fabricated metrics', async (t) => {
  const f = await fixture(t, async (row, response) => {
    assert.equal(row.method, 'POST');
    assert.equal(row.path, '/v1/chat/completions');
    assert.equal(row.body.model, INPUT.modelId);
    assert.equal(row.body.messages[0].content[0].image_url.url, INPUT.imageDataUrl);
    assert.equal(row.body.messages[0].content[1].text, INPUT.prompt);
    assert.equal(row.body.max_tokens, 8192);
    assert.equal(row.body.stream_options.include_usage, true);
    assert.equal(row.headers['x-request-id'], undefined);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(': heartbeat\r\n\r\n' + stream());
    for (let i = 0; i < bytes.length; i += 7) { response.write(bytes.subarray(i, i + 7)); await delay(1); }
    response.end();
  });
  let observed = '', requestId;
  const phases = [];
  const result = await f.client.recognize(INPUT, { onDelta: (text) => observed += text, onPhase: (phase) => phases.push(phase), onRequest: (id) => requestId = id });
  assert.equal(result.text, '# 识别结果\n你好');
  assert.equal(observed, result.text);
  assert.deepEqual(result.usage, USAGE);
  assert.equal(result.performance, null);
  assert.equal(result.instanceId, null);
  assert.equal(result.requestId, requestId);
  assert.match(requestId, /^[0-9a-f-]{36}$/);
  assert.notEqual(requestId, 'server-generated-id');
  assert.equal(result.complete, true);
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(phases, ['generating', 'decode', 'finished']);
  assert.equal(f.requests.length, 1);
});

test('a standard stream can omit usage and include text in its terminal chunk', async (t) => {
  const f = await fixture(t, (_row, response) => sse(response, frame(chunk('识别内容', 'stop')) + frame('[DONE]')));
  const result = await f.client.recognize(INPUT);
  assert.equal(result.text, '识别内容');
  assert.equal(result.usage, null);
  assert.equal(result.complete, true);
});

test('length and content-filter termination preserve incomplete results without retrying', async (t) => {
  for (const finish of ['length', 'content_filter']) await t.test(finish, async (t) => {
    const f = await fixture(t, (_row, response) => sse(response, stream({ finish, usage: false })));
    const result = await f.client.recognize(INPUT);
    assert.equal(result.finishReason, finish);
    assert.equal(result.complete, false);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(f.requests.length, 1);
  });
});

test('malformed JSON, UTF8, finish markers and unsupported outputs cannot appear as success', async (t) => {
  const cases = [
    ['bad JSON', frame('{invalid'), 'invalid_response'],
    ['bad UTF8', Buffer.concat([Buffer.from('data: '), Buffer.from([0xff]), Buffer.from('\n\n')]), 'invalid_response'],
    ['truncated UTF8', Buffer.from([0xe4, 0xbd]), 'invalid_response'],
    ['missing done', frame(chunk(undefined, 'stop')), 'incomplete_stream'],
    ['missing finish', frame('[DONE]'), 'invalid_response'],
    ['duplicate finish', frame(chunk(undefined, 'stop')) + frame(chunk(undefined, 'stop')) + frame('[DONE]'), 'invalid_response'],
    ['data after done', frame(chunk(undefined, 'stop')) + frame('[DONE]') + frame(chunk('extra')), 'invalid_response'],
    ['tools', frame({ choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: null }] }), 'invalid_response'],
    ['multiple choices', frame({ choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] }), 'invalid_response'],
    ['remote stream error', frame({ error: { message: 'PRIVATE BODY', code: 'SECRET' } }), 'api_error'],
    ['changed stream id', frame({ ...chunk('text'), id: 'different-id' }), 'invalid_response'],
    ['bad usage', frame(chunk(undefined, 'stop')) + frame({ choices: [], usage: { ...USAGE, total_tokens: 3 } }) + frame('[DONE]'), 'invalid_response'],
  ];
  for (const [name, bad, code] of cases) await t.test(name, async (t) => {
    const f = await fixture(t, async (_row, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(frame(chunk('已生成')));
      await delay(10); // Commit accepted text before a later malformed wire chunk.
      response.end(bad);
    });
    await assert.rejects(f.client.recognize(INPUT), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.partialResult.text, '已生成');
      assert.equal(error.partialResult.complete, false);
      assert.equal(error.cleanupConfirmed, false);
      assert.equal(error.cleanupError, 'executor_cleanup_unconfirmed');
      assert.ok(!error.message.includes('PRIVATE BODY'));
      return true;
    });
    assert.equal(f.requests.length, 1);
  });
});

test('non-SSE success responses are rejected without leaking their bodies', async (t) => {
  const f = await fixture(t, (_row, response) => json(response, { private: 'PRIVATE BODY' }));
  await assert.rejects(f.client.recognize(INPUT), (error) => error.code === 'invalid_response' && !error.message.includes('PRIVATE BODY'));
});

test('SSE frame size and aggregate output are bounded while preserving accepted text', async (t) => {
  await t.test('frame', async (t) => {
    const f = await fixture(t, (_row, response) => sse(response, frame(chunk('x'.repeat(128 * 1024)))));
    await assert.rejects(f.client.recognize(INPUT), { code: 'invalid_response' });
  });
  await t.test('text', async (t) => {
    const f = await fixture(t, (_row, response) => sse(response, Array.from({ length: 17 }, () => frame(chunk('x'.repeat(64 * 1024)))).join('')));
    await assert.rejects(f.client.recognize(INPUT), (error) => error.code === 'output_too_large' && Buffer.byteLength(error.partialResult.text) === 1024 * 1024);
  });
});

test('oversized HTTP headers fail safely without revealing header contents', async (t) => {
  const f = await fixture(t, (_row, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Private': 'x'.repeat(17000) }); response.end(stream()); });
  await assert.rejects(f.client.recognize(INPUT), (error) => error.code === 'connection_failed' && error.message.length < 200);
});

test('comment-only streams still respect the aggregate wire byte limit', async (t) => {
  const f = await fixture(t, (_row, response) => sse(response, (`: ${'x'.repeat(64 * 1024)}\n\n`).repeat(513)));
  await assert.rejects(f.client.recognize(INPUT), (error) => error.code === 'response_too_large' && error.partialResult.text === '' && error.cleanupConfirmed === false);
});

test('dropped connections preserve prior output and do not restart recognition', async (t) => {
  const f = await fixture(t, async (_row, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(frame(chunk('断开前的文字')));
    await delay(10);
    response.destroy();
  });
  await assert.rejects(f.client.recognize(INPUT), (error) => error.code === 'connection_failed' && error.partialResult.text === '断开前的文字' && error.cleanupConfirmed === false);
  assert.equal(f.requests.length, 1);
});

test('timeout disconnects once, retains partial content and cannot promise server cancellation', async (t) => {
  const f = await fixture(t, (_row, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(frame(chunk('超时前的文字'))); }, { timeoutSeconds: 1 });
  await assert.rejects(f.client.recognize(INPUT), (error) => {
    assert.equal(error.code, 'client_timeout');
    assert.equal(error.partialResult.text, '超时前的文字');
    assert.equal(error.cleanupConfirmed, false);
    assert.match(error.message, /无法确认服务端/);
    return true;
  });
  assert.equal(f.requests.length, 1);
});

test('explicit stop preserves partial text and uses no backend-specific cancellation endpoint', async (t) => {
  const abort = new AbortController();
  const f = await fixture(t, (_row, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(frame(chunk('停止前的文字'))); });
  await assert.rejects(f.client.recognize(INPUT, { signal: abort.signal, onDelta: () => abort.abort() }), (error) => error.code === 'request_cancelled' && error.partialResult.text === '停止前的文字' && error.cleanupConfirmed === false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/v1/chat/completions');
});

test('active requests refuse concurrency and abort-before-send does not issue HTTP requests', async (t) => {
  const abort = new AbortController();
  const f = await fixture(t, (_row, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(frame(chunk('running'))); });
  let began;
  const started = new Promise((resolve) => began = resolve);
  const task = f.client.recognize(INPUT, { signal: abort.signal, onDelta: began });
  await started;
  await assert.rejects(f.client.recognize(INPUT), { code: 'runtime_busy' });
  abort.abort();
  await assert.rejects(task, { code: 'request_cancelled' });
  const pre = AbortSignal.abort();
  await assert.rejects(f.client.recognize(INPUT, { signal: pre }), (error) => error.code === 'request_cancelled' && error.cleanupConfirmed === true);
  await assert.rejects(f.client.connect({ signal: pre }), { code: 'request_cancelled' });
  assert.equal(f.requests.length, 1);
});

test('invalid inputs are rejected before any network operation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client.recognize(null), { code: 'invalid_request' });
  for (const patch of [{ modelId: '' }, { modelId: 'bad model' }, { modelId: 'x'.repeat(257) }, { imageDataUrl: 'http://example.com/image.png' },
    { imageDataUrl: 'data:image/png;base64,abc' }, { prompt: '' }, { prompt: 'x'.repeat(16385) }, { prompt: '中'.repeat(12000) },
    { maxTokens: 32769 }, { maxTokens: 0 }]) await assert.rejects(f.client.recognize({ ...INPUT, ...patch }), OpenAIError);
  assert.equal(f.requests.length, 0);
});
