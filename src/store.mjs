import { mkdir, readFile, rename, open, lstat, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { DEFAULTS, normalizeSettings, normalizeToken, fail } from './settings.mjs';

export const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
function omitNulls(value) {
  if (Array.isArray(value)) return value.map(omitNulls);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, omitNulls(v)]));
  return value;
}
export function durableResult(result) {
  if (!result || typeof result.text !== 'string' || Buffer.byteLength(result.text) > MAX_TEXT_BYTES || !/^[a-f0-9-]{36}$/.test(result.id) || typeof result.name !== 'string' || !['running', 'completed', 'cancelled', 'failed'].includes(result.status)) throw fail('invalid_history', '识别结果格式不正确，未覆盖历史文件。');
  return {
    id: result.id, name: result.name.slice(0, 200), backend: result.backend ?? 'nexa', modelId: String(result.modelId ?? '').slice(0, 256), createdAt: String(result.createdAt),
    status: result.status, text: result.text, complete: result.complete === true,
    error: result.error ?? null, requestId: result.requestId ?? null, instanceId: result.instanceId ?? null, finishReason: result.finishReason ?? null,
    usage: result.usage ?? null, performance: result.performance ?? null, elapsedMs: result.elapsedMs ?? 0,
  };
}

export class Store {
  constructor(directory) { this.directory = directory; this.settings = { ...DEFAULTS }; this.token = ''; this.history = []; this.chain = Promise.resolve(); }
  async read(name, limit) {
    const path = join(this.directory, name);
    try {
      const st = await lstat(path);
      if (!st.isFile() || st.isSymbolicLink() || st.size > limit) throw fail('storage_invalid', '插件数据文件类型或大小异常，已保留原文件。');
      const text = await readFile(path, 'utf8');
      if (Buffer.byteLength(text) > limit) throw fail('storage_invalid', '插件数据文件超过上限。');
      let result;
      // Parser diagnostics include source lines: never expose credentials or OCR
      // text through the host's lifecycle error/log transport.
      try { result = parse(text); } catch { throw fail('storage_invalid', '插件数据文件格式不正确，已保留原文件。'); }
      if (result.schema_version !== 1) throw fail('storage_version', '插件数据版本不兼容，已保留原文件。');
      return result;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (['storage_invalid', 'storage_version'].includes(e.code)) throw e;
      throw fail('storage_read_failed', '插件数据文件无法读取，已保留原文件。');
    }
  }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const prefs = await this.read('preferences.toml', 128 * 1024);
    if (prefs) this.settings = normalizeSettings(DEFAULTS, prefs.settings?.backend ? prefs.settings : { ...prefs.settings, backend: 'nexa' });
    const history = await this.read('history.toml', MAX_HISTORY_BYTES + 4 * 1024 * 1024);
    if (history) {
      if (!Array.isArray(history.results) || history.results.length > 100) throw fail('storage_invalid', '历史文件格式不正确，已保留原文件。');
      this.history = history.results.map(durableResult);
    }
    if (this.settings.rememberToken) {
      const credentials = await this.read('credentials.toml', 1024);
      if (credentials) this.token = normalizeToken(credentials.api_token, this.settings.backend);
    }
    // A previous process may have stopped during a partial-output checkpoint.
    this.history = this.history.map(r => r.status === 'running' ? { ...r, status: 'failed', complete: false, error: '上次识别在完成前退出，以下为已保存的部分结果。' } : r);
    return this;
  }
  async atomic(name, data) {
    const target = join(this.directory, name);
    try { const st = await lstat(target); if (!st.isFile() || st.isSymbolicLink()) throw fail('storage_invalid', '数据文件类型异常。'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const tmp = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    let handle, published = false;
    try {
      handle = await open(tmp, 'wx', 0o600);
      await handle.writeFile(stringify(omitNulls(data)), 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await rename(tmp, target); published = true;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (!published) await unlink(tmp).catch(() => {});
    }
  }
  async clearCredentials() {
    const names = (await readdir(this.directory)).filter(name => name === 'credentials.toml' || /^\.credentials\.toml\.[a-f0-9-]{36}\.tmp$/.test(name));
    for (const name of names) await unlink(join(this.directory, name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  serialize(task) {
    const next = this.chain.then(task);
    this.chain = next.catch(() => {});
    return next;
  }
  saveSettings(settings, token) {
    return this.serialize(async () => {
      if (settings.rememberToken && token) await this.atomic('credentials.toml', { schema_version: 1, api_token: token });
      else await this.clearCredentials();
      await this.atomic('preferences.toml', { schema_version: 1, settings });
      this.settings = { ...settings }; this.token = token;
    });
  }
  addResult(result) {
    const copy = durableResult(result);
    if (!copy.text.trim()) return Promise.resolve();
    return this.serialize(async () => {
      let history = [copy, ...this.history.filter(r => r.id !== copy.id)].slice(0, 100);
      while (Buffer.byteLength(stringify(omitNulls({ schema_version: 1, results: history }))) > MAX_HISTORY_BYTES && history.length > 1) history.pop();
      await this.atomic('history.toml', { schema_version: 1, results: history });
      this.history = history;
    });
  }
  deleteHistory(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return Promise.reject(fail('invalid_history', '请选择要删除的历史记录。'));
    return this.serialize(async () => {
      const history = this.history.filter(r => r.id !== id);
      await this.atomic('history.toml', { schema_version: 1, results: history }); this.history = history;
    });
  }
  clearHistory() {
    return this.serialize(async () => {
      await this.atomic('history.toml', { schema_version: 1, results: [] }); this.history = [];
    });
  }
}
