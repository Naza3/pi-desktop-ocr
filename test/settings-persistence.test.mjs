import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { Store } from '../src/store.ts';
import { Controller } from '../src/controller.ts';
import { DEFAULTS, normalizeSettings } from '../src/settings.ts';

// A schema-1 preferences file written by v0.1.1, before the [ui] table existed.
const ORIGINAL_SETTINGS = Object.freeze({
  backend: 'nexa', baseUrl: 'http://127.0.0.1:18181', modelId: 'custom-ocr-model',
  prompt: '自定义提示词：请保留表格格式。\n不要省略任何文字。', maxTokens: 3072,
  timeoutSeconds: 3600, maxImageEdge: 1024, view: 'text', autoLoad: true, rememberToken: true,
});
const TOKEN = 'b'.repeat(64);
const UI_DEFAULTS = { previewMode: 'fit-width', historyView: 'markdown' };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ocr-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const history = { id: randomUUID(), name: '原始表格.png', text: '历史识别结果\n|字段|值|\n|---|---|\n|A|1|' };
  const preferences = stringify({ schema_version: 1, settings: ORIGINAL_SETTINGS });
  const historical = stringify({ schema_version: 1, results: [history] });
  await writeFile(join(dir, 'preferences.toml'), preferences);
  await writeFile(join(dir, 'history.toml'), historical);
  await writeFile(join(dir, 'credentials.toml'), stringify({ schema_version: 1, api_token: TOKEN }));
  return { dir, history, preferences, historical };
}
function makeController(store, clientFactory = () => { throw new Error('unexpected backend connection'); }) {
  return new Controller({ net: { fetch: async () => ({ status: 200 }) }, fs: {} }, store, clientFactory);
}

test('旧schema-1的全部自定义参数、提示词、历史和显式保存的凭据原样恢复', async t => {
  const { dir, history, preferences, historical } = await fixture(t);
  const store = await new Store(dir).open();
  assert.deepEqual(store.settings, { ...ORIGINAL_SETTINGS, ...UI_DEFAULTS });
  assert.deepEqual(store.history, [history]);
  assert.equal(store.token, TOKEN);
  assert.equal(await readFile(join(dir, 'preferences.toml'), 'utf8'), preferences);
  assert.equal(await readFile(join(dir, 'history.toml'), 'utf8'), historical);
});

test('新增页面视图单独保存为ui表，重启恢复且不改变旧设置表或历史', async t => {
  const { dir, history, historical } = await fixture(t);
  const store = await new Store(dir).open();
  const controller = makeController(store);
  t.after(() => controller.close());
  await controller.invoke('ocr.settings', { patch: { previewMode: 'actual', historyView: 'text' } });
  const saved = parse(await readFile(join(dir, 'preferences.toml'), 'utf8'));
  assert.equal(saved.schema_version, 1);
  assert.deepEqual({ ...saved.settings }, ORIGINAL_SETTINGS);
  assert.deepEqual({ ...saved.ui }, { previewMode: 'actual', historyView: 'text' });
  assert.equal(saved.settings.previewMode, undefined);
  assert.equal(saved.settings.historyView, undefined);
  assert.equal(await readFile(join(dir, 'history.toml'), 'utf8'), historical);
  const restored = await new Store(dir).open();
  assert.deepEqual(restored.settings, { ...ORIGINAL_SETTINGS, previewMode: 'actual', historyView: 'text' });
  assert.deepEqual(restored.history, [history]);
  assert.equal(restored.token, TOKEN);
});

test('旧版忽略ui表并重新保存后，提示词和识别参数仍保留，只有新视图回到默认', async t => {
  const { dir, history } = await fixture(t);
  const store = await new Store(dir).open();
  await store.saveSettings(normalizeSettings(store.settings, { previewMode: 'fit', historyView: 'text' }), TOKEN);
  const saved = parse(await readFile(join(dir, 'preferences.toml'), 'utf8'));
  // Old Store.open reads prefs.settings only and old saveSettings writes only
  // schema_version/settings. Its unchanged table must contain no new keys.
  assert.deepEqual(Object.keys(saved.settings).sort(), Object.keys(ORIGINAL_SETTINGS).sort());
  const olderSettings = { ...saved.settings, prompt: '旧版编辑后的提示词', maxImageEdge: 512 };
  await writeFile(join(dir, 'preferences.toml'), stringify({ schema_version: 1, settings: olderSettings }));
  const restored = await new Store(dir).open();
  assert.deepEqual(restored.settings, { ...olderSettings, ...UI_DEFAULTS });
  assert.deepEqual(restored.history, [history]);
  assert.equal(restored.token, TOKEN);
});

test('ui表拒绝未知字段和错误枚举且保留原始设置、历史、凭据文件', async t => {
  const { dir, historical } = await fixture(t);
  const credentials = await readFile(join(dir, 'credentials.toml'), 'utf8');
  for (const ui of [
    { prompt: '不允许在ui表覆盖提示词' }, { previewMode: 'stretch' }, { previewMode: false },
    { historyView: 'html' }, { historyView: [] }, [], 'invalid',
  ]) {
    const original = stringify({ schema_version: 1, settings: ORIGINAL_SETTINGS, ui });
    await writeFile(join(dir, 'preferences.toml'), original);
    await assert.rejects(new Store(dir).open(), { code: 'invalid_settings' });
    assert.equal(await readFile(join(dir, 'preferences.toml'), 'utf8'), original);
    assert.equal(await readFile(join(dir, 'history.toml'), 'utf8'), historical);
    assert.equal(await readFile(join(dir, 'credentials.toml'), 'utf8'), credentials);
  }
});

test('运行中只允许保存页面视图；推理、连接参数和凭据不可改动', async t => {
  const { dir } = await fixture(t);
  const store = await new Store(dir).open();
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const controller = makeController(store, () => ({ connect: () => ready }));
  t.after(async () => { finish({ instanceId: null, status: { state: 'ready', active_request: null, queued_jobs: 0 }, models: [] }); await controller.close(); });
  await controller.invoke('ocr.connect');
  assert.equal(controller.busy, true);
  await controller.invoke('ocr.settings', { patch: { view: 'markdown', previewMode: 'fit', historyView: 'text' } });
  assert.deepEqual(store.settings, { ...ORIGINAL_SETTINGS, view: 'markdown', previewMode: 'fit', historyView: 'text' });
  for (const key of ['backend', 'baseUrl', 'modelId', 'prompt', 'maxTokens', 'timeoutSeconds', 'maxImageEdge', 'autoLoad', 'rememberToken']) {
    await assert.rejects(controller.invoke('ocr.settings', { patch: { [key]: ORIGINAL_SETTINGS[key] } }), { code: 'plugin_busy' });
  }
  await assert.rejects(controller.invoke('ocr.settings', { patch: { view: 'text' }, token: TOKEN }), { code: 'plugin_busy' });
  await assert.rejects(controller.invoke('ocr.settings', { patch: { previewMode: 'invalid' } }), { code: 'invalid_settings' });
  assert.equal(store.settings.prompt, ORIGINAL_SETTINGS.prompt);
  assert.equal(store.token, TOKEN);
  const restored = await new Store(dir).open();
  assert.deepEqual(restored.settings, store.settings);
});

test('连续局部patch只改指定参数，不以默认值覆盖旧提示词或其他设置', async t => {
  const { dir } = await fixture(t);
  const store = await new Store(dir).open();
  const controller = makeController(store);
  t.after(() => controller.close());
  await controller.invoke('ocr.settings', { patch: { maxImageEdge: 256 } });
  await controller.invoke('ocr.settings', { patch: { previewMode: 'actual' } });
  await controller.invoke('ocr.settings', { patch: { historyView: 'text' } });
  await controller.invoke('ocr.settings', { patch: { timeoutSeconds: 4200 } });
  assert.deepEqual((await new Store(dir).open()).settings, {
    ...ORIGINAL_SETTINGS, ...UI_DEFAULTS, maxImageEdge: 256, timeoutSeconds: 4200, previewMode: 'actual', historyView: 'text',
  });
});

test('页面视图枚举运行时严格验证，最早缺少backend的Nexa设置仍兼容', async t => {
  for (const previewMode of ['fit-width', 'fit', 'actual']) assert.equal(normalizeSettings(DEFAULTS, { previewMode }).previewMode, previewMode);
  for (const historyView of ['markdown', 'text']) assert.equal(normalizeSettings(DEFAULTS, { historyView }).historyView, historyView);
  for (const patch of [{ previewMode: '' }, { previewMode: null }, { previewMode: 1 }, { historyView: 'preview' }, { historyView: false }]) {
    assert.throws(() => normalizeSettings(DEFAULTS, patch), { code: 'invalid_settings' });
  }
  const { dir } = await fixture(t);
  const { backend, ...olderSettings } = ORIGINAL_SETTINGS;
  await writeFile(join(dir, 'preferences.toml'), stringify({ schema_version: 1, settings: olderSettings }));
  assert.deepEqual((await new Store(dir).open()).settings, { ...ORIGINAL_SETTINGS, ...UI_DEFAULTS });
});
