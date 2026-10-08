import type { BackendClient, HistoryResult, OcrInvoke, Snapshot } from '../../shared/contracts.ts';

declare const invoke: OcrInvoke;
const snapshot: Promise<Snapshot> = invoke('ocr.snapshot');
const result = invoke('ocr.result', { id: 'local-id' });
void snapshot; void result;
void invoke('ocr.queue', { action: 'move', id: 'local-id', direction: -1 });
void invoke('ocr.settings', { patch: { maxImageEdge: 512, backend: 'openai' } });

// Negative compile fixtures: removing a constraint must fail the typecheck.
// @ts-expect-error Unknown channel must never fall through a string overload.
void invoke('ocr.unknown', {});
// @ts-expect-error This channel requires its payload.
void invoke('ocr.result');
// @ts-expect-error Upload identity is not the queue/result identity.
void invoke('ocr.image.commit', { id: 'local-id' });
// @ts-expect-error Queue move only accepts the adjacent positions.
void invoke('ocr.queue', { action: 'move', id: 'local-id', direction: 2 });
// @ts-expect-error A new backend needs an explicit contract.
void invoke('ocr.settings', { patch: { backend: 'unknown-service' } });
// @ts-expect-error Settings must retain their value types.
void invoke('ocr.settings', { patch: { maxTokens: '4096' } });
// @ts-expect-error Snapshot contains no token-bearing input.
void invoke('ocr.snapshot', { token: 'must-not-leak' });
// @ts-expect-error Chunk replies cannot be confused with upload initiation.
const wrongReply: Promise<{ uploadId: string }> = invoke('ocr.image.chunk', { uploadId: 'id', chunk: 'data' });
void wrongReply;

const history: HistoryResult = { id: 'id', name: 'original.png', text: 'recognized text' };
// @ts-expect-error History must not expose retained source images.
history.dataUrl = 'data:image/png;base64,ignored';
// @ts-expect-error Runtime metrics are not part of persisted history.
history.performance = null;
declare const backend: BackendClient;
// @ts-expect-error The shared adapter API does not grant Nexa-only management.
void backend.ensureModel('model');
