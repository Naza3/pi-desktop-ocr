/** Wire/data contracts owned by this plugin; no Node or DOM dependencies. */
export type Backend = 'openai' | 'nexa';
export type ResultStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type QueueStatus = 'pending' | ResultStatus;
export type View = 'markdown' | 'text';
export type PreviewMode = 'fit-width' | 'fit' | 'actual';
export interface Settings {
  backend: Backend; baseUrl: string; modelId: string; prompt: string;
  maxTokens: number; timeoutSeconds: number; maxImageEdge: number; view: View;
  previewMode: PreviewMode; historyView: View;
  autoLoad: boolean; rememberToken: boolean;
}
export interface Capabilities {
  autoLoad: boolean; performance: boolean; requiresToken: boolean; manualModelId: boolean;
}
export interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens?: number }
export interface LoadOptions { context_size?: number; threads?: number; batch_size?: number }
export interface RuntimeStatus {
  state: 'unloaded' | 'loading' | 'ready' | 'generating' | 'unloading' | 'faulted';
  active_request: string | null; queued_jobs: number;
  selected_model?: string | null; stopping?: boolean; registry_busy?: boolean;
  load_options?: unknown;
}
export interface BackendModel {
  id: string; display_name: string; loadable: boolean; available: boolean; has_projector?: boolean;
}
export interface PerformanceRecord {
  sequence: number; request_id: string; model_id: string; modality: 'text' | 'image';
  status: 'completed' | 'cancelled' | 'failed'; accepted_at_unix_ms: number;
  max_output_tokens: number; usage: Pick<Usage, 'prompt_tokens' | 'completion_tokens'>;
  timings: { queue_ms: number; load_ms: number; execution_ms: number };
  error_code: string | null; finish_reason: 'stop' | 'length' | null;
  performance: {
    timings: { prepare_us: number; prefill_us: number; decode_us: number; output_callback_us: number };
    load_options: Required<LoadOptions>;
  } | null;
}
export interface RecognitionResult {
  instanceId: string | null; requestId: string | null; text: string; complete: boolean;
  finishReason: 'stop' | 'length' | 'content_filter' | null; usage: Usage | null;
  performance: PerformanceRecord | null; cleanupConfirmed: boolean;
}
/** Persist only an internal identifier, original file name and recognized text. */
export interface HistoryResult { id: string; name: string; text: string }
export interface OcrResult extends HistoryResult {
  backend: Backend; modelId: string; createdAt: string; status: ResultStatus;
  complete: boolean; error: string | null; requestId: string | null; instanceId?: string | null;
  finishReason: 'stop' | 'length' | 'content_filter' | null; usage: Usage | null;
  performance: PerformanceRecord | null; elapsedMs: number; cleanupConfirmed?: boolean;
}
export type DisplayResult = OcrResult | HistoryResult;
export interface RecognitionError extends Error {
  code: string; status?: number; cleanupConfirmed?: boolean; cleanupError?: string;
  partialResult?: Partial<RecognitionResult>;
}
export interface ClientOptions { baseUrl: string; token: string; timeoutSeconds?: number; backend?: Backend }
export interface RecognizeInput {
  modelId: string; imageDataUrl: string; prompt: string; maxTokens: number;
  autoLoad?: boolean; loadOptions?: LoadOptions;
}
export interface RecognizeOptions {
  signal?: AbortSignal; onDelta?: (delta: string) => void;
  onPhase?: (phase: string) => void; onRequest?: (id: string) => void;
}
export interface ConnectResult {
  instanceId: string | null; status: RuntimeStatus; models: BackendModel[];
}
export interface BackendClient {
  connect(options?: { signal?: AbortSignal }): Promise<ConnectResult>;
  recognize(input: RecognizeInput, options?: RecognizeOptions): Promise<RecognitionResult>;
}
export interface ImageMetadata { name: string; width: number; height: number; bytes: number }
export interface QueueMetadata extends ImageMetadata { id: string; status: QueueStatus; error: string | null }
export interface QueueItem extends QueueMetadata { dataUrl: string; result: OcrResult | null }
export interface HistorySummary { id: string; name: string; preview: string }
export interface Connection {
  state: 'disconnected' | 'connecting' | 'connected' | 'error'; message: string; instanceId: string | null;
}
export interface Snapshot {
  settings: Settings; hasToken: boolean; capabilities: Capabilities; connection: Connection;
  models: Array<{ id: string; name: string; hasProjector: boolean | null; loadable: boolean }>;
  runtime: RuntimeStatus | null; busy: boolean; stopping: boolean; phase: string; error: string | null;
  queue: QueueMetadata[]; activeId: string | null; result: OcrResult | null;
  history: HistorySummary[]; persistenceError: string | null; needsRefresh: boolean;
  exporting: boolean; exportMessage: string | null;
}
export type EmptyPayload = Record<string, never>;
export type QueueAction = { action: 'clear' } | { action: 'remove'; id: string }
  | { action: 'move'; id: string; direction: -1 | 1 };
export interface ChannelMap {
  'ocr.snapshot': { payload: EmptyPayload; reply: Snapshot };
  'ocr.settings': { payload: { patch: Partial<Settings>; token?: string }; reply: Snapshot };
  'ocr.clearToken': { payload: EmptyPayload; reply: Snapshot };
  'ocr.connect': { payload: EmptyPayload; reply: { started: true } };
  'ocr.image.begin': { payload: ImageMetadata & { mimeType: 'image/png' | 'image/jpeg'; dataLength: number }; reply: { uploadId: string } };
  'ocr.image.chunk': { payload: { uploadId: string; chunk: string }; reply: { received: number } };
  'ocr.image.commit': { payload: { uploadId: string }; reply: { id: string } };
  'ocr.image.abort': { payload: { uploadId: string }; reply: { ok: true } };
  'ocr.image.read': { payload: { id: string; offset: number }; reply: { chunk: string; total: number } };
  'ocr.queue': { payload: QueueAction; reply: Snapshot };
  'ocr.start': { payload: EmptyPayload; reply: { started: true } };
  'ocr.stop': { payload: EmptyPayload; reply: { stopping: boolean } };
  'ocr.result': { payload: { id: string }; reply: DisplayResult | null };
  'ocr.history.delete': { payload: { id: string }; reply: Snapshot };
  'ocr.history.clear': { payload: EmptyPayload; reply: Snapshot };
  'ocr.export': { payload: { id: string }; reply: { started: true } };
}
export type Channel = keyof ChannelMap;
export type Payload<C extends Channel> = ChannelMap[C]['payload'];
export type Reply<C extends Channel> = ChannelMap[C]['reply'];
export type InvokeArgs<C extends Channel> = EmptyPayload extends Payload<C>
  ? [channel: C, payload?: Payload<C>] : [channel: C, payload: Payload<C>];
export interface OcrInvoke { <C extends Channel>(...args: InvokeArgs<C>): Promise<Reply<C>> }
