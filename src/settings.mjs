import { normalizeOpenAIBaseUrl } from './openai-client.mjs';

export const ENDPOINTS = Object.freeze({ openai: 'http://127.0.0.1:8080/v1', nexa: 'http://127.0.0.1:18080' });
export const DEFAULTS = Object.freeze({
  backend: 'openai', baseUrl: ENDPOINTS.openai, modelId: '', prompt: 'Text Recognition:',
  maxTokens: 4096, timeoutSeconds: 1800, maxImageEdge: 0, view: 'markdown',
  autoLoad: false, rememberToken: false,
});
export function fail(code, message) { return Object.assign(new Error(message), { code }); }
export function capabilitiesFor(backend) {
  return { autoLoad: backend === 'nexa', performance: backend === 'nexa', requiresToken: backend === 'nexa', manualModelId: backend === 'openai' };
}
export function normalizeSettings(previous, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('invalid_settings', '设置格式不正确。');
  if (Object.keys(patch).some(key => !Object.hasOwn(DEFAULTS, key))) throw fail('invalid_settings', '包含不支持的设置项。');
  const next = { ...previous, ...patch };
  if (!Object.hasOwn(ENDPOINTS, next.backend)) throw fail('invalid_settings', '请选择支持的后端类型。');
  if (next.backend !== previous.backend) {
    for (const [key, value] of Object.entries({ baseUrl: ENDPOINTS[next.backend], modelId: '', autoLoad: false, maxTokens: 4096 })) {
      if (!Object.hasOwn(patch, key)) next[key] = value;
    }
  }
  const apiBase = normalizeOpenAIBaseUrl(next.baseUrl);
  next.baseUrl = next.backend === 'nexa' ? new URL(apiBase).origin : apiBase;
  if (typeof next.modelId !== 'string' || next.modelId.length > 256 || /[\s\x00-\x1f\x7f]/.test(next.modelId) || (next.backend === 'nexa' && next.modelId && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(next.modelId))) throw fail('invalid_settings', '模型 ID 格式不正确，请填写服务提供的准确模型 ID。');
  if (typeof next.prompt !== 'string' || !next.prompt.trim() || next.prompt.length > 16384 || Buffer.byteLength(next.prompt) > 32768) throw fail('invalid_settings', '提示词不能为空，且最多 16384 个字符 / 32 KiB。');
  for (const [key, min, max] of [['maxTokens', 1, next.backend === 'nexa' ? 4096 : 32768], ['timeoutSeconds', 30, 86400]]) {
    if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) throw fail('invalid_settings', `${key} 必须为 ${min}–${max} 的整数。`);
  }
  if (!Number.isInteger(next.maxImageEdge) || (next.maxImageEdge !== 0 && (next.maxImageEdge < 256 || next.maxImageEdge > 8192))) throw fail('invalid_settings', '最长边应为 0（原图）或 256–8192。');
  if (!['markdown', 'text'].includes(next.view) || typeof next.autoLoad !== 'boolean' || typeof next.rememberToken !== 'boolean') throw fail('invalid_settings', '视图或开关设置不正确。');
  if (next.backend === 'openai') next.autoLoad = false;
  return next;
}
export function normalizeToken(token, backend = 'openai') {
  if (typeof token !== 'string' || token.length > 4096 || !/^[\x20-\x7e]*$/.test(token.trim())) throw fail('invalid_token', 'API 密钥最多4096个可打印ASCII字符，不能包含换行或控制字符。');
  const value = token.trim();
  if (backend === 'nexa' && value && !/^[a-f0-9]{64}$/.test(value)) throw fail('invalid_token', 'Nexa 令牌应为64位小写十六进制文本，请选择正确的 api-token 文件。');
  return value;
}
