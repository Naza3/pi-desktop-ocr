import http from 'node:http';
import { randomUUID } from 'node:crypto';

const JSON_LIMIT = 4 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;
const FRAME_LIMIT = 128 * 1024;
const WIRE_LIMIT = 32 * 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const natural = (value) => Number.isSafeInteger(value) && value >= 0;
const validModel = (value) => typeof value === 'string' && value.length <= 256 && /^[^\s\x00-\x1f\x7f]+$/u.test(value);

export class OpenAIError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OpenAIError';
    this.code = code;
    Object.assign(this, details);
  }
}

const invalid = (message = 'OCR 服务返回的数据格式无效。') => new OpenAIError('invalid_response', message);
function aborted(signal) {
  if (signal?.reason instanceof OpenAIError) return signal.reason;
  if (signal?.reason?.code === 'persistence_failed') return new OpenAIError('persistence_failed', '识别结果保存失败，已断开本次请求。');
  return new OpenAIError('request_cancelled', '已断开识别请求；通用 API 无法确认服务端任务已停止。');
}
function checkAbort(signal) { if (signal?.aborted) throw aborted(signal); }
function safeError(error, signal) {
  if (error instanceof OpenAIError) return error;
  if (signal?.aborted) return aborted(signal);
  // Native errors can include caller-controlled paths, headers, or response bytes.
  return new OpenAIError('connection_failed', '无法连接 OCR 服务，或连接已中断；请检查本机服务。');
}
function httpError(status) {
  if (status >= 300 && status < 400) return new OpenAIError('redirect_refused', 'OCR 服务要求重定向；请直接填写本机 API 地址。', { status });
  const messages = {
    400: ['invalid_request', 'OCR 服务拒绝了请求，请检查模型、图片、提示词及输出 token 预算。'],
    401: ['invalid_api_key', 'API 密钥无效，请检查服务的认证设置。'],
    403: ['access_denied', 'OCR 服务拒绝访问，请检查 API 密钥及服务权限。'],
    404: ['endpoint_not_found', '未找到 OCR 接口或模型，请检查 API 地址和模型 ID。'],
    413: ['image_too_large', 'OCR 服务拒绝了过大的请求，请缩小图片后再试。'],
    429: ['service_busy', 'OCR 服务正忙或已达到请求限额，请稍后重试。'],
  };
  const [code, message] = messages[status] ?? ['api_error', `OCR 服务请求失败（HTTP ${Number.isInteger(status) ? status : '未知'}）。`];
  return new OpenAIError(code, message, { status });
}
function budget(seconds, parent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new OpenAIError('client_timeout', '等待 OCR 服务超时，已断开请求；无法确认服务端任务已停止，已有内容可能不完整。')), seconds * 1000);
  timer.unref?.();
  return { signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal, close: () => clearTimeout(timer) };
}

export function normalizeOpenAIBaseUrl(value) {
  // Match before URL parsing: integer IPs, credentials, encoded paths, queries,
  // and implicit ports must never broaden the plugin's loopback permission.
  const match = typeof value === 'string' && /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})(?:\/v1)?\/?$/.exec(value);
  if (!match) throw new OpenAIError('invalid_address', 'API 地址必须是 http://127.0.0.1:端口/v1，仅支持本机 HTTP 服务。');
  if (Number(match[1]) > 65535) throw new OpenAIError('invalid_address', '服务端口必须在 1–65535 之间。');
  return `http://127.0.0.1:${Number(match[1])}/v1`;
}

function contentType(response, expected) {
  const values = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    if (response.rawHeaders[i].toLowerCase() === 'content-type') values.push(response.rawHeaders[i + 1]);
  }
  return values.length === 1 && values[0].split(';')[0].trim().toLowerCase() === expected;
}
function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
}
async function collect(response, signal) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response) {
    checkAbort(signal);
    length += chunk.length;
    if (length > JSON_LIMIT) throw new OpenAIError('response_too_large', 'OCR 服务响应超过插件的 4 MiB 上限。');
    chunks.push(chunk);
  }
  if (!response.complete) throw invalid('OCR 服务响应未完整接收。');
  return Buffer.concat(chunks);
}
function usageFrom(value, maxTokens) {
  if (!object(value) || !['prompt_tokens', 'completion_tokens', 'total_tokens'].every((key) => natural(value[key]))
    || value.completion_tokens > maxTokens || !Number.isSafeInteger(value.prompt_tokens + value.completion_tokens)
    || value.total_tokens !== value.prompt_tokens + value.completion_tokens) throw invalid('OCR 服务返回了无效的 token 用量。');
  return { prompt_tokens: value.prompt_tokens, completion_tokens: value.completion_tokens, total_tokens: value.total_tokens };
}
function validateInput(input) {
  if (!object(input)) throw new OpenAIError('invalid_request', 'OCR 请求参数无效。');
  const { modelId, imageDataUrl, prompt, maxTokens } = input;
  if (!validModel(modelId)) throw new OpenAIError('invalid_model', '请填写有效的模型 ID（最多 256 个字符，不含空白）。');
  if (typeof imageDataUrl !== 'string' || imageDataUrl.length > 5_592_440 || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataUrl)) {
    throw new OpenAIError('invalid_image', '请选择不超过 4 MiB 的 PNG 或 JPEG 图片。');
  }
  const encoded = imageDataUrl.slice(imageDataUrl.indexOf(',') + 1);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > 4 * 1024 * 1024 || bytes.toString('base64') !== encoded) throw new OpenAIError('invalid_image', '图片编码无效，或超过 4 MiB 上限。');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16384 || Buffer.byteLength(prompt) > 32 * 1024) throw new OpenAIError('invalid_prompt', '请填写有效的 OCR 提示词（最多 16384 个字符且不超过 32 KiB）。');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) throw new OpenAIError('invalid_max_tokens', '最大输出 token 必须为 1–32768，且不能超过模型支持的容量。');
}

/** Bounded, non-retrying OpenAI-compatible requests to an explicitly chosen local server. */
export class OpenAIClient {
  #token;
  #active = false;
  constructor({ baseUrl = 'http://127.0.0.1:8080/v1', token = '', timeoutSeconds = 1800 } = {}) {
    this.baseUrl = normalizeOpenAIBaseUrl(baseUrl);
    if (typeof token !== 'string' || token.length > 4096 || !/^[\x20-\x7e]*$/.test(token)) throw new OpenAIError('invalid_token', 'API 密钥必须不超过 4096 个可打印 ASCII 字符，且不能包含换行。');
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) throw new OpenAIError('invalid_timeout', '等待超时必须为 1–86400 秒。');
    this.#token = token.trim();
    this.timeoutSeconds = timeoutSeconds;
    this.instanceId = null;
  }

  #request(method, path, data, signal) {
    checkAbort(signal);
    const url = new URL(this.baseUrl);
    const bytes = data === undefined ? undefined : Buffer.from(JSON.stringify(data));
    if (bytes?.length > 6 * 1024 * 1024) throw new OpenAIError('request_too_large', 'OCR 请求超过插件的 6 MiB 上限。');
    let request;
    const response = new Promise((resolve, reject) => {
      request = http.request({
        hostname: '127.0.0.1', port: Number(url.port) || 80, method, path: `/v1${path}`,
        agent: false, maxHeaderSize: 16 * 1024,
        headers: {
          Accept: data === undefined ? 'application/json' : 'text/event-stream',
          ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
          ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        },
      });
      const onAbort = () => request.destroy(aborted(signal));
      signal?.addEventListener('abort', onAbort, { once: true });
      request.once('close', () => signal?.removeEventListener('abort', onAbort));
      request.once('error', reject);
      request.once('response', resolve);
      if (signal?.aborted) onAbort();
      else request.end(bytes);
    });
    return { response, close: () => request?.destroy() };
  }

  async connect({ signal } = {}) {
    const scope = budget(Math.min(30, this.timeoutSeconds), signal);
    let connection;
    try {
      connection = this.#request('GET', '/models', undefined, scope.signal);
      const response = await connection.response;
      let models = [];
      if (![404, 405].includes(response.statusCode)) {
        if (response.statusCode !== 200) throw httpError(response.statusCode);
        if (!contentType(response, 'application/json')) throw invalid('模型列表接口未返回 JSON。');
        const value = parseJson(await collect(response, scope.signal));
        if (!object(value) || !Array.isArray(value.data) || value.data.length > 4096) throw invalid('模型列表格式无效或数量超过限制。');
        const seen = new Set();
        models = value.data.map((model) => {
          if (!object(model) || !validModel(model.id) || seen.has(model.id)) throw invalid('模型列表中存在无效或重复的模型 ID。');
          seen.add(model.id);
          return { id: model.id, display_name: model.id, loadable: true, available: true };
        });
      }
      return { instanceId: null, status: { state: 'ready', active_request: null, queued_jobs: 0 }, models };
    } catch (error) { throw safeError(error, scope.signal); }
    finally { connection?.close(); scope.close(); }
  }

  async recognize(input, { signal, onDelta = () => {}, onPhase = () => {}, onRequest = () => {} } = {}) {
    if (this.#active) throw new OpenAIError('runtime_busy', '已有识别请求正在运行，请等待结束或先停止。');
    validateInput(input);
    const { modelId, imageDataUrl, prompt, maxTokens } = input;
    this.#active = true;
    const scope = budget(this.timeoutSeconds, signal);
    const partial = { instanceId: null, requestId: randomUUID(), text: '', complete: false, finishReason: null, usage: null, performance: null, cleanupConfirmed: true };
    let connection, dispatched = false, rejected = false;
    try {
      checkAbort(scope.signal);
      onPhase('generating');
      onRequest(partial.requestId); // A local correlation ID, not a server cancellation capability.
      connection = this.#request('POST', '/chat/completions', {
        model: modelId,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: imageDataUrl } }, { type: 'text', text: prompt }] }],
        stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, temperature: 0,
      }, scope.signal);
      dispatched = true;
      const response = await connection.response;
      if (response.statusCode !== 200) { rejected = true; throw httpError(response.statusCode); }
      if (!contentType(response, 'text/event-stream')) throw invalid('OCR 接口未返回 SSE 数据流，请检查服务是否支持流式图片输入。');
      let finished = false, done = false, decoding = false, buffer = '', wireSize = 0, textBytes = 0, eventCount = 0, streamId;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const consume = (frame) => {
        if (++eventCount > 100000) throw invalid('OCR 数据流事件数量超过限制。');
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) return; // Heartbeats and standard SSE metadata are not generated text.
        if (done) throw invalid('结束标记后仍收到推理数据。');
        if (data === '[DONE]') {
          if (!finished) throw invalid('OCR 输出缺少结束原因。');
          done = true;
          return;
        }
        let value;
        try { value = JSON.parse(data); } catch { throw invalid(); }
        if (value?.error) throw new OpenAIError('api_error', 'OCR 服务在识别过程中返回错误，已有内容可能不完整。');
        if (!object(value) || !Array.isArray(value.choices) || value.choices.length > 1
          || value.object !== undefined && value.object !== 'chat.completion.chunk') throw invalid();
        if (value.id !== undefined) {
          if (typeof value.id !== 'string' || value.id.length > 512 || !value.id || streamId !== undefined && streamId !== value.id) throw invalid('OCR 数据流标识发生变化。');
          streamId = value.id;
        }
        if (value.choices.length) {
          const choice = value.choices[0];
          if (finished || !object(choice) || choice.index !== 0 || !object(choice.delta)
            || ![undefined, null, 'stop', 'length', 'content_filter'].includes(choice.finish_reason)) throw invalid('OCR 服务返回了重复终态或不支持的输出类型。');
          if (choice.delta.role !== undefined && choice.delta.role !== 'assistant' || choice.delta.tool_calls !== undefined || choice.delta.function_call !== undefined) throw invalid('OCR 服务返回了不支持的工具调用或角色。');
          if (choice.delta.content !== undefined && choice.delta.content !== null) {
            if (typeof choice.delta.content !== 'string') throw invalid();
            textBytes += Buffer.byteLength(choice.delta.content);
            if (textBytes > TEXT_LIMIT) throw new OpenAIError('output_too_large', '识别结果超过插件的 1 MiB 上限。');
            partial.text += choice.delta.content;
            if (choice.delta.content) {
              if (!decoding) { decoding = true; onPhase('decode'); }
              onDelta(choice.delta.content);
            }
          }
          if (choice.finish_reason != null) { finished = true; partial.finishReason = choice.finish_reason; }
        } else if (value.usage == null) throw invalid('OCR 数据流包含空输出事件。');
        if (value.usage != null) partial.usage = usageFrom(value.usage, maxTokens);
      };
      const drain = () => {
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, separator.index);
          if (Buffer.byteLength(frame) > FRAME_LIMIT) throw invalid('SSE 事件超过 128 KiB 上限。');
          buffer = buffer.slice(separator.index + separator[0].length);
          consume(frame);
        }
        if (Buffer.byteLength(buffer) > FRAME_LIMIT) throw invalid('SSE 事件超过 128 KiB 上限。');
      };
      for await (const chunk of response) {
        checkAbort(scope.signal);
        wireSize += chunk.length;
        if (wireSize > WIRE_LIMIT) throw new OpenAIError('response_too_large', 'OCR 数据流超过插件的 32 MiB 上限。');
        try { buffer += decoder.decode(chunk, { stream: true }); } catch { throw invalid('OCR 服务返回了无效 UTF-8。'); }
        drain();
      }
      try { buffer += decoder.decode(); } catch { throw invalid('OCR 服务返回了截断的 UTF-8。'); }
      drain();
      if (!response.complete || buffer.trim() || !done) throw new OpenAIError('incomplete_stream', 'OCR 输出中断，已生成内容可能不完整。');
      checkAbort(scope.signal);
      partial.complete = partial.finishReason === 'stop';
      onPhase('finished');
      return partial;
    } catch (error) {
      const result = safeError(error, scope.signal);
      partial.cleanupConfirmed = !dispatched || rejected;
      result.cleanupConfirmed = partial.cleanupConfirmed;
      if (!partial.cleanupConfirmed) result.cleanupError = 'executor_cleanup_unconfirmed';
      result.partialResult = partial;
      throw result;
    } finally { connection?.close(); scope.close(); this.#active = false; }
  }
}
