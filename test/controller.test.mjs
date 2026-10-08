import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, MAX_TEXT_BYTES } from '../src/store.mjs';
import { Controller } from '../src/controller.mjs';
import { DEFAULTS, normalizeSettings } from '../src/settings.mjs';
import { NexaError } from '../src/nexa-client.mjs';

const TOKEN = 'a'.repeat(64);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=';
const record = overrides => ({ id: randomUUID(), name: '测试.png', modelId: 'glm-ocr', createdAt: new Date().toISOString(), status: 'completed', complete: true, text: '中文\n|A|B|\n|---|---|\n|1|2|', error: null, requestId: randomUUID(), usage: { prompt_tokens: 10, completion_tokens: 5 }, performance: null, elapsedMs: 50, finishReason: 'stop', ...overrides });
async function fixture(t, recognize = async (input, hooks) => { hooks.onDelta('识别结果'); return { text: '识别结果', complete: true, finishReason: 'stop' }; }) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ocr-controller-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open();
  const calls = [];
  const pi = { net: { fetch: async input => { assert.equal(input.headers, undefined); calls.push('gate'); return { status: 200 }; } }, fs: { requestDirectory: async () => ({ path: '/private/user-selected', name: 'out' }), writeText: async (file, text) => { calls.push({ file, text }); } } };
  const client = { connect: async () => ({ instanceId: randomUUID(), status: { state: 'unloaded', active_request: null, queued_jobs: 0 }, models: [{ id: 'glm-ocr', display_name: 'GLM OCR', has_projector: true, loadable: true, available: true }], config: {} }), recognize: async (input, hooks) => { calls.push(input); return recognize(input, hooks); } };
  const controller = new Controller(pi, store, () => client);
  t.after(() => controller.close());
  await controller.invoke('ocr.settings', { patch: { modelId: 'glm-ocr' }, token: TOKEN });
  return { dir, store, controller, calls, pi };
}
async function image(controller, name = '图.png') {
  const { uploadId } = await controller.invoke('ocr.image.begin', { name, width: 1, height: 1, bytes: Buffer.from(PNG.split(',')[1], 'base64').length, mimeType: 'image/png', dataLength: PNG.length });
  const middle = Math.floor(PNG.length / 2);
  await controller.invoke('ocr.image.chunk', { uploadId, chunk: PNG.slice(0, middle) });
  await controller.invoke('ocr.image.chunk', { uploadId, chunk: PNG.slice(middle) });
  return (await controller.invoke('ocr.image.commit', { uploadId })).id;
}

test('顺序批次保存完整结果；刷新快照不泄漏图片或令牌', async t => {
  const { controller, calls, store } = await fixture(t);
  const a = await image(controller, 'z.png'); const b = await image(controller, 'a.png');
  await controller.invoke('ocr.start'); await controller.task;
  assert.deepEqual(store.history.map(r => r.id), [b, a]);
  assert.equal(calls.filter(c => c.modelId).length, 2);
  const snapshot = controller.snapshot();
  assert.deepEqual(snapshot.queue.map(q => q.name), ['z.png', 'a.png']);
  assert(snapshot.queue.every(q => q.status === 'completed'));
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
  assert.equal(JSON.stringify(snapshot).includes(PNG), false);
  await assert.rejects(controller.invoke('ocr.start'), { code: 'empty_queue' });
});

test('失败保存部分正文并暂停，继续仅处理未开始项', async t => {
  let calls = 0;
  const { controller, store } = await fixture(t, async (_, hooks) => {
    if (++calls === 1) { hooks.onDelta('部分结果'); throw new NexaError('execution_timeout', '后端超时', { partialResult: { text: '部分结果', complete: false } }); }
    return { text: '第二张完整', complete: true, finishReason: 'stop' };
  });
  const a = await image(controller); const b = await image(controller);
  await controller.invoke('ocr.start'); await controller.task;
  assert.deepEqual(controller.snapshot().queue.map(q => q.status), ['failed', 'pending']);
  assert.equal(store.history[0].id, a); assert.equal(store.history[0].complete, false);
  await controller.invoke('ocr.start'); await controller.task;
  assert.equal(calls, 2); assert.equal(store.history[0].id, b);
});

test('停止不占住panel调用；清理未确认时必须刷新才能继续', async t => {
  let started;
  const beginning = new Promise(resolve => { started = resolve; });
  const { controller, store } = await fixture(t, async (_, hooks) => {
    hooks.onDelta('保留我'); started();
    await new Promise(resolve => hooks.signal.addEventListener('abort', resolve, { once: true }));
    throw new NexaError('request_cancelled', '已停止', { partialResult: { text: '保留我', cleanupConfirmed: false } });
  });
  await image(controller); await image(controller);
  assert.equal((await controller.invoke('ocr.start')).started, true);
  await beginning;
  await assert.rejects(controller.invoke('ocr.queue', { action: 'clear' }), { code: 'plugin_busy' });
  assert.equal((await controller.invoke('ocr.stop')).stopping, true);
  await controller.task;
  assert.equal(store.history[0].text, '保留我');
  await assert.rejects(controller.invoke('ocr.start'), { code: 'cleanup_unconfirmed' });
});

test('宿主拒绝网络授权时不构造客户端也不发送认证', async t => {
  const { controller, pi } = await fixture(t);
  pi.net.fetch = async () => { throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' }); };
  controller.clientFactory = () => { throw new Error('must not create client'); };
  await controller.invoke('ocr.connect'); await controller.task;
  assert.equal(controller.connection.state, 'error');
  assert.match(controller.error, /权限/);
});

test('保存失败保留内存结果并阻止推进下一图', async t => {
  const { controller, store } = await fixture(t);
  await image(controller); await image(controller);
  store.addResult = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  await controller.invoke('ocr.start'); await controller.task;
  assert.equal(controller.snapshot().queue[1].status, 'pending');
  assert.equal(controller.result.text, '识别结果');
  assert.match(controller.persistenceError, /未能保存/);
});

test('图片分片不能串改身份、超额、伪造尺寸或未完成就开始', async t => {
  const { controller } = await fixture(t);
  const p = { name: 'a.png', width: 2, height: 1, bytes: Buffer.from(PNG.split(',')[1], 'base64').length, mimeType: 'image/png', dataLength: PNG.length };
  const { uploadId } = await controller.invoke('ocr.image.begin', p);
  await assert.rejects(controller.invoke('ocr.image.chunk', { uploadId: randomUUID(), chunk: PNG }), { code: 'invalid_upload' });
  await assert.rejects(controller.invoke('ocr.image.chunk', { uploadId, chunk: PNG + 'x' }), { code: 'invalid_upload' });
  await controller.invoke('ocr.image.chunk', { uploadId, chunk: PNG });
  await assert.rejects(controller.invoke('ocr.image.commit', { uploadId }), { code: 'invalid_image' });
  await controller.invoke('ocr.image.abort', { uploadId });
  const id = await image(controller);
  assert.equal((await controller.invoke('ocr.image.read', { id, offset: 0 })).chunk, PNG);
});

test('删除缺少id绝不能清空历史；只有明确clear删除全部', async t => {
  const { controller, store } = await fixture(t);
  const r = record(); await store.addResult(r);
  for (const id of [undefined, null, '', false, '../history.toml']) await assert.rejects(controller.invoke('ocr.history.delete', { id }));
  assert.equal(store.history.length, 1);
  await controller.invoke('ocr.history.clear'); assert.equal(store.history.length, 0);
});

test('导出快速返回、仅写用户选择目录的随机相对md名称', async t => {
  const { controller, store, pi, calls } = await fixture(t);
  const r = record({ name: '..\\unsafe/name:<x>.png' }); await store.addResult(r);
  let choose;
  pi.fs.requestDirectory = () => new Promise(resolve => { choose = resolve; });
  assert.equal((await controller.invoke('ocr.export', { id: r.id })).started, true);
  await delay(0); assert.equal(controller.exporting, true);
  choose({ path: '/user-selected', name: 'out' }); await controller.exportTask;
  const output = calls.find(c => c.file);
  assert(!/[\\/<>:]/.test(output.file)); assert(output.file.endsWith('.md')); assert.equal(output.text, r.text);
});

test('设置TOML重启恢复，凭据默认不保存且显式取消记住会删除', async t => {
  const { store, dir } = await fixture(t);
  await store.saveSettings({ ...store.settings, prompt: 'Text Recognition: 中文\n第二行', timeoutSeconds: 2400 }, TOKEN);
  assert(!(await readdir(dir)).includes('credentials.toml'));
  assert(!(await readFile(join(dir, 'preferences.toml'), 'utf8')).includes(TOKEN));
  let restored = await new Store(dir).open();
  assert.equal(restored.settings.timeoutSeconds, 2400); assert.equal(restored.token, '');
  await store.saveSettings({ ...store.settings, rememberToken: true }, TOKEN);
  restored = await new Store(dir).open(); assert.equal(restored.token, TOKEN);
  await store.saveSettings({ ...store.settings, rememberToken: false }, TOKEN);
  assert(!(await readdir(dir)).includes('credentials.toml'));
  const leftover = `.credentials.toml.${randomUUID()}.tmp`;
  await writeFile(join(dir, leftover), TOKEN);
  await store.saveSettings({ ...store.settings, rememberToken: false }, '');
  assert(!(await readdir(dir)).includes(leftover));
});

test('保留最近100条、同id检查点替换、异常退出部分记录不冒充完成', async t => {
  const { store, dir } = await fixture(t);
  for (let n = 0; n < 102; n++) await store.addResult(record({ name: `${n}.png` }));
  assert.equal(store.history.length, 100); assert.equal(store.history.at(-1).name, '2.png');
  const last = { ...store.history[0], status: 'running', complete: false, text: 'partial' };
  await store.addResult(last); assert.equal(store.history.length, 100);
  const restored = await new Store(dir).open();
  assert.equal(restored.history[0].status, 'failed'); assert.equal(restored.history[0].text, 'partial');
  assert.throws(() => store.addResult(record({ text: 'x'.repeat(MAX_TEXT_BYTES + 1) })), { code: 'invalid_history' });
});

test('损坏的TOML保留原文件，不静默清空', async t => {
  const { dir } = await fixture(t);
  const bad = 'schema_version = 1\nsettings = [';
  await writeFile(join(dir, 'preferences.toml'), bad);
  await assert.rejects(new Store(dir).open(), e => e.code === 'storage_invalid' && !e.message.includes(bad));
  assert.equal(await readFile(join(dir, 'preferences.toml'), 'utf8'), bad);
});

test('地址、继承键、输出上限及模型ID按后端契约验证', () => {
  for (const patch of [{ baseUrl: 'https://example.com' }, { baseUrl: 'http://127.0.0.1:18080/path' }, { maxTokens: 32769 }, { modelId: 'bad\nmodel' }, { constructor: {} }, JSON.parse('{"__proto__":{}}')]) assert.throws(() => normalizeSettings(DEFAULTS, patch));
  assert.equal(normalizeSettings(DEFAULTS, { baseUrl: 'http://localhost:18080/v1' }).baseUrl, 'http://127.0.0.1:18080/v1');
  assert.equal(normalizeSettings(DEFAULTS, { modelId: 'Org/Vision-GGUF', maxTokens: 8192 }).modelId, 'Org/Vision-GGUF');
  for (const maxImageEdge of [256, 512, 1024]) assert.equal(normalizeSettings(DEFAULTS, { maxImageEdge }).maxImageEdge, maxImageEdge);
  assert.throws(() => normalizeSettings(DEFAULTS, { maxImageEdge: 255 }));
  const nexa = normalizeSettings(DEFAULTS, { backend: 'nexa' });
  assert.equal(nexa.baseUrl, 'http://127.0.0.1:18080');
  for (const patch of [{ maxTokens: 4097 }, { modelId: 'Org/Model' }]) assert.throws(() => normalizeSettings(nexa, patch));
});

test('通用后端无需密钥或模型列表登记，手填视觉模型可识别', async t => {
  const { controller, store, calls } = await fixture(t);
  await controller.invoke('ocr.settings', { patch: { modelId: 'Vendor/Vision-Model', maxTokens: 8192 }, token: '' });
  await image(controller);
  await controller.invoke('ocr.start'); await controller.task;
  assert.equal(controller.connection.state, 'connected');
  assert.equal(controller.snapshot().hasToken, false);
  assert.equal(controller.snapshot().capabilities.autoLoad, false);
  assert.equal(controller.snapshot().models[0].hasProjector, null);
  assert.equal(calls.find(c => c.modelId)?.modelId, 'Vendor/Vision-Model');
  assert.equal(store.history[0].backend, 'openai');
});

test('切换服务或后端清除原凭据，显式新密钥只用于新目标', async t => {
  const { controller, store, dir } = await fixture(t);
  await controller.invoke('ocr.settings', { patch: { rememberToken: true } });
  assert((await readdir(dir)).includes('credentials.toml'));
  await controller.invoke('ocr.settings', { patch: { baseUrl: 'http://127.0.0.1:1234' } });
  assert.equal(store.token, ''); assert(!(await readdir(dir)).includes('credentials.toml'));
  await controller.invoke('ocr.settings', { patch: { backend: 'nexa' }, token: TOKEN });
  assert.equal(store.token, TOKEN); assert.equal(store.settings.modelId, '');
  await controller.invoke('ocr.settings', { patch: { backend: 'openai' } });
  assert.equal(store.token, ''); assert.equal(store.settings.baseUrl, DEFAULTS.baseUrl);
  await controller.invoke('ocr.settings', { patch: { baseUrl: 'http://127.0.0.1:9000/v1' }, token: 'new-api-key' });
  assert.equal(store.token, 'new-api-key');
  assert.equal((await new Store(dir).open()).token, 'new-api-key');
});

test('可选Nexa适配保留必需令牌、配对筛选和自动加载选项', async t => {
  const { controller, store } = await fixture(t);
  await controller.invoke('ocr.settings', { patch: { backend: 'nexa', autoLoad: true } });
  await controller.invoke('ocr.connect'); await controller.task;
  assert.equal(controller.connection.state, 'error'); assert.match(controller.error, /令牌/);
  await controller.invoke('ocr.settings', { patch: {}, token: TOKEN });
  await controller.invoke('ocr.connect'); await controller.task;
  assert.equal(controller.snapshot().capabilities.requiresToken, true);
  assert.equal(controller.models[0].hasProjector, true);
  assert.equal(store.settings.modelId, 'glm-ocr'); assert.equal(store.settings.autoLoad, true);
});
