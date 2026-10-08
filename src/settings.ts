import { normalizeOpenAIBaseUrl } from './openai-client.ts';
import type { Backend, Capabilities, Settings } from '../shared/contracts.ts';

export const ENDPOINTS: Readonly<Record<Backend, string>> = Object.freeze({ openai: 'http://127.0.0.1:8080/v1', nexa: 'http://127.0.0.1:18080' });
export const DEFAULTS: Readonly<Settings> = Object.freeze({
  backend: 'openai', baseUrl: ENDPOINTS.openai, modelId: '', prompt: 'Text Recognition:',
  maxTokens: 4096, timeoutSeconds: 1800, maxImageEdge: 0, view: 'markdown',
  previewMode: 'fit-width', historyView: 'markdown',
  autoLoad: false, rememberToken: false,
});
export function fail(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
export function capabilitiesFor(backend: Backend): Capabilities {
  return { autoLoad: backend === 'nexa', performance: backend === 'nexa', requiresToken: backend === 'nexa', manualModelId: backend === 'openai' };
}
export function normalizeSettings(previous: Readonly<Settings>, patch: unknown): Settings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('invalid_settings', '设置格式不正确。');
  if (Object.keys(patch).some(key => !Object.hasOwn(DEFAULTS, key))) throw fail('invalid_settings', '包含不支持的设置项。');
  const next: Record<string, unknown> = { ...previous, ...patch };
  if (next.backend !== 'openai' && next.backend !== 'nexa') throw fail('invalid_settings', '请选择支持的后端类型。');
  const backend = next.backend;
  if (backend !== previous.backend) {
    for (const [key, value] of Object.entries({ baseUrl: ENDPOINTS[backend], modelId: '', autoLoad: false, maxTokens: 4096 })) {
      if (!Object.hasOwn(patch, key)) next[key] = value;
    }
  }
  const apiBase = normalizeOpenAIBaseUrl(next.baseUrl);
  const baseUrl = backend === 'nexa' ? new URL(apiBase).origin : apiBase;
  const { modelId, prompt, maxTokens, timeoutSeconds, maxImageEdge, view, previewMode, historyView, autoLoad, rememberToken } = next;
  if (typeof modelId !== 'string' || modelId.length > 256 || /[\s\x00-\x1f\x7f]/.test(modelId) || (backend === 'nexa' && modelId && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(modelId))) throw fail('invalid_settings', '模型 ID 格式不正确，请填写服务提供的准确模型 ID。');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16384 || Buffer.byteLength(prompt) > 32768) throw fail('invalid_settings', '提示词不能为空，且最多 16384 个字符 / 32 KiB。');
  const maxTokenLimit = backend === 'nexa' ? 4096 : 32768;
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > maxTokenLimit) throw fail('invalid_settings', `maxTokens 必须为 1–${maxTokenLimit} 的整数。`);
  if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 86400) throw fail('invalid_settings', 'timeoutSeconds 必须为 30–86400 的整数。');
  if (typeof maxImageEdge !== 'number' || !Number.isInteger(maxImageEdge) || (maxImageEdge !== 0 && (maxImageEdge < 256 || maxImageEdge > 8192))) throw fail('invalid_settings', '最长边应为 0（原图）或 256–8192。');
  if ((view !== 'markdown' && view !== 'text') || typeof autoLoad !== 'boolean' || typeof rememberToken !== 'boolean') throw fail('invalid_settings', '视图或开关设置不正确。');
  if (previewMode !== 'fit-width' && previewMode !== 'fit' && previewMode !== 'actual') throw fail('invalid_settings', '图片预览模式不正确。');
  if (historyView !== 'markdown' && historyView !== 'text') throw fail('invalid_settings', '历史记录视图不正确。');
  return { backend, baseUrl, modelId, prompt, maxTokens, timeoutSeconds, maxImageEdge, view, previewMode, historyView, autoLoad: backend === 'openai' ? false : autoLoad, rememberToken };
}
export function normalizeToken(token: unknown, backend: Backend = 'openai'): string {
  if (typeof token !== 'string' || token.length > 4096 || !/^[\x20-\x7e]*$/.test(token.trim())) throw fail('invalid_token', 'API 密钥最多4096个可打印ASCII字符，不能包含换行或控制字符。');
  const value = token.trim();
  if (backend === 'nexa' && value && !/^[a-f0-9]{64}$/.test(value)) throw fail('invalid_token', 'Nexa 令牌应为64位小写十六进制文本，请选择正确的 api-token 文件。');
  return value;
}
