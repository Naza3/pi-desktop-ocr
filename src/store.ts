import { mkdir, readFile, rename, open, lstat, unlink, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { DEFAULTS, normalizeSettings, normalizeToken, fail } from './settings.ts';
import type { HistoryResult, Settings } from '../shared/contracts.ts';

export const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function errorCode(error: unknown): unknown { return object(error) ? error.code : undefined; }
function omitNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNulls);
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, omitNulls(v)]));
  return value;
}
// Both legacy schema-1 records and current records retain their text and original
// image name. The internal ID is needed only to select, replace or delete a record.
export function durableResult(result: unknown): HistoryResult {
  if (!object(result) || typeof result.text !== 'string' || Buffer.byteLength(result.text) > MAX_TEXT_BYTES || typeof result.id !== 'string' || !/^[a-f0-9-]{36}$/.test(result.id) || typeof result.name !== 'string') throw fail('invalid_history', '识别结果格式不正确，未覆盖历史文件。');
  return { id: result.id, name: result.name.slice(0, 200), text: result.text };
}

export class Store {
  directory: string;
  settings: Settings = { ...DEFAULTS };
  token = '';
  history: HistoryResult[] = [];
  chain: Promise<void> = Promise.resolve();
  constructor(directory: string) { this.directory = directory; }
  async read(name: string, limit: number): Promise<Record<string, unknown> | null> {
    const path = join(this.directory, name);
    try {
      const st = await lstat(path);
      if (!st.isFile() || st.isSymbolicLink() || st.size > limit) throw fail('storage_invalid', '插件数据文件类型或大小异常，已保留原文件。');
      const text = await readFile(path, 'utf8');
      if (Buffer.byteLength(text) > limit) throw fail('storage_invalid', '插件数据文件超过上限。');
      let result: Record<string, unknown>;
      // Parser diagnostics include source lines: never expose credentials or OCR
      // text through the host's lifecycle error/log transport.
      try { result = parse(text); } catch { throw fail('storage_invalid', '插件数据文件格式不正确，已保留原文件。'); }
      if (result.schema_version !== 1) throw fail('storage_version', '插件数据版本不兼容，已保留原文件。');
      return result;
    } catch (e) {
      const code = errorCode(e);
      if (code === 'ENOENT') return null;
      if (code === 'storage_invalid' || code === 'storage_version') throw e;
      throw fail('storage_read_failed', '插件数据文件无法读取，已保留原文件。');
    }
  }
  async open(): Promise<this> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const prefs = await this.read('preferences.toml', 128 * 1024);
    if (prefs) {
      const settings = Object.fromEntries(Object.entries(prefs.settings ?? {}));
      this.settings = normalizeSettings(DEFAULTS, settings.backend ? settings : { ...settings, backend: 'nexa' });
    }
    const history = await this.read('history.toml', MAX_HISTORY_BYTES + 4 * 1024 * 1024);
    if (history) {
      if (!Array.isArray(history.results) || history.results.length > 100) throw fail('storage_invalid', '历史文件格式不正确，已保留原文件。');
      this.history = history.results.map(durableResult);
    }
    if (this.settings.rememberToken) {
      const credentials = await this.read('credentials.toml', 1024);
      if (credentials) this.token = normalizeToken(credentials.api_token, this.settings.backend);
    }
    return this;
  }
  async atomic(name: string, data: unknown): Promise<void> {
    const target = join(this.directory, name);
    try { const st = await lstat(target); if (!st.isFile() || st.isSymbolicLink()) throw fail('storage_invalid', '数据文件类型异常。'); } catch (e) { if (errorCode(e) !== 'ENOENT') throw e; }
    const tmp = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    let handle: FileHandle | null = null, published = false;
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
  async clearCredentials(): Promise<void> {
    const names = (await readdir(this.directory)).filter(name => name === 'credentials.toml' || /^\.credentials\.toml\.[a-f0-9-]{36}\.tmp$/.test(name));
    for (const name of names) await unlink(join(this.directory, name)).catch((e: unknown) => { if (errorCode(e) !== 'ENOENT') throw e; });
  }
  serialize(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task);
    this.chain = next.catch(() => {});
    return next;
  }
  saveSettings(settings: Settings, token: string): Promise<void> {
    return this.serialize(async () => {
      if (settings.rememberToken && token) await this.atomic('credentials.toml', { schema_version: 1, api_token: token });
      else await this.clearCredentials();
      await this.atomic('preferences.toml', { schema_version: 1, settings });
      this.settings = { ...settings }; this.token = token;
    });
  }
  addResult(result: unknown): Promise<void> {
    const copy = durableResult(result);
    if (!copy.text.trim()) return Promise.resolve();
    return this.serialize(async () => {
      const history = [copy, ...this.history.filter(r => r.id !== copy.id)].slice(0, 100);
      while (Buffer.byteLength(stringify(omitNulls({ schema_version: 1, results: history }))) > MAX_HISTORY_BYTES && history.length > 1) history.pop();
      await this.atomic('history.toml', { schema_version: 1, results: history });
      this.history = history;
    });
  }
  deleteHistory(id: unknown): Promise<void> {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return Promise.reject(fail('invalid_history', '请选择要删除的历史记录。'));
    return this.serialize(async () => {
      const history = this.history.filter(r => r.id !== id);
      await this.atomic('history.toml', { schema_version: 1, results: history }); this.history = history;
    });
  }
  clearHistory(): Promise<void> {
    return this.serialize(async () => {
      await this.atomic('history.toml', { schema_version: 1, results: [] }); this.history = [];
    });
  }
}
