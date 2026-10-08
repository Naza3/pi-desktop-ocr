import { randomUUID } from 'node:crypto';
import { createClient } from './backends.ts';
import { normalizeSettings, normalizeToken, capabilitiesFor, fail } from './settings.ts';
import { MAX_TEXT_BYTES, Store } from './store.ts';
import type { BackendClient, ClientOptions, HistoryResult, OcrResult, PerformanceRecord, Usage, Payload, QueueItem, QueueMetadata, Reply, Channel, Snapshot } from '../shared/contracts.ts';
import type { PiHost } from '../types/host.ts';

type MutationChannel = Exclude<Channel, 'ocr.snapshot' | 'ocr.result'>;
type MutationHandlers = { [C in MutationChannel]: (payload: Record<string, unknown>) => Promise<Reply<C>> };
function hasOwnKey<T extends object>(value: T, key: string): key is Extract<keyof T, string> { return Object.hasOwn(value, key); }
type Upload = Payload<'ocr.image.begin'> & { id: string; chunks: string[]; received: number; updatedAt: number };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function errorCode(error: unknown): unknown { return object(error) ? error.code : undefined; }

const CHUNK = 196608;
const MAX_DATA = 5592440;
const MAX_IMAGE = 4 * 1024 * 1024;
function message(error: unknown): string {
  if (object(error) && typeof error.code === 'string' && /^[a-z_]+$/.test(error.code) && typeof error.message === 'string') return error.message;
  if (errorCode(error) === 'PERMISSION_DENIED') return '插件权限未授予，请在 PI 插件页面允许本机网络或所需文件操作。';
  return '操作未完成，请检查本机服务、插件数据目录权限或可用磁盘空间。';
}
function natural(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function numberFields<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, number> {
  return object(value) && keys.every(key => natural(value[key]));
}
function partialUsage(value: unknown): Usage | undefined {
  if (!object(value) || !natural(value.prompt_tokens) || !natural(value.completion_tokens)
    || value.total_tokens !== undefined && !natural(value.total_tokens)) return undefined;
  const usage: Usage = { prompt_tokens: value.prompt_tokens, completion_tokens: value.completion_tokens };
  if (value.total_tokens !== undefined) usage.total_tokens = value.total_tokens;
  return usage;
}
function partialPerformance(value: unknown): PerformanceRecord | undefined {
  if (!object(value) || !natural(value.sequence) || typeof value.request_id !== 'string' || typeof value.model_id !== 'string'
    || value.modality !== 'text' && value.modality !== 'image'
    || value.status !== 'completed' && value.status !== 'cancelled' && value.status !== 'failed'
    || !natural(value.accepted_at_unix_ms) || !natural(value.max_output_tokens)
    || value.error_code !== null && typeof value.error_code !== 'string'
    || value.finish_reason !== null && value.finish_reason !== 'stop' && value.finish_reason !== 'length'
    || !numberFields(value.timings, ['queue_ms', 'load_ms', 'execution_ms'])) return undefined;
  const usage = partialUsage(value.usage);
  if (!usage) return undefined;
  let performance: PerformanceRecord['performance'] = null;
  if (value.performance !== null) {
    if (!object(value.performance)
      || !numberFields(value.performance.timings, ['prepare_us', 'prefill_us', 'decode_us', 'output_callback_us'])
      || !numberFields(value.performance.load_options, ['context_size', 'threads', 'batch_size'])) return undefined;
    const { timings, load_options } = value.performance;
    performance = {
      timings: { prepare_us: timings.prepare_us, prefill_us: timings.prefill_us, decode_us: timings.decode_us, output_callback_us: timings.output_callback_us },
      load_options: { context_size: load_options.context_size, threads: load_options.threads, batch_size: load_options.batch_size },
    };
  }
  return {
    sequence: value.sequence, request_id: value.request_id, model_id: value.model_id, modality: value.modality,
    status: value.status, accepted_at_unix_ms: value.accepted_at_unix_ms, max_output_tokens: value.max_output_tokens,
    usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens },
    timings: { queue_ms: value.timings.queue_ms, load_ms: value.timings.load_ms, execution_ms: value.timings.execution_ms },
    error_code: value.error_code, finish_reason: value.finish_reason, performance,
  };
}
// Adapter errors follow a structural contract. Keep valid partial output even
// when the adapter does not use either built-in Error class, without copying
// unknown fields over the queue identity or accepting malformed metric objects.
function applyPartialResult(result: OcrResult, partial: unknown): void {
  if (!object(partial)) return;
  if (typeof partial.text === 'string' && Buffer.byteLength(partial.text) <= MAX_TEXT_BYTES) result.text = partial.text;
  if (partial.instanceId === null || typeof partial.instanceId === 'string') result.instanceId = partial.instanceId;
  if (partial.requestId === null || typeof partial.requestId === 'string') result.requestId = partial.requestId;
  if (typeof partial.complete === 'boolean') result.complete = partial.complete;
  if (partial.finishReason === null || partial.finishReason === 'stop' || partial.finishReason === 'length' || partial.finishReason === 'content_filter') result.finishReason = partial.finishReason;
  if (typeof partial.cleanupConfirmed === 'boolean') result.cleanupConfirmed = partial.cleanupConfirmed;
  if (partial.usage === null) result.usage = null;
  else {
    const usage = partialUsage(partial.usage);
    if (usage) result.usage = usage;
  }
  if (partial.performance === null) result.performance = null;
  else {
    const performance = partialPerformance(partial.performance);
    if (performance) result.performance = performance;
  }
}
function metadata(item: QueueMetadata): QueueMetadata { return { id: item.id, name: item.name, width: item.width, height: item.height, bytes: item.bytes, status: item.status, error: item.error }; }
function cleanName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1000) throw fail('invalid_image', '图片名称无效。');
  return (value.split(/[\\/]/).at(-1) ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'image';
}
function dimensions(bytes: Buffer, mime: string): [number, number] {
  if (mime === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).toString('ascii') === 'IHDR') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      offset += length;
    }
  }
  throw fail('invalid_image', '图片内容不是有效的 PNG/JPEG。');
}

export class Controller {
  pi: Pick<PiHost, 'net' | 'fs'>;
  store: Store;
  clientFactory: (options: ClientOptions) => BackendClient;
  queue: QueueItem[] = [];
  busy = false;
  stopping = false;
  phase = '';
  error: string | null = null;
  activeId: string | null = null;
  result: OcrResult | null = null;
  client: BackendClient | null = null;
  runtime: Snapshot['runtime'] = null;
  models: Snapshot['models'] = [];
  upload: Upload | null = null;
  persistenceError: string | null = null;
  needsRefresh = false;
  exporting = false;
  exportMessage: string | null = null;
  connection: Snapshot['connection'] = { state: 'disconnected', message: '请启动支持图片输入的本机服务后连接。', instanceId: null };
  mutations: Promise<unknown> = Promise.resolve();
  task: Promise<void> = Promise.resolve();
  exportTask: Promise<void> = Promise.resolve();
  abort: AbortController | null = null;
  closing = false;
  constructor(pi: Pick<PiHost, 'net' | 'fs'>, store: Store, clientFactory: (options: ClientOptions) => BackendClient = createClient) {
    this.pi = pi; this.store = store; this.clientFactory = clientFactory;
  }
  snapshot(): Snapshot {
    return structuredClone({
      settings: this.store.settings, hasToken: Boolean(this.store.token), capabilities: capabilitiesFor(this.store.settings.backend), connection: this.connection,
      models: this.models, runtime: this.runtime, busy: this.busy, stopping: this.stopping,
      phase: this.phase, error: this.error, queue: this.queue.map(metadata), activeId: this.activeId,
      result: this.result, persistenceError: this.persistenceError, needsRefresh: this.needsRefresh,
      exporting: this.exporting, exportMessage: this.exportMessage,
      history: this.store.history.map(r => ({ id: r.id, name: r.name, preview: r.text.slice(0, 100) })),
    });
  }
  idle() { if (this.busy) throw fail('plugin_busy', '当前任务尚未结束，请等待或停止后再操作。'); }
  async permitNetwork() {
    // Exercise the real permission gateway before raw Node HTTP, which is needed
    // for SSE and cancellation. Health is public: NEVER attach a bearer here.
    const { backend, baseUrl } = this.store.settings;
    const reply = await this.pi.net.fetch({ url: `${baseUrl}${backend === 'nexa' ? '/healthz' : '/models'}`, method: 'GET', timeoutMs: 5000 });
    if (backend === 'nexa' && reply.status !== 200) throw fail('connection_failed', '本机 Nexa 未就绪，请检查地址和服务状态。');
  }
  async connect(signal?: AbortSignal): Promise<void> {
    const nexa = this.store.settings.backend === 'nexa';
    this.connection = { state: 'connecting', message: '正在连接服务并读取模型列表…', instanceId: null };
    if (nexa && !this.store.token) throw fail('token_required', '请先输入或导入 Nexa 本机 API 令牌。');
    await this.permitNetwork();
    if (signal?.aborted) throw fail('request_cancelled', '已停止连接。');
    this.client = this.clientFactory({ ...this.store.settings, token: this.store.token });
    const data = await this.client.connect({ signal });
    this.runtime = nexa ? data.status : null;
    this.models = data.models.filter(m => !nexa || m.has_projector).map(m => ({ id: m.id, name: m.display_name || m.id, hasProjector: nexa ? Boolean(m.has_projector) : null, loadable: m.loadable && m.available }));
    this.connection = { state: 'connected', message: `已连接 · ${this.models.length} 个${nexa ? '配对视觉' : '候选'}模型${nexa ? '' : '；请选择支持图片输入的模型'}`, instanceId: data.instanceId };
    const firstLoadable = this.models.find(m => m.loadable);
    if (nexa && !this.store.settings.modelId && firstLoadable) {
      await this.store.saveSettings({ ...this.store.settings, modelId: firstLoadable.id }, this.store.token);
    }
    if (!nexa || !data.status.active_request && !data.status.queued_jobs && !['loading', 'unloading', 'generating', 'faulted'].includes(data.status.state)) this.needsRefresh = false;
  }
  launch(work: (signal: AbortSignal) => Promise<void>): void {
    this.busy = true; this.stopping = false; this.error = null;
    const abort = new AbortController(); this.abort = abort;
    this.task = Promise.resolve().then(() => work(abort.signal)).catch(error => {
      this.error = message(error);
      if (this.connection.state === 'connecting') this.connection = { state: 'error', message: this.error, instanceId: null };
    }).finally(() => { this.busy = false; this.stopping = false; this.activeId = null; this.phase = ''; });
  }
  findResult(id: unknown): OcrResult | HistoryResult | null { return this.queue.find(q => q.id === id)?.result ?? this.store.history.find(r => r.id === id) ?? null; }
  async persist(result: OcrResult): Promise<void> {
    try { await this.store.addResult(result); this.persistenceError = null; }
    catch { this.persistenceError = '结果未能保存到磁盘；批次已暂停。请先复制当前内容，再检查磁盘空间和目录权限。'; throw fail('persistence_failed', this.persistenceError); }
  }
  async run(signal: AbortSignal): Promise<void> {
    if (!this.client || this.connection.state !== 'connected') await this.connect(signal);
    else await this.permitNetwork();
    const client = this.client;
    if (!client) throw fail('connection_failed', '无法连接本机服务。');
    const settings = { ...this.store.settings };
    if (!settings.modelId || settings.backend === 'nexa' && !this.models.some(m => m.id === settings.modelId && m.loadable)) throw fail('model_required', '请选择或填写支持图片输入的模型；Nexa 模式需先配对登记主模型和 mmproj。');
    for (const item of this.queue) {
      if (signal.aborted || item.status !== 'pending') continue;
      item.status = 'running'; this.activeId = item.id;
      const started = Date.now();
      const result: OcrResult = { id: item.id, name: item.name, backend: settings.backend, modelId: settings.modelId, createdAt: new Date().toISOString(), status: 'running', text: '', complete: false, error: null, requestId: null, finishReason: null, usage: null, performance: null, elapsedMs: 0 };
      item.result = result; this.result = result;
      let checkpointBusy = false, checkpointLength = 0;
      const checkpoint = setInterval(() => {
        if (checkpointBusy || !result.text || checkpointLength === result.text.length) return;
        checkpointBusy = true; checkpointLength = result.text.length;
        this.persist({ ...result, elapsedMs: Date.now() - started }).catch(() => this.abort?.abort(fail('persistence_failed', this.persistenceError ?? '结果未能保存到磁盘。'))).finally(() => { checkpointBusy = false; });
      }, 4000);
      checkpoint.unref?.();
      try {
        const response = await client.recognize({ modelId: settings.modelId, imageDataUrl: item.dataUrl, prompt: settings.prompt, maxTokens: settings.maxTokens, autoLoad: settings.autoLoad }, {
          signal, onRequest: id => { result.requestId = id; }, onPhase: phase => { this.phase = phase; },
          onDelta: delta => {
            if (Buffer.byteLength(result.text) + Buffer.byteLength(delta) > MAX_TEXT_BYTES) { this.abort?.abort(fail('response_too_large', '识别文本超过 1 MiB，已停止并保留部分结果。')); return; }
            result.text += delta; result.elapsedMs = Date.now() - started;
          },
        });
        Object.assign(result, response, { status: response.complete ? 'completed' : 'failed', error: response.complete ? null : '达到最大输出 token，内容可能不完整。' });
      } catch (error) {
        const partial = object(error) ? error.partialResult : undefined;
        applyPartialResult(result, partial);
        result.status = errorCode(error) === 'request_cancelled' ? 'cancelled' : 'failed'; result.complete = false; result.error = message(error);
        if (errorCode(error) === 'executor_cleanup_unconfirmed' || object(partial) && partial.cleanupConfirmed === false) this.needsRefresh = true;
      } finally {
        clearInterval(checkpoint); result.elapsedMs = Date.now() - started;
        item.status = result.status; item.error = result.error;
      }
      await this.persist(result);
      if (result.status !== 'completed') { this.error = result.error; break; }
    }
  }
  invoke(channel: string, payload: unknown = {}): Promise<Reply<Channel>> {
    if (!object(payload)) return Promise.reject(fail('invalid_request', '请求格式不正确。'));
    if (channel === 'ocr.snapshot') return Promise.resolve(this.snapshot());
    if (channel === 'ocr.result') return Promise.resolve(structuredClone(this.findResult(payload.id)));
    const work = this.mutations.then(() => this.mutate(channel, payload));
    this.mutations = work.catch(() => {});
    return work.catch((error: unknown) => { const code = errorCode(error); throw fail(typeof code === 'string' && /^[a-zA-Z_]+$/.test(code) ? code : 'plugin_error', message(error)); });
  }
  async mutate(channel: string, p: Record<string, unknown>): Promise<Reply<MutationChannel>> {
    if (this.closing) throw fail('plugin_closing', '插件正在退出，不能开始新的操作。');
    if (!hasOwnKey(this.handlers, channel)) throw fail('unknown_channel', '插件不支持此操作。');
    return this.handlers[channel](p);
  }
  private readonly handlers: MutationHandlers = {
    'ocr.settings': async p => {
      if (Object.keys(p.patch ?? {}).some(k => k !== 'view') || Object.hasOwn(p, 'token')) this.idle();
      const settings = normalizeSettings(this.store.settings, p.patch ?? {});
      const endpointChanged = settings.baseUrl !== this.store.settings.baseUrl || settings.backend !== this.store.settings.backend;
      const token = Object.hasOwn(p, 'token') ? normalizeToken(p.token, settings.backend) : endpointChanged ? '' : this.store.token;
      const reconnect = endpointChanged || token !== this.store.token || settings.timeoutSeconds !== this.store.settings.timeoutSeconds;
      await this.store.saveSettings(settings, token);
      if (reconnect) { this.client = null; this.models = []; this.runtime = null; this.connection = { state: 'disconnected', message: endpointChanged ? '服务已变更，旧密钥已清除；需要认证时请填写此服务的密钥。' : '连接设置已保存，请重新连接服务。', instanceId: null }; }
      return this.snapshot();
    },
    'ocr.clearToken': async () => {
      this.idle(); await this.store.saveSettings({ ...this.store.settings, rememberToken: false }, ''); this.client = null;
      this.connection = { state: 'disconnected', message: '令牌已清除。', instanceId: null }; return this.snapshot();
    },
    'ocr.connect': async () => {
      this.idle(); this.launch(signal => this.connect(signal)); return { started: true };
    },
    'ocr.image.begin': async p => {
      this.idle();
      if (this.queue.length >= 20) throw fail('queue_full', '一次最多导入 20 张图片。');
      if (this.upload && Date.now() - this.upload.updatedAt < 60000) throw fail('upload_busy', '另一张图片仍在导入，请稍后再试。');
      if (typeof p.width !== 'number' || typeof p.height !== 'number' || typeof p.bytes !== 'number' || typeof p.dataLength !== 'number' || ![p.width, p.height, p.bytes, p.dataLength].every(Number.isSafeInteger) || p.width < 1 || p.height < 1 || p.width > 8192 || p.height > 8192 || p.width * p.height > 16777216 || p.bytes < 1 || p.bytes > MAX_IMAGE || p.dataLength < 1 || p.dataLength > MAX_DATA || (p.mimeType !== 'image/png' && p.mimeType !== 'image/jpeg')) throw fail('invalid_image', '图片超出限制：PNG/JPEG、4 MiB、8192 边长、16 Mi 像素。');
      const id = randomUUID(); this.upload = { name: cleanName(p.name), width: p.width, height: p.height, bytes: p.bytes, dataLength: p.dataLength, mimeType: p.mimeType, id, chunks: [], received: 0, updatedAt: Date.now() }; return { uploadId: id };
    },
    'ocr.image.chunk': async p => {
      this.idle(); const u = this.upload;
      if (!u || u.id !== p.uploadId || Date.now() - u.updatedAt > 60000 || typeof p.chunk !== 'string' || !p.chunk.length || p.chunk.length > CHUNK || u.received + p.chunk.length > u.dataLength) throw fail('invalid_upload', '图片传输中断，请重新导入。');
      u.chunks.push(p.chunk); u.received += p.chunk.length; u.updatedAt = Date.now(); return { received: u.received };
    },
    'ocr.image.commit': async p => {
      this.idle(); const u = this.upload;
      if (!u || u.id !== p.uploadId || u.received !== u.dataLength || Date.now() - u.updatedAt > 60000) throw fail('invalid_upload', '图片未完整传输。');
      const dataUrl = u.chunks.join(''); const prefix = `data:${u.mimeType};base64,`;
      if (!dataUrl.startsWith(prefix) || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataUrl.slice(prefix.length))) throw fail('invalid_image', '图片编码无效。');
      const bytes = Buffer.from(dataUrl.slice(prefix.length), 'base64');
      if (bytes.length !== u.bytes || bytes.toString('base64') !== dataUrl.slice(prefix.length)) throw fail('invalid_image', '图片数据长度不符。');
      const [width, height] = dimensions(bytes, u.mimeType);
      if (width !== u.width || height !== u.height) throw fail('invalid_image', '图片尺寸与文件内容不符。');
      this.queue.push({ ...metadata({ ...u, status: 'pending', error: null }), dataUrl, result: null }); this.upload = null; return { id: u.id };
    },
    'ocr.image.abort': async p => {
      if (this.upload?.id === p.uploadId) this.upload = null; return { ok: true };
    },
    'ocr.image.read': async p => {
      const item = this.queue.find(q => q.id === p.id);
      if (!item || typeof p.offset !== 'number' || !Number.isSafeInteger(p.offset) || p.offset < 0 || p.offset > item.dataUrl.length) throw fail('not_found', '图片已移除或读取位置无效。');
      return { chunk: item.dataUrl.slice(p.offset, p.offset + CHUNK), total: item.dataUrl.length };
    },
    'ocr.queue': async p => {
      this.idle();
      if (p.action === 'clear') this.queue = [];
      else {
        const index = this.queue.findIndex(q => q.id === p.id);
        if (index < 0) throw fail('not_found', '图片已移除。');
        if (p.action === 'remove') this.queue.splice(index, 1);
        else if (p.action === 'move' && (p.direction === -1 || p.direction === 1)) {
          const next = index + p.direction;
          if (next >= 0 && next < this.queue.length) {
            const currentItem = this.queue[index], nextItem = this.queue[next];
            if (currentItem && nextItem) [this.queue[index], this.queue[next]] = [nextItem, currentItem];
          }
        } else throw fail('invalid_request', '队列操作不支持。');
      }
      return this.snapshot();
    },
    'ocr.start': async () => {
      this.idle();
      if (this.needsRefresh) throw fail('cleanup_unconfirmed', '上一任务停止尚未确认，请点击连接刷新状态后再开始。');
      if (this.upload) throw fail('upload_busy', '图片仍在导入。');
      if (!this.queue.some(q => q.status === 'pending')) throw fail('empty_queue', '请先导入图片；已开始的图片不会自动重试，重做请重新导入。');
      this.launch(signal => this.run(signal)); return { started: true };
    },
    'ocr.stop': async () => {
      if (this.busy) { this.stopping = true; this.phase = 'stopping'; this.abort?.abort(); }
      return { stopping: this.stopping };
    },
    'ocr.history.delete': async p => {
      this.idle(); await this.store.deleteHistory(p.id); return this.snapshot();
    },
    'ocr.history.clear': async () => {
      this.idle(); await this.store.clearHistory(); return this.snapshot();
    },
    'ocr.export': async p => {
      if (this.exporting) throw fail('export_busy', '请先完成当前导出。');
      const r = structuredClone(this.findResult(p.id));
      if (!r?.text) throw fail('not_found', '没有可导出的文字。');
      this.exporting = true; this.exportMessage = '请选择 Markdown 保存目录…';
      this.exportTask = Promise.resolve().then(async () => {
        const dir = await this.pi.fs.requestDirectory();
        if (!dir) { this.exportMessage = '已取消导出。'; return; }
        const base = r.name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'OCR';
        const filename = `${base}-${randomUUID().slice(0, 8)}.md`;
        await this.pi.fs.writeText(filename, r.text);
        this.exportMessage = `已导出 ${filename}${'complete' in r && !r.complete ? '（不完整结果）' : ''}`;
      }).catch(e => { this.exportMessage = `导出失败：${message(e)}`; }).finally(() => { this.exporting = false; });
      return { started: true };
    },
  };
  async close() {
    this.closing = true;
    this.abort?.abort();
    if (this.result?.status === 'running' && this.result.text) await this.persist({ ...this.result, status: 'cancelled', complete: false, error: '插件退出，以下为已生成的部分结果。' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.task, new Promise<void>(resolve => { timer = setTimeout(resolve, 2500); })]);
    clearTimeout(timer);
    await this.store.chain;
  }
}
