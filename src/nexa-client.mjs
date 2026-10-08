import http from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const modelIdValid = (value) => typeof value === 'string' && MODEL_ID.test(value);
const JSON_LIMIT = 4 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;
const FRAME_LIMIT = 128 * 1024;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const natural = (v) => Number.isSafeInteger(v) && v >= 0;
const numbers = (v, keys) => object(v) && keys.every((k) => natural(v[k]));

export class NexaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NexaError';
    this.code = code;
    Object.assign(this, details);
  }
}

const invalid = (message = 'Nexa 返回的数据格式无效。') => new NexaError('invalid_response', message);
const cancelled = () => new NexaError('request_cancelled', '已停止识别。');
function abortError(signal) {
  return signal?.reason instanceof NexaError ? signal.reason : cancelled();
}
function checkAbort(signal) { if (signal?.aborted) throw abortError(signal); }
function safeError(error, signal) {
  if (error instanceof NexaError) return error;
  if (signal?.aborted) return abortError(signal);
  // Never forward Node errors containing URLs, headers, or caller-provided text.
  return new NexaError('connection_failed', '无法连接 Nexa，或连接已中断；请检查本机服务。');
}
function apiError(value, status) {
  const code = typeof value?.error?.code === 'string' && /^[a-z0-9_]{1,96}$/.test(value.error.code) ? value.error.code : 'api_error';
  const messages = {
    invalid_api_key: 'API 令牌无效，请使用 Nexa 的本机 API 令牌。',
    runtime_busy: 'Nexa 正忙，请等待当前任务完成后再试。',
    model_conflict: 'Nexa 当前模型已变化，请重新识别。',
    execution_timeout: 'Nexa 推理超时，请在 Nexa 设置中增加推理执行超时。',
    context_length_exceeded: '上下文容量不足，请增加模型上下文或减少输入及输出预算。',
    request_cancelled: '已停止识别。',
    request_not_found: '本次请求已结束或不存在。',
  };
  return new NexaError(code, messages[code] ?? `Nexa 请求失败（${code}）。`, { status });
}
function budget(seconds, parent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new NexaError('client_timeout', '插件等待超时；已停止本次请求，已有内容可能不完整。')), seconds * 1000);
  timer.unref?.();
  return { signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal, close: () => clearTimeout(timer) };
}

export function normalizeBaseUrl(value) {
  // Match the original authority before URL normalization (which accepts integer IPs).
  if (typeof value !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/?$/.test(value)) {
    throw new NexaError('invalid_address', '服务地址必须是 http://127.0.0.1:端口，仅支持本机 API。');
  }
  const match = value.match(/:([0-9]+)\/?$/);
  if (Number(match[1]) > 65535) throw new NexaError('invalid_address', '服务端口必须在 1–65535 之间。');
  return `http://127.0.0.1:${Number(match[1])}`;
}

function uniqueHeader(response, name) {
  const values = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    if (response.rawHeaders[i].toLowerCase() === name) values.push(response.rawHeaders[i + 1]);
  }
  if (values.length !== 1) throw invalid('Nexa 缺少必要响应头或响应头重复。');
  return values[0];
}
function endpoint(address, port) {
  if (address?.startsWith('::ffff:')) address = address.slice(7);
  if (address !== '127.0.0.1' || !Number.isInteger(port)) throw invalid('本机连接端点无效。');
  const bytes = Buffer.from([4, 127, 0, 0, 1, 0, 0]);
  bytes.writeUInt16BE(port, 5);
  return bytes;
}
async function collect(response, limit, signal) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response) {
    checkAbort(signal);
    size += chunk.length;
    if (size > limit) throw new NexaError('response_too_large', 'Nexa 响应超出插件限制。');
    chunks.push(chunk);
  }
  if (!response.complete) throw invalid('Nexa 响应未完整接收。');
  return Buffer.concat(chunks);
}
function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
}

/** One proof and one operation on the exact same TCP connection; never replay. */
class ProvedConnection {
  constructor(baseUrl, token, instanceId) {
    this.url = new URL(baseUrl);
    this.token = token;
    this.expectedInstance = instanceId;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  }
  close() { this.agent.destroy(); }
  raw(method, path, body, headers, signal, proved = false) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1', port: this.url.port || 80, method, path,
        agent: this.agent, maxHeaderSize: 16 * 1024,
        headers: { Host: `127.0.0.1:${this.url.port || 80}`, ...headers },
      });
      const onAbort = () => request.destroy(abortError(signal));
      signal?.addEventListener('abort', onAbort, { once: true });
      request.once('close', () => signal?.removeEventListener('abort', onAbort));
      request.once('error', reject);
      request.once('response', resolve);
      request.once('socket', (socket) => {
        if (proved && socket !== this.socket) {
          request.destroy(new NexaError('server_identity_changed', 'Nexa 连接发生变化，请重新连接。'));
          return;
        }
        if (!proved) this.socket = socket;
        request.end(body);
      });
      if (signal?.aborted) onAbort();
    });
  }
  async prove(signal) {
    const nonce = randomBytes(32);
    const scope = budget(5, signal);
    try {
      // Do not disclose the token until the endpoint proves knowledge of it.
      const response = await this.raw('GET', '/healthz', undefined, { 'X-Nexa-Server-Challenge': nonce.toString('hex') }, scope.signal);
      if (response.statusCode !== 200) throw new NexaError('server_proof_failed', '目标服务不是可验证的 Nexa 本机服务。');
      const id = uniqueHeader(response, 'x-nexa-instance-id');
      const proof = uniqueHeader(response, 'x-nexa-server-proof');
      if (!UUID.test(id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id) || !/^[a-f0-9]{64}$/.test(proof)
        || uniqueHeader(response, 'x-nexa-protocol-version') !== '1'
        || uniqueHeader(response, 'cache-control') !== 'no-store') throw new NexaError('server_proof_failed', 'Nexa 服务身份校验失败。');
      const version = Buffer.alloc(4); version.writeUInt32BE(1);
      const expected = createHmac('sha256', this.token).update(Buffer.concat([
        Buffer.from('Nexa/local-http/server-proof\0'), version, Buffer.from(id.replaceAll('-', ''), 'hex'), nonce,
        endpoint(this.socket.localAddress, this.socket.localPort), endpoint(this.socket.remoteAddress, this.socket.remotePort),
      ])).digest();
      if (!timingSafeEqual(expected, Buffer.from(proof, 'hex'))) throw new NexaError('server_proof_failed', 'Nexa 服务身份校验失败，请检查 API 令牌。');
      if (this.expectedInstance && this.expectedInstance !== id) throw new NexaError('server_identity_changed', 'Nexa 服务已重启，请重新连接后再识别。');
      await collect(response, 4096, scope.signal);
      this.instanceId = id;
      // A closed keepalive socket must fail, never create a second unproved socket.
      this.agent.createConnection = (_options, callback) => {
        callback(new NexaError('server_identity_changed', 'Nexa 已关闭已验证的连接，请重新连接。'));
      };
      return id;
    } finally { scope.close(); }
  }
  async request(method, path, data, signal, headers = {}) {
    const body = data === undefined ? undefined : Buffer.from(JSON.stringify(data));
    return this.raw(method, path, body, {
      Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json',
      'Content-Length': body?.length ?? 0, ...headers,
    }, signal, true);
  }
}

function validateStatus(status) {
  if (!object(status) || !['unloaded', 'loading', 'ready', 'generating', 'unloading', 'faulted'].includes(status.state)
    || !(status.selected_model === null || modelIdValid(status.selected_model))
    || !(status.active_request === null || UUID.test(status.active_request))
    || !natural(status.queued_jobs) || typeof status.stopping !== 'boolean' || typeof status.registry_busy !== 'boolean') throw invalid();
  return status;
}
function assertIdle(status) {
  if (status.stopping || status.registry_busy || status.active_request || status.queued_jobs > 0
    || ['generating', 'loading', 'unloading'].includes(status.state)) throw apiError({ error: { code: 'runtime_busy' } });
}
function validateOptions(options = {}) {
  if (!object(options) || Object.keys(options).some((key) => !['context_size', 'threads', 'batch_size'].includes(key))) throw new NexaError('invalid_options', '模型参数无效。');
  for (const [key, value] of Object.entries(options)) {
    const [min, max] = { context_size: [32, 131072], threads: [1, 256], batch_size: [1, 4096] }[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new NexaError('invalid_options', '模型参数超出支持范围。');
  }
  if (options.batch_size > options.context_size) throw new NexaError('invalid_options', '批次大小不能大于上下文。');
  return options;
}
function validPerformance(snapshot) {
  if (!object(snapshot) || !UUID.test(snapshot.instance_id) || !natural(snapshot.capacity) || snapshot.capacity < 1 || snapshot.capacity > 200
    || !Array.isArray(snapshot.records) || snapshot.records.length > snapshot.capacity) throw invalid();
  let previous = Infinity;
  for (const r of snapshot.records) {
    if (!object(r) || !natural(r.sequence) || r.sequence === 0 || r.sequence >= previous || !UUID.test(r.request_id) || !modelIdValid(r.model_id)
      || !['text', 'image'].includes(r.modality) || !['completed', 'cancelled', 'failed'].includes(r.status)
      || !natural(r.accepted_at_unix_ms) || !natural(r.max_output_tokens) || r.max_output_tokens < 1
      || !numbers(r.usage, ['prompt_tokens', 'completion_tokens']) || r.usage.completion_tokens > r.max_output_tokens
      || !numbers(r.timings, ['queue_ms', 'load_ms', 'execution_ms']) || !Number.isSafeInteger(r.timings.queue_ms + r.timings.load_ms + r.timings.execution_ms)
      || !(r.error_code === null || typeof r.error_code === 'string' && /^[a-z0-9_]{1,96}$/.test(r.error_code)) || ![null, 'stop', 'length'].includes(r.finish_reason)) throw invalid();
    const p = r.performance;
    if (r.status === 'completed' ? r.error_code !== null || r.finish_reason === null : p !== null || r.finish_reason !== null || r.error_code === null) throw invalid();
    if (p !== null) {
      if (!object(p) || !numbers(p.timings, ['prepare_us', 'prefill_us', 'decode_us', 'output_callback_us'])
        || !Number.isSafeInteger(Object.values(p.timings).reduce((a, b) => a + b, 0)) || r.usage.prompt_tokens === 0) throw invalid();
      validateOptions(p.load_options);
      if (!numbers(p.load_options, ['context_size', 'threads', 'batch_size'])) throw invalid();
    }
    previous = r.sequence;
  }
  return snapshot;
}

export class NexaClient {
  #token;
  #active = false;
  #owned = new Set();
  constructor({ baseUrl, token, timeoutSeconds = 1800 }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token.trim())) throw new NexaError('invalid_token', '请填写 Nexa 本机 API 的 64 位令牌。');
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) throw new NexaError('invalid_timeout', '等待超时必须为 1–86400 秒。');
    this.#token = token.trim();
    this.timeoutSeconds = timeoutSeconds;
    this.instanceId = null;
    this.config = null;
  }
  async #connection(signal) {
    const connection = new ProvedConnection(this.baseUrl, this.#token, this.instanceId);
    try {
      const id = await connection.prove(signal);
      // Concurrent first reads may only bind to the same instance.
      if (this.instanceId && id !== this.instanceId) throw new NexaError('server_identity_changed', 'Nexa 服务已变化，请重新连接。');
      this.instanceId = id;
      return connection;
    } catch (e) { connection.close(); throw safeError(e, signal); }
  }
  async #json(method, path, data, { signal, timeoutSeconds = Math.min(30, this.timeoutSeconds) } = {}) {
    const scope = budget(timeoutSeconds, signal);
    let connection;
    try {
      connection = await this.#connection(scope.signal);
      const response = await connection.request(method, path, data, scope.signal);
      const bytes = await collect(response, JSON_LIMIT, scope.signal);
      const value = bytes.length ? parseJson(bytes) : null;
      if (response.statusCode < 200 || response.statusCode >= 300) throw apiError(value, response.statusCode);
      return value;
    } catch (e) { throw safeError(e, scope.signal); }
    finally { scope.close(); connection?.close(); }
  }
  async status({ signal } = {}) { return validateStatus(await this.#json('GET', '/runtime/status', undefined, { signal })); }
  async #models(signal) {
    const models = [], seen = new Set();
    let after = null, generation;
    for (let page = 0; page < 32; page++) {
      const query = new URLSearchParams({ limit: '128' });
      if (after) { query.set('after', after); query.set('generation', generation); }
      const value = await this.#json('GET', `/runtime/models?${query}`, undefined, { signal });
      if (!object(value) || !Array.isArray(value.data) || value.data.length > 128 || !UUID.test(value.generation)
        || generation && value.generation !== generation) throw invalid();
      generation = value.generation;
      for (const model of value.data) {
        if (!object(model) || !modelIdValid(model.id) || seen.has(model.id) || typeof model.display_name !== 'string'
          || typeof model.available !== 'boolean' || typeof model.loadable !== 'boolean' || typeof model.has_projector !== 'boolean') throw invalid();
        seen.add(model.id); models.push(model);
      }
      if (value.next_after === null) return models;
      if (!modelIdValid(value.next_after) || after === value.next_after || value.data.at(-1)?.id !== value.next_after) throw invalid();
      after = value.next_after;
    }
    throw new NexaError('model_list_too_large', '模型列表超过插件支持的 4096 个模型。');
  }
  async connect({ signal } = {}) {
    const status = await this.status({ signal });
    const models = await this.#models(signal);
    this.config = await this.#json('GET', '/runtime/configuration', undefined, { signal });
    if (!object(this.config) || !object(this.config.runtime_effective) || !natural(this.config.runtime_effective.chat_response_timeout_seconds)) throw invalid();
    return { instanceId: this.instanceId, status, models, config: this.config };
  }
  async ensureModel(modelId, { signal, onPhase = () => {}, loadOptions = {}, autoLoad = true } = {}) {
    if (!modelIdValid(modelId)) throw new NexaError('invalid_model', '请选择已登记的 OCR 模型。');
    validateOptions(loadOptions);
    const scope = budget(this.timeoutSeconds, signal);
    let operationId;
    try {
      onPhase('checking_model');
      const status = await this.status({ signal: scope.signal });
      assertIdle(status);
      if (status.state === 'faulted') throw new NexaError('runtime_faulted', 'Nexa 处于故障状态，请先在 Nexa 中查看错误并显式重新加载模型。');
      const models = await this.#models(scope.signal);
      const model = models.find((entry) => entry.id === modelId);
      if (!model?.available || !model.loadable || !model.has_projector) throw new NexaError('model_unavailable', '目标模型不可用或未配对 mmproj，请先在 Nexa 中导入完整 OCR 模型。');
      if (status.state === 'ready' && status.selected_model === modelId
        && Object.entries(loadOptions).every(([key, value]) => status.load_options?.[key] === value)) return status;
      if (!autoLoad) throw new NexaError('model_not_loaded', '自动加载已关闭，请先在 Nexa 中加载所选模型。');
      operationId = randomUUID();
      onPhase(status.selected_model && status.selected_model !== modelId ? 'switching_model' : 'loading');
      const started = await this.#json('POST', '/runtime/load-operations', {
        operation_id: operationId, model: modelId, only_if_unloaded: status.selected_model === null, ...loadOptions,
      }, { signal: scope.signal });
      if (started?.operation_id !== operationId) throw invalid();
      while (true) {
        const state = await this.#json('GET', `/runtime/load-operations/${operationId}`, undefined, { signal: scope.signal });
        if (!object(state) || state.operation_id !== operationId || state.model_id !== modelId || typeof state.terminal !== 'boolean'
          || !['preparing', 'loading', 'testing', 'finished'].includes(state.phase)
          || !['running', 'cancelling', 'completed', 'cancelled', 'failed'].includes(state.status)) throw invalid();
        onPhase(state.phase);
        if (state.terminal) {
          if (state.status !== 'completed') throw apiError({ error: state.error ?? { code: state.status === 'cancelled' ? 'request_cancelled' : 'load_failed' } });
          const ready = validateStatus(state.runtime);
          if (ready.state !== 'ready' || ready.selected_model !== modelId) throw invalid();
          return ready;
        }
        if (!['running', 'cancelling'].includes(state.status)) throw invalid();
        await delay(300, undefined, { signal: scope.signal });
      }
    } catch (error) {
      // The UUID belongs to this caller even if its acknowledgement was lost.
      const result = safeError(error, scope.signal);
      if (operationId) result.cleanupConfirmed = await this.#retireLoad(operationId, modelId);
      throw result;
    } finally { scope.close(); }
  }
  async cancel(requestId) {
    if (!this.#owned.has(requestId)) throw new NexaError('request_not_owned', '只能停止本插件发起的当前请求。');
    return this.#json('POST', `/runtime/requests/${requestId}/cancel`, undefined, { timeoutSeconds: 5 });
  }
  async #retireLoad(operationId, modelId) {
    const scope = budget(Math.min(30, this.timeoutSeconds));
    try {
      await this.#json('POST', `/runtime/load-operations/${operationId}/cancel`, undefined, { signal: scope.signal });
      while (true) {
        const state = await this.#json('GET', `/runtime/load-operations/${operationId}`, undefined, { signal: scope.signal });
        if (state?.operation_id !== operationId || state.model_id !== modelId) return false;
        if (state.terminal === true) return ['completed', 'cancelled', 'failed'].includes(state.status)
          && state.error?.code !== 'executor_cleanup_unconfirmed';
        await delay(100, undefined, { signal: scope.signal });
      }
    } catch { return false; }
    finally { scope.close(); }
  }
  async #retireRequest(requestId) {
    const scope = budget(Math.min(30, this.timeoutSeconds));
    try {
      await this.#json('POST', `/runtime/requests/${requestId}/cancel`, undefined, { signal: scope.signal });
      while (true) {
        const status = await this.status({ signal: scope.signal });
        if (status.active_request !== requestId) return status.last_error?.code !== 'executor_cleanup_unconfirmed';
        await delay(100, undefined, { signal: scope.signal });
      }
    } catch { return false; }
    finally { scope.close(); }
  }
  async performance(requestId, { signal, modelId, maxTokens, usage, finishReason } = {}) {
    if (!UUID.test(requestId) || !this.instanceId) return null;
    try {
      const snapshot = validPerformance(await this.#json('GET', '/runtime/performance', undefined, { signal }));
      if (snapshot.instance_id !== this.instanceId) return null;
      const rows = snapshot.records.filter((r) => r.request_id === requestId);
      const r = rows[0];
      if (rows.length !== 1 || r.model_id !== modelId || r.modality !== 'image' || r.max_output_tokens !== maxTokens
        || r.status !== 'completed' || r.finish_reason !== finishReason || !usage
        || r.usage.prompt_tokens !== usage.prompt_tokens || r.usage.completion_tokens !== usage.completion_tokens
        || usage.total_tokens !== r.usage.prompt_tokens + r.usage.completion_tokens) return null;
      return r;
    } catch { return null; }
  }
  async recognize({ modelId, imageDataUrl, prompt, maxTokens, loadOptions, autoLoad = true }, { signal, onDelta = () => {}, onPhase = () => {}, onRequest = () => {} } = {}) {
    if (this.#active) throw apiError({ error: { code: 'runtime_busy' } });
    if (typeof imageDataUrl !== 'string' || imageDataUrl.length > 5_592_440 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataUrl)
      || Buffer.from(imageDataUrl.split(',')[1], 'base64').length > 4 * 1024 * 1024) throw new NexaError('invalid_image', '请选择不超过 4 MiB 的 PNG 或 JPEG 图片。');
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 32 * 1024) throw new NexaError('invalid_prompt', '请填写有效的 OCR 提示词（不超过 32 KiB）。');
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new NexaError('invalid_max_tokens', '最大输出 token 必须为 1–4096。');
    this.#active = true;
    const scope = budget(this.timeoutSeconds, signal);
    const partial = { instanceId: this.instanceId, requestId: null, text: '', finishReason: null, usage: null, performance: null, complete: false, cleanupConfirmed: true };
    let connection, requestedId;
    try {
      await this.ensureModel(modelId, { signal: scope.signal, onPhase, loadOptions, autoLoad });
      checkAbort(scope.signal);
      onPhase('prefill');
      connection = await this.#connection(scope.signal);
      partial.instanceId = connection.instanceId;
      requestedId = randomUUID();
      this.#owned.add(requestedId);
      const response = await connection.request('POST', '/v1/chat/completions', {
        model: modelId, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: imageDataUrl } }, { type: 'text', text: prompt }] }],
        stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, temperature: 0,
      }, scope.signal, { 'X-Request-ID': requestedId });
      if (uniqueHeader(response, 'x-request-id') !== requestedId) throw invalid('Nexa 返回了不匹配的请求 ID。');
      partial.requestId = requestedId;
      onRequest(requestedId);
      if (response.statusCode !== 200) throw apiError(parseJson(await collect(response, JSON_LIMIT, scope.signal)), response.statusCode);
      if (!/^text\/event-stream(?:;|$)/i.test(uniqueHeader(response, 'content-type'))) throw invalid('Nexa 未返回 SSE 数据流。');
      let finished = false, done = false, gotUsage = false, buffer = '', wireSize = 0, textBytes = 0, decoding = false;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const consume = (frame) => {
        const lines = frame.split(/\r?\n/);
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) return;
        if (done) throw invalid('结束标记后仍收到推理数据。');
        if (data === '[DONE]') {
          if (!finished || !gotUsage) throw invalid('Nexa 输出缺少终态或 token 用量。');
          done = true; return;
        }
        let value;
        try { value = JSON.parse(data); } catch { throw invalid(); }
        if (value?.error) throw apiError(value, 200);
        if (!object(value) || value.id !== `chatcmpl-${requestedId}` || value.model !== modelId || value.object !== 'chat.completion.chunk' || !Array.isArray(value.choices)) throw invalid();
        if (value.usage !== undefined) {
          if (!finished || gotUsage || value.choices.length !== 0 || !numbers(value.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens'])
            || value.usage.completion_tokens > maxTokens || value.usage.total_tokens !== value.usage.prompt_tokens + value.usage.completion_tokens) throw invalid();
          partial.usage = value.usage; gotUsage = true; return;
        }
        if (finished || value.choices.length !== 1) throw invalid('Nexa 返回重复终态或无效输出。');
        const choice = value.choices[0];
        if (!object(choice) || choice.index !== 0 || !object(choice.delta) || ![null, 'stop', 'length'].includes(choice.finish_reason)) throw invalid();
        if (choice.delta.role !== undefined && choice.delta.role !== 'assistant') throw invalid();
        if (choice.delta.content !== undefined) {
          if (typeof choice.delta.content !== 'string' || choice.finish_reason !== null) throw invalid();
          textBytes += Buffer.byteLength(choice.delta.content);
          if (textBytes > TEXT_LIMIT) throw new NexaError('output_too_large', '识别结果超过插件的 1 MiB 上限。');
          partial.text += choice.delta.content;
          if (!decoding) { decoding = true; onPhase('decode'); }
          onDelta(choice.delta.content);
        }
        if (choice.finish_reason !== null) { finished = true; partial.finishReason = choice.finish_reason; }
      };
      const drain = () => {
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, separator.index);
          if (Buffer.byteLength(frame) > FRAME_LIMIT) throw invalid('SSE 事件超出限制。');
          buffer = buffer.slice(separator.index + separator[0].length);
          consume(frame);
        }
        if (Buffer.byteLength(buffer) > FRAME_LIMIT) throw invalid('SSE 事件超出限制。');
      };
      for await (const chunk of response) {
        checkAbort(scope.signal);
        wireSize += chunk.length;
        if (wireSize > 32 * 1024 * 1024) throw new NexaError('output_too_large', '识别数据流超出插件限制。');
        try { buffer += decoder.decode(chunk, { stream: true }); } catch { throw invalid('Nexa 返回无效 UTF-8。'); }
        drain();
      }
      try { buffer += decoder.decode(); } catch { throw invalid('Nexa 返回截断的 UTF-8。'); }
      drain();
      if (!response.complete || buffer.trim() || !done) throw new NexaError('incomplete_stream', 'Nexa 输出中断，已生成内容可能不完整。');
      partial.complete = partial.finishReason === 'stop';
      connection.close(); connection = null;
      this.#owned.delete(requestedId);
      partial.performance = await this.performance(requestedId, { signal: scope.signal, modelId, maxTokens, usage: partial.usage, finishReason: partial.finishReason });
      onPhase('finished');
      return partial;
    } catch (error) {
      connection?.close(); connection = null;
      if (requestedId && this.#owned.has(requestedId)) partial.cleanupConfirmed = await this.#retireRequest(requestedId);
      else if (error.cleanupConfirmed === false) partial.cleanupConfirmed = false;
      const result = safeError(error, scope.signal);
      result.cleanupConfirmed = partial.cleanupConfirmed;
      if (!partial.cleanupConfirmed) result.cleanupError = 'executor_cleanup_unconfirmed';
      result.partialResult = partial;
      throw result;
    } finally {
      connection?.close(); scope.close();
      if (requestedId) this.#owned.delete(requestedId);
      this.#active = false;
    }
  }
}
