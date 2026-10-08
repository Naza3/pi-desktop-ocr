import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { NexaClient, NexaError, normalizeBaseUrl } from '../src/nexa-client.mjs';

const TOKEN = '01'.repeat(32);
const INSTANCE = 'd9a42717-5f5a-413e-8b1b-e56500584470';
const GENERATION = '77a42717-5f5a-413e-8b1b-e56500584470';
const MODEL = { id: 'glm-ocr', display_name: 'GLM OCR', available: true, loadable: true, has_projector: true };
const READY = { state: 'ready', selected_model: MODEL.id, active_request: null, queued_jobs: 0, stopping: false, registry_busy: false, load_options: { context_size: 8192, threads: 4, batch_size: 256 } };
const INPUT = { modelId: MODEL.id, imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', prompt: 'Text Recognition:', maxTokens: 2048 };
const USAGE = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
function ep(port) { const result = Buffer.from([4, 127, 0, 0, 1, 0, 0]); result.writeUInt16BE(port, 5); return result; }
function proof(req, id = INSTANCE) {
  const version = Buffer.alloc(4); version.writeUInt32BE(1);
  return createHmac('sha256', TOKEN).update(Buffer.concat([
    Buffer.from('Nexa/local-http/server-proof\0'), version, Buffer.from(id.replaceAll('-', ''), 'hex'),
    Buffer.from(req.headers['x-nexa-server-challenge'], 'hex'), ep(req.socket.remotePort), ep(req.socket.localPort),
  ])).digest('hex');
}
function chunk(id, delta, finish = null) {
  return { id: `chatcmpl-${id}`, object: 'chat.completion.chunk', model: MODEL.id, choices: [{ index: 0, delta, finish_reason: finish }] };
}
function stream(id, { text = '你好\n| 表格 |', finish = 'stop' } = {}) {
  const events = [chunk(id, { role: 'assistant' }), chunk(id, { content: text }), chunk(id, {}, finish),
    { id: `chatcmpl-${id}`, object: 'chat.completion.chunk', model: MODEL.id, choices: [], usage: USAGE }];
  return events.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
}
function record(id) {
  return { sequence: 1, request_id: id, model_id: MODEL.id, modality: 'image', status: 'completed', accepted_at_unix_ms: 1,
    max_output_tokens: INPUT.maxTokens, usage: { prompt_tokens: 10, completion_tokens: 3 },
    timings: { queue_ms: 1, load_ms: 0, execution_ms: 5 }, error_code: null, finish_reason: 'stop',
    performance: { timings: { prepare_us: 10, prefill_us: 1000, decode_us: 2000, output_callback_us: 3 }, load_options: READY.load_options } };
}
async function fixture(t, override = async () => false, options = {}) {
  const requests = [], proven = new Set(), failures = [];
  let lastRequestId;
  const server = http.createServer(async (req, res) => {
    try {
      const bytes = [];
      for await (const chunk of req) bytes.push(chunk);
      const body = Buffer.concat(bytes).toString();
      const row = { method: req.method, path: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined, port: req.socket.remotePort };
      requests.push(row);
      if (req.url === '/healthz') {
        assert.equal(req.headers.authorization, undefined, 'never disclose token before proof');
        const id = options.instanceId?.() ?? INSTANCE;
        const headers = { 'x-nexa-instance-id': id, 'x-nexa-server-proof': options.badProof ? '00'.repeat(32) : proof(req, id),
          'x-nexa-protocol-version': '1', 'cache-control': 'no-store', 'content-type': 'application/json' };
        if (options.closeProof) headers.connection = 'close';
        proven.add(req.socket.remotePort);
        res.writeHead(200, headers); res.end('{"status":"ok"}'); return;
      }
      assert.ok(proven.has(req.socket.remotePort), 'authenticated operation must use proved socket');
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      if (await override(req, res, row)) return;
      if (req.url === '/runtime/status') return json(res, READY);
      if (req.url.startsWith('/runtime/models?')) return json(res, { object: 'list', data: [MODEL], next_after: null, generation: GENERATION });
      if (req.url === '/runtime/configuration') return json(res, { runtime_effective: { chat_response_timeout_seconds: 630, values: { runtime: { execution_timeout_seconds: 300 } } } });
      if (req.url === '/v1/chat/completions') {
        lastRequestId = req.headers['x-request-id'];
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': lastRequestId });
        res.end(stream(lastRequestId)); return;
      }
      if (req.url === '/runtime/performance') return json(res, { instance_id: INSTANCE, capacity: 200, records: lastRequestId ? [record(lastRequestId)] : [] });
      if (/\/cancel$/.test(req.url)) { res.writeHead(204); res.end(); return; }
      json(res, { error: { code: 'not_found' } }, 404);
    } catch (e) { failures.push(e); res.destroy(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { client: new NexaClient({ baseUrl, token: TOKEN, timeoutSeconds: options.timeoutSeconds ?? 10 }), baseUrl, requests, server };
}

test('only canonical explicit loopback URLs and Nexa token format are accepted', () => {
  assert.equal(normalizeBaseUrl('http://localhost:18080/'), 'http://127.0.0.1:18080');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:80'), 'http://127.0.0.1:80');
  for (const baseUrl of ['http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:80/api', 'http://127.0.0.1:80?x', 'http://user@127.0.0.1:80', 'https://127.0.0.1:80', 'http://2130706433:80', 'http://127.1:80', 'http://[::1]:80', 'http://example.org:80']) {
    assert.throws(() => new NexaClient({ baseUrl, token: TOKEN }), { code: 'invalid_address' });
  }
  assert.throws(() => new NexaClient({ baseUrl: 'http://127.0.0.1:80', token: 'bad' }), { code: 'invalid_token' });
  assert.throws(() => new NexaClient({ baseUrl: 'http://127.0.0.1:80', token: TOKEN, timeoutSeconds: 0 }), { code: 'invalid_timeout' });
});

test('connect authenticates each same-socket exchange and exposes model/config snapshots', async (t) => {
  const f = await fixture(t);
  const result = await f.client.connect();
  assert.equal(result.instanceId, INSTANCE);
  assert.deepEqual(result.models, [MODEL]);
  assert.equal(result.config.runtime_effective.values.runtime.execution_timeout_seconds, 300);
  assert.equal(f.requests.filter((r) => r.path === '/healthz').length, 3);
  assert.ok(!JSON.stringify(f.client).includes(TOKEN));
});

test('bad proof fails before credentials or operations reach server', async (t) => {
  const f = await fixture(t, undefined, { badProof: true });
  await assert.rejects(f.client.connect(), { code: 'server_proof_failed' });
  assert.equal(f.requests.length, 1);
});

test('closed proof socket cannot reconnect to transmit authenticated operation', async (t) => {
  const f = await fixture(t, undefined, { closeProof: true });
  await assert.rejects(f.client.connect());
  assert.equal(f.requests.length, 1);
});

test('restart refuses mutation on new instance', async (t) => {
  let id = INSTANCE;
  const f = await fixture(t, undefined, { instanceId: () => id });
  await f.client.connect(); id = randomUUID();
  await assert.rejects(f.client.recognize(INPUT), { code: 'server_identity_changed' });
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 0);
});

test('OCR sends one image, streams split UTF-8/CRLF, preserves exact identity and matches native metrics', async (t) => {
  let id;
  const f = await fixture(t, async (req, res, row) => {
    if (row.path === '/v1/chat/completions') {
      id = row.headers['x-request-id'];
      assert.equal(row.body.stream_options.include_usage, true);
      assert.equal(row.body.messages.length, 1);
      assert.equal(row.body.messages[0].content[0].image_url.url, INPUT.imageDataUrl);
      assert.equal(row.body.messages[0].content[1].text, INPUT.prompt);
      assert.equal(row.body.max_tokens, 2048);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': id });
      const bytes = Buffer.from(stream(id));
      for (let offset = 0; offset < bytes.length; offset += 7) { res.write(bytes.subarray(offset, offset + 7)); await delay(1); }
      res.end(); return true;
    }
    if (row.path === '/runtime/performance') { json(res, { instance_id: INSTANCE, capacity: 200, records: [record(id)] }); return true; }
    return false;
  });
  let text = '', acknowledged;
  const result = await f.client.recognize(INPUT, { onDelta: (delta) => text += delta, onRequest: (value) => acknowledged = value });
  assert.equal(text, '你好\n| 表格 |'); assert.equal(result.text, text);
  assert.equal(result.requestId, id); assert.equal(acknowledged, id);
  assert.equal(result.complete, true); assert.deepEqual(result.usage, USAGE);
  assert.equal(result.performance.performance.timings.decode_us, 2000);
  assert.equal(f.requests.filter((r) => r.path === '/v1/chat/completions').length, 1);
  assert.equal(f.requests.filter((r) => r.path === '/runtime/load-operations').length, 0);
});

test('unloaded registered pair gets owned load operation before OCR, preserving saved defaults', async (t) => {
  let operationId;
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path === '/runtime/status') { json(res, { ...READY, state: 'unloaded', selected_model: null }); return true; }
    if (row.path === '/runtime/load-operations') {
      operationId = row.body.operation_id; assert.equal(row.body.only_if_unloaded, true);
      assert.deepEqual(Object.keys(row.body).sort(), ['model', 'only_if_unloaded', 'operation_id']);
      json(res, { operation_id: operationId }); return true;
    }
    if (row.path === `/runtime/load-operations/${operationId}`) {
      json(res, { operation_id: operationId, model_id: MODEL.id, phase: 'finished', status: 'completed', terminal: true, runtime: READY }); return true;
    }
    return false;
  });
  assert.equal((await f.client.recognize(INPUT)).complete, true);
  assert.ok(f.requests.findIndex((r) => r.path === '/runtime/load-operations') < f.requests.findIndex((r) => r.path === '/v1/chat/completions'));
});

test('idle other model uses explicit owned switch and requested overrides', async (t) => {
  let operationId;
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path === '/runtime/status') { json(res, { ...READY, selected_model: 'other' }); return true; }
    if (row.path === '/runtime/load-operations') {
      operationId = row.body.operation_id; assert.equal(row.body.only_if_unloaded, false); assert.equal(row.body.threads, 3);
      json(res, { operation_id: operationId }); return true;
    }
    if (row.path === `/runtime/load-operations/${operationId}`) {
      json(res, { operation_id: operationId, model_id: MODEL.id, phase: 'finished', status: 'completed', terminal: true, runtime: { ...READY, load_options: { ...READY.load_options, threads: 3 } } }); return true;
    }
    return false;
  });
  await f.client.ensureModel(MODEL.id, { loadOptions: { threads: 3 } });
});

test('busy runtime is never switched or cancelled', async (t) => {
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path === '/runtime/status') { json(res, { ...READY, state: 'generating', active_request: randomUUID() }); return true; }
    return false;
  });
  await assert.rejects(f.client.recognize(INPUT), { code: 'runtime_busy' });
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 0);
  await assert.rejects(f.client.cancel(randomUUID()), { code: 'request_not_owned' });
});

test('disabled automatic load does not mutate backend', async (t) => {
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path === '/runtime/status') { json(res, { ...READY, state: 'unloaded' }); return true; }
    return false;
  });
  await assert.rejects(f.client.recognize({ ...INPUT, autoLoad: false }), { code: 'model_not_loaded' });
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 0);
});

test('missing projector fails before load or generation', async (t) => {
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path.startsWith('/runtime/models?')) { json(res, { data: [{ ...MODEL, has_projector: false }], next_after: null, generation: GENERATION }); return true; }
    return false;
  });
  await assert.rejects(f.client.recognize(INPUT), { code: 'model_unavailable' });
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 0);
});

test('stop during own loading cancels only opaque owned operation and waits for terminal cleanup', async (t) => {
  const controller = new AbortController(); let operationId, retired = false;
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path === '/runtime/status') { json(res, { ...READY, state: 'unloaded' }); return true; }
    if (row.path === '/runtime/load-operations') { operationId = row.body.operation_id; json(res, { operation_id: operationId }); return true; }
    if (row.path === `/runtime/load-operations/${operationId}/cancel`) { retired = true; json(res, { stopping: true }); return true; }
    if (row.path === `/runtime/load-operations/${operationId}`) {
      if (retired) { json(res, { operation_id: operationId, model_id: MODEL.id, phase: 'finished', status: 'cancelled', terminal: true }); return true; }
      json(res, { operation_id: operationId, model_id: MODEL.id, phase: 'loading', status: 'running', terminal: false });
      setTimeout(() => controller.abort(), 10); return true;
    }
    return false;
  });
  await assert.rejects(f.client.recognize(INPUT, { signal: controller.signal }), { code: 'request_cancelled', cleanupConfirmed: true });
  assert.ok(f.requests.some((r) => r.path === `/runtime/load-operations/${operationId}/cancel`));
  assert.equal(f.requests.filter((r) => r.path === '/v1/chat/completions').length, 0);
});

test('stop in stream retains partial output and explicitly cancels own request', async (t) => {
  const controller = new AbortController(); let id;
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path === '/v1/chat/completions') {
      id = row.headers['x-request-id']; res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': id });
      res.write(`data: ${JSON.stringify(chunk(id, { content: '部分结果' }))}\n\n`); return true;
    }
    return false;
  });
  await assert.rejects(f.client.recognize(INPUT, { signal: controller.signal, onDelta: () => controller.abort() }), (error) => {
    assert.equal(error.code, 'request_cancelled'); assert.equal(error.partialResult.text, '部分结果'); assert.equal(error.partialResult.complete, false); assert.equal(error.cleanupConfirmed, true); return true;
  });
  assert.ok(f.requests.some((r) => r.path === `/runtime/requests/${id}/cancel`));
  assert.equal(f.requests.filter((r) => r.path === '/v1/chat/completions').length, 1);
});

test('configurable timeout includes waiting for response headers and cancels known own UUID', async (t) => {
  let id;
  const f = await fixture(t, async (_req, _res, row) => {
    if (row.path === '/v1/chat/completions') { id = row.headers['x-request-id']; return true; }
    return false;
  }, { timeoutSeconds: 1 });
  const start = Date.now();
  await assert.rejects(f.client.recognize(INPUT), { code: 'client_timeout' });
  assert.ok(Date.now() - start < 4000);
  assert.ok(f.requests.some((r) => r.path === `/runtime/requests/${id}/cancel`));
});

for (const kind of ['missing-done', 'duplicate-terminal', 'done-before-terminal', 'data-after-done', 'wrong-id', 'invalid-utf8', 'socket-drop', 'stream-error']) {
  test(`malformed/incomplete stream (${kind}) never succeeds or replays`, async (t) => {
    const f = await fixture(t, async (_req, res, row) => {
      if (row.path !== '/v1/chat/completions') return false;
      const id = row.headers['x-request-id'];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': id });
      let wire = stream(id);
      if (kind === 'missing-done') wire = wire.replace('data: [DONE]\r\n\r\n', '');
      if (kind === 'duplicate-terminal') wire = wire.replace('data: [DONE]', `data: ${JSON.stringify(chunk(id, {}, 'stop'))}\r\n\r\ndata: [DONE]`);
      if (kind === 'done-before-terminal') wire = 'data: [DONE]\n\n';
      if (kind === 'data-after-done') wire += `data: ${JSON.stringify(chunk(id, { content: 'extra' }))}\n\n`;
      if (kind === 'wrong-id') wire = stream(randomUUID());
      if (kind === 'invalid-utf8') { res.end(Buffer.from([0xc0, 0xaf])); return true; }
      if (kind === 'socket-drop') { res.write(`data: ${JSON.stringify(chunk(id, { content: 'partial' }))}\n\n`); setTimeout(() => res.destroy(), 10); return true; }
      if (kind === 'stream-error') wire = `data: ${JSON.stringify(chunk(id, { content: 'partial' }))}\n\ndata: {"error":{"code":"execution_timeout","message":"secret text"}}\n\n`;
      res.end(wire); return true;
    });
    await assert.rejects(f.client.recognize(INPUT), (error) => {
      assert.ok(error instanceof NexaError); assert.equal(error.partialResult.complete, false); assert.ok(!error.message.includes('secret text')); return true;
    });
    assert.equal(f.requests.filter((r) => r.path === '/v1/chat/completions').length, 1);
  });
}

test('length finish remains usable text with explicit incomplete marker', async (t) => {
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path !== '/v1/chat/completions') return false;
    const id = row.headers['x-request-id']; res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': id }); res.end(stream(id, { finish: 'length' })); return true;
  });
  const result = await f.client.recognize(INPUT);
  assert.equal(result.finishReason, 'length'); assert.equal(result.complete, false); assert.ok(result.text);
});

for (const kind of ['wrong-instance', 'other-request', 'duplicate-request', 'wrong-usage', 'negative-timing']) {
  test(`performance (${kind}) is unavailable instead of attached to the wrong output`, async (t) => {
    let id;
    const f = await fixture(t, async (_req, res, row) => {
      if (row.path === '/v1/chat/completions') id = row.headers['x-request-id'];
      if (row.path !== '/runtime/performance') return false;
      const snapshot = { instance_id: INSTANCE, capacity: 200, records: [record(id)] };
      if (kind === 'wrong-instance') snapshot.instance_id = randomUUID();
      if (kind === 'other-request') snapshot.records[0].request_id = randomUUID();
      if (kind === 'duplicate-request') snapshot.records = [{ ...record(id), sequence: 2 }, record(id)];
      if (kind === 'wrong-usage') snapshot.records[0].usage.completion_tokens = 4;
      if (kind === 'negative-timing') snapshot.records[0].performance.timings.decode_us = -1;
      json(res, snapshot); return true;
    });
    const result = await f.client.recognize(INPUT);
    assert.equal(result.complete, true); assert.equal(result.performance, null);
  });
}

test('HTTP redirect is refused, never followed', async (t) => {
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path === '/runtime/status') { res.writeHead(302, { location: '/forbidden-target', 'content-type': 'application/json' }); res.end('{}'); return true; }
    return false;
  });
  await assert.rejects(f.client.connect(), { code: 'api_error', status: 302 });
  assert.ok(!f.requests.some((r) => r.path === '/forbidden-target'));
});

test('stop acknowledgement waits until the owned active request retires', async (t) => {
  const controller = new AbortController(); let id, stopAcknowledged = false, polls = 0;
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path === '/v1/chat/completions') {
      id = row.headers['x-request-id']; res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': id });
      res.write(`data: ${JSON.stringify(chunk(id, { content: 'part' }))}\n\n`); return true;
    }
    if (row.path === `/runtime/requests/${id}/cancel`) { stopAcknowledged = true; res.writeHead(204); res.end(); return true; }
    if (row.path === '/runtime/status' && stopAcknowledged) {
      polls++; json(res, polls < 3 ? { ...READY, state: 'generating', active_request: id } : READY); return true;
    }
    return false;
  });
  await assert.rejects(f.client.recognize(INPUT, { signal: controller.signal, onDelta: () => controller.abort() }), { code: 'request_cancelled', cleanupConfirmed: true });
  assert.equal(polls, 3);
});

test('unconfirmed native cleanup is explicit and cannot become a complete result', async (t) => {
  const controller = new AbortController(); let id, cancelled = false;
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path === '/v1/chat/completions') {
      id = row.headers['x-request-id']; res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': id });
      res.write(`data: ${JSON.stringify(chunk(id, { content: 'part' }))}\n\n`); return true;
    }
    if (row.path === `/runtime/requests/${id}/cancel`) { cancelled = true; res.writeHead(204); res.end(); return true; }
    if (row.path === '/runtime/status' && cancelled) { json(res, { ...READY, state: 'faulted', last_error: { code: 'executor_cleanup_unconfirmed' } }); return true; }
    return false;
  });
  await assert.rejects(f.client.recognize(INPUT, { signal: controller.signal, onDelta: () => controller.abort() }), (error) => {
    assert.equal(error.cleanupConfirmed, false); assert.equal(error.cleanupError, 'executor_cleanup_unconfirmed');
    assert.equal(error.partialResult.complete, false); assert.equal(error.partialResult.cleanupConfirmed, false); return true;
  });
});

test('models pagination follows generation-bound cursors before selecting model', async (t) => {
  const other = { ...MODEL, id: 'another' };
  const f = await fixture(t, async (_req, res, row) => {
    if (!row.path.startsWith('/runtime/models?')) return false;
    const query = new URL(row.path, 'http://127.0.0.1').searchParams;
    if (!query.has('after')) json(res, { data: [other], next_after: other.id, generation: GENERATION });
    else { assert.equal(query.get('after'), other.id); assert.equal(query.get('generation'), GENERATION); json(res, { data: [MODEL], next_after: null, generation: GENERATION }); }
    return true;
  });
  assert.deepEqual((await f.client.connect()).models, [other, MODEL]);
});

test('invalid input and faulted runtime never trigger model loading', async (t) => {
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path === '/runtime/status') { json(res, { ...READY, state: 'faulted' }); return true; }
    return false;
  });
  await assert.rejects(f.client.ensureModel(null), { code: 'invalid_model' });
  await assert.rejects(f.client.recognize({ ...INPUT, maxTokens: 4097 }), { code: 'invalid_max_tokens' });
  await assert.rejects(f.client.recognize(INPUT), { code: 'runtime_faulted' });
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 0);
});

test('output ceiling preserves a savable prefix smaller than one MiB', async (t) => {
  const f = await fixture(t, async (_req, res, row) => {
    if (row.path !== '/v1/chat/completions') return false;
    const id = row.headers['x-request-id']; res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': id });
    for (let n = 0; n < 17; n++) res.write(`data: ${JSON.stringify(chunk(id, { content: 'a'.repeat(64 * 1024) }))}\n\n`);
    res.end(); return true;
  });
  await assert.rejects(f.client.recognize(INPUT), (error) => {
    assert.equal(error.code, 'output_too_large'); assert.equal(Buffer.byteLength(error.partialResult.text), 1024 * 1024);
    assert.equal(error.partialResult.complete, false); return true;
  });
});
