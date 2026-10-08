import { marked } from "marked";
import DOMPurify from "dompurify";
import { MAX_QUEUE, prepareImage } from "./image.js";

const $ = (id) => document.getElementById(id);
const bridge = window.pluginBridge;
const imageCache = new Map();
const controls = {
  backend: $("backend"), baseUrl: $("base-url"), modelId: $("model-id"), prompt: $("prompt"),
  maxTokens: $("max-output"), timeoutSeconds: $("timeout"), maxImageEdge: $("image-edge"),
  rememberToken: $("remember-token"), autoLoad: $("auto-load"),
};
const numericFields = new Set(["maxTokens", "timeoutSeconds", "maxImageEdge"]);
const booleanFields = new Set(["rememberToken", "autoLoad"]);
const dirty = new Set();
const statuses = { pending: "待识别", running: "识别中", completed: "已完成", cancelled: "已停止", failed: "失败" };
const phases = { idle: "准备就绪", connecting: "正在连接本机服务…", checking_model: "正在检查模型状态…", switching_model: "正在切换所选模型…", loading: "正在加载模型，CPU 首次加载可能需要一些时间…", testing: "正在测试连接…", prefill: "正在编码图片与处理输入…", decode: "正在生成识别文本…", finished: "本张识别已结束", generating: "正在识别…", running: "正在识别…", preparing: "正在准备图片…", stopping: "正在停止并保存已有输出…", saving: "正在保存结果…", performance: "正在读取性能指标…" };
let snapshot = null;
let selectedQueueId = null;
let selection = { kind: "live", id: null };
let selectedResult = null;
let view = "markdown";
let previewMode = "fit-width";
let importing = false;
let actionBusy = false;
let disposed = false;
let saving = null;
let saveTimer = null;
let pollTimer = null;
let pollPromise = null;
let epoch = 0;
let resultEpoch = 0;
let previewEpoch = 0;
let tokenDirty = false;
let settingsInitialized = false;
let lastQueueKey = "";
let lastHistoryKey = "";
let lastResultKey = "";
let connectedOnce = false;
let lastExportMessage = null;
let deferredViewSave = false;

function notice(message, error = false) {
  $("notice").textContent = message || "";
  $("notice").hidden = !message;
  $("notice").className = `notice${error ? " error" : ""}`;
}

function message(error) {
  return error?.message || String(error || "操作失败，请重试。");
}

async function invoke(channel, payload = {}) {
  if (!bridge?.invoke) throw new Error("此页面需要在 PI Desktop OCR 插件中打开。");
  return bridge.invoke(channel, payload);
}

function applySnapshot(value) {
  if (!value?.settings || !Array.isArray(value.queue)) return;
  snapshot = value;
  for (const [key, input] of Object.entries(controls)) {
    if (dirty.has(key) || document.activeElement === input) continue;
    if (booleanFields.has(key)) input.checked = !!value.settings[key];
    else if (key !== "modelId") {
      if (key === "maxImageEdge" && ![...input.options].some((option) => option.value === String(value.settings[key]))) input.append(new Option(`${value.settings[key]} 像素`, String(value.settings[key])));
      input.value = value.settings[key] ?? "";
    }
  }
  if (!settingsInitialized) {
    view = value.settings.view || "markdown";
    settingsInitialized = true;
  }
  renderBackend();
  renderModels();
  if (!value.queue.some((item) => item.id === selectedQueueId)) {
    selectedQueueId = value.activeId || value.queue[0]?.id || null;
    void renderPreview();
  }
  for (const id of imageCache.keys()) if (!value.queue.some((item) => item.id === id)) imageCache.delete(id);
  render();
  if (!value.busy && deferredViewSave) { deferredViewSave = false; scheduleSave(); }
}

async function poll() {
  if (pollPromise || disposed) return pollPromise;
  clearTimeout(pollTimer);
  const requestEpoch = epoch;
  pollPromise = invoke("ocr.snapshot").then((value) => {
    if (!disposed && requestEpoch === epoch) applySnapshot(value);
  }).catch((error) => {
    if (!disposed) notice(message(error), true);
  }).finally(() => {
    pollPromise = null;
    if (!disposed) pollTimer = setTimeout(poll, snapshot?.busy ? 600 : 2000);
  });
  return pollPromise;
}

function fieldValue(key) {
  const input = controls[key];
  if (booleanFields.has(key)) return input.checked;
  if (numericFields.has(key)) {
    if (!input.validity.valid || input.value === "") throw new Error(`请检查“${input.closest("label").firstChild.textContent.trim()}”的范围。`);
    return Number(input.value);
  }
  return input.value;
}

async function flushSettings() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!dirty.size && !tokenDirty) return;
  if (snapshot?.busy) throw new Error("识别运行期间不能修改设置，请先停止。");
  const keys = [...dirty];
  const patch = Object.fromEntries(keys.map((key) => [key, key === "view" ? view : fieldValue(key)]));
  const token = tokenDirty ? $("token").value.trim() : undefined;
  if (token) validateToken(token);
  $("settings-status").textContent = "正在保存设置…";
  epoch++;
  saving = invoke("ocr.settings", { patch, ...(tokenDirty ? { token } : {}) }).then((value) => {
    for (const key of keys) {
      const current = key === "view" ? view : fieldValue(key);
      if (current === patch[key]) dirty.delete(key);
    }
    if ($("token").value.trim() === token) {
      $("token").value = "";
      tokenDirty = false;
    }
    applySnapshot(value);
    $("settings-status").textContent = value.persistenceError || "设置已保存为 TOML；图片和待运行队列不会写入磁盘。";
  }).catch((error) => {
    $("settings-status").textContent = `设置尚未保存：${message(error)}`;
    throw error;
  }).finally(() => { saving = null; });
  await saving;
  if (dirty.size || tokenDirty) await flushSettings();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  $("settings-status").textContent = "设置有修改，正在等待自动保存…";
  saveTimer = setTimeout(() => flushSettings().catch((error) => notice(message(error), true)), 650);
}

async function action(callback) {
  if (actionBusy) return;
  actionBusy = true;
  renderControls();
  try { await callback(); }
  catch (error) { notice(message(error), true); }
  finally { actionBusy = false; renderControls(); }
}

async function mutate(channel, payload) {
  epoch++;
  const value = await invoke(channel, payload);
  applySnapshot(value);
  return value;
}

function backend() { return controls.backend.value || snapshot?.settings.backend || "openai"; }

function validateToken(token) {
  if (backend() === "nexa") {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Nexa API 令牌应为 64 位小写十六进制字符，请复制或选择 api-token 文件。");
  } else if (!token || token.length > 4096 || /[\r\n\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("API 密钥应为 1 至 4096 个字符，不能含换行或控制字符。");
  }
}

function renderBackend() {
  const nexa = backend() === "nexa";
  const hasToken = snapshot?.hasToken && !dirty.has("backend") && !dirty.has("baseUrl");
  $("token").placeholder = hasToken ? "已设置；留空保持当前密钥" : nexa ? "粘贴 64 位 Nexa 本机 API 令牌" : "服务未设置密钥时可留空";
  $("credential-hint").textContent = nexa
    ? "Nexa 令牌文件通常在 %LOCALAPPDATA%\\Nexa\\secrets\\api-token。默认仅本次运行使用；勾选记住后保存到插件私有目录。"
    : "密钥可选，默认仅本次运行使用；勾选记住后保存到插件私有目录。当前支持 127.0.0.1 本机服务。";
  $("auto-load-option").hidden = !nexa;
  controls.maxTokens.max = nexa ? "4096" : "32768";
  controls.baseUrl.placeholder = nexa ? "http://127.0.0.1:18080" : "http://127.0.0.1:8080/v1";
}

function renderModels() {
  const input = $("model-id");
  const options = $("model-options");
  const selected = dirty.has("modelId") || document.activeElement === input ? input.value : snapshot.settings.modelId;
  const models = snapshot.models || [];
  const nexa = backend() === "nexa";
  const key = JSON.stringify([models, nexa]);
  if (options.dataset.key !== key) {
    options.dataset.key = key;
    options.replaceChildren();
    for (const model of models) {
      const suffix = nexa ? model.hasProjector === false ? " · 未配对 mmproj" : model.loadable === false ? " · 暂不可加载" : "" : "";
      const option = new Option(`${model.name || model.id}${suffix}`, model.id);
      options.append(option);
    }
  }
  input.value = selected || "";
  input.placeholder = nexa ? "输入 Nexa 中登记的模型 ID" : "输入模型 ID，或连接后选择";
}

function renderControls() {
  const busy = !!snapshot?.busy;
  const locked = busy || importing || actionBusy;
  for (const input of Object.values(controls)) input.disabled = locked;
  for (const id of ["token", "connect", "token-file-open", "remember-token", "clear-token", "auto-load"]) $(id).disabled = locked;
  $("clear-token").disabled ||= !snapshot?.hasToken;
  $("import").disabled = locked || !snapshot || (snapshot.queue.length >= MAX_QUEUE);
  $("clear-queue").disabled = locked || !snapshot?.queue.length;
  const pending = snapshot?.queue.filter((item) => item.status === "pending").length || 0;
  const configured = !!snapshot?.settings.modelId && (snapshot?.settings.backend !== "nexa" || !!snapshot?.hasToken);
  $("start").disabled = locked || !pending || !configured;
  $("stop").disabled = !busy || !!snapshot?.stopping;
  const started = snapshot?.queue.some((item) => item.status !== "pending");
  $("start").textContent = busy ? "识别中…" : started && pending ? `继续未开始的 ${pending} 张` : pending > 1 ? `开始识别 ${pending} 张` : "开始识别";
  $("stop").textContent = snapshot?.stopping ? "停止中…" : "停止";
  for (const button of document.querySelectorAll(".queue-actions button, .history-delete")) button.disabled = locked || button.dataset.boundary === "true";
  $("view-markdown").setAttribute("aria-pressed", String(view === "markdown"));
  $("view-source").setAttribute("aria-pressed", String(view === "text"));
}

function render() {
  if (!snapshot) return;
  const connection = snapshot.connection || {};
  const connected = connection.state === "connected";
  $("connection-badge").textContent = { connected: "服务已连接", connecting: "连接中…", disconnected: "尚未连接", error: "连接异常" }[connection.state] || "尚未连接";
  $("connection-badge").className = `badge${connected ? " success" : connection.state === "error" ? " error" : ""}`;
  $("connection-summary").textContent = connection.message || (connected ? snapshot.settings.baseUrl : "连接本机 OCR 服务");
  if (connected && !connectedOnce) { connectedOnce = true; $("connection-panel").open = false; }
  if (connection.state === "error") $("connection-panel").open = true;
  const model = snapshot.models?.find((item) => item.id === snapshot.settings.modelId);
  $("model-hint").textContent = backend() === "nexa"
    ? model ? `${model.name || model.id} · ${model.hasProjector ? "已配对 mmproj" : "尚未配对 mmproj"}。模型参数使用 Nexa 中保存的配置。` : "在 Nexa 登记主模型并配对 mmproj；可在下方启用开始识别时自动加载。"
    : "请在服务端加载支持图片输入的模型。模型列表不代表已验证图片识别能力，可手动填写模型 ID。";
  if (snapshot.persistenceError) $("settings-status").textContent = `保存失败：${snapshot.persistenceError}`;
  if (snapshot.exportMessage && snapshot.exportMessage !== lastExportMessage) {
    lastExportMessage = snapshot.exportMessage;
    notice(snapshot.exportMessage);
  }
  $("queue-count").textContent = `${snapshot.queue.length} / ${MAX_QUEUE}`;
  $("queue-empty").hidden = !!snapshot.queue.length;
  const completed = snapshot.queue.filter((item) => item.status === "completed").length;
  const pending = snapshot.queue.filter((item) => item.status === "pending").length;
  $("run-status").textContent = snapshot.busy ? phases[snapshot.phase] || "正在处理，请稍候…" : snapshot.error ? `${snapshot.error}${pending ? ` 还有 ${pending} 张未开始；继续不会重做失败项。` : ""}` : snapshot.queue.length ? `已完成 ${completed} 张 · 待识别 ${pending} 张` : "准备好模型和图片后开始";
  renderQueue();
  renderHistory();
  renderResult();
  renderControls();
}

function renderQueue() {
  const key = JSON.stringify([snapshot.queue, selectedQueueId]);
  if (key === lastQueueKey) return;
  lastQueueKey = key;
  const fragment = document.createDocumentFragment();
  snapshot.queue.forEach((item, index) => {
    const row = document.createElement("li");
    row.className = `queue-item${item.id === selectedQueueId ? " selected" : ""}`;
    const button = document.createElement("button");
    button.type = "button"; button.className = "queue-select";
    button.setAttribute("aria-label", `预览第 ${index + 1} 张：${item.name}`);
    const number = document.createElement("span"); number.className = "queue-number"; number.textContent = String(index + 1);
    const description = document.createElement("span"); description.className = "queue-description";
    const name = document.createElement("span"); name.className = "queue-filename"; name.textContent = item.name; name.title = item.name;
    const meta = document.createElement("span"); meta.className = "queue-meta"; meta.textContent = `${item.width} × ${item.height} · ${statuses[item.status] || item.status}`;
    description.append(name, meta); button.append(number, description);
    button.addEventListener("click", () => { selectedQueueId = item.id; renderQueue(); void renderPreview(); if (item.status !== "pending") void selectResult("queue", item.id); });
    const buttons = document.createElement("div"); buttons.className = "queue-actions";
    for (const [symbol, label, direction] of [["↑", "上移", -1], ["↓", "下移", 1], ["×", "移除", 0]]) {
      const control = document.createElement("button"); control.type = "button"; control.className = "icon-button"; control.textContent = symbol; control.title = `${label} ${item.name}`; control.setAttribute("aria-label", control.title);
      control.dataset.boundary = String(direction === -1 && index === 0 || direction === 1 && index === snapshot.queue.length - 1);
      control.addEventListener("click", () => action(async () => {
        await mutate("ocr.queue", direction ? { action: "move", id: item.id, direction } : { action: "remove", id: item.id });
      }));
      buttons.append(control);
    }
    row.append(button, buttons); fragment.append(row);
  });
  $("queue").replaceChildren(fragment);
  renderControls();
}

async function renderPreview() {
  const request = ++previewEpoch;
  const id = selectedQueueId;
  const item = snapshot?.queue.find((row) => row.id === id);
  $("preview-image").hidden = true;
  $("preview-image").removeAttribute("src");
  $("preview-empty").hidden = false;
  $("preview-info").textContent = "";
  if (!item) { $("preview-empty").textContent = "选择队列中的图片查看预览"; return; }
  $("preview-empty").textContent = "正在读取图片预览…";
  try {
    let cached = imageCache.get(id);
    if (!cached) {
      let dataUrl = "";
      let total = 0;
      do {
        const part = await invoke("ocr.image.read", { id, offset: dataUrl.length });
        if (request !== previewEpoch || disposed) return;
        if (typeof part.chunk !== "string" || !Number.isSafeInteger(part.total) || part.total < 1 || part.total > 5600000 || part.chunk.length > 196608 || part.chunk.length === 0 || total && total !== part.total) throw new Error("图片预览数据不完整，请重新导入。");
        total = part.total;
        dataUrl += part.chunk;
        if (dataUrl.length > total) throw new Error("图片预览数据长度不符。");
      } while (dataUrl.length < total);
      if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw new Error("图片预览编码无效。");
      cached = { dataUrl };
      imageCache.set(id, cached);
    }
    if (request !== previewEpoch || disposed) return;
    $("preview-image").src = cached.dataUrl;
    $("preview-image").alt = item.name;
    $("preview-image").hidden = false;
    $("preview-empty").hidden = true;
    $("preview-area").scrollTop = 0;
    $("preview-area").scrollLeft = 0;
    $("preview-info").textContent = `${item.name} · ${item.width} × ${item.height} · ${(item.bytes / 1024).toFixed(0)} KiB${cached.resized ? `（原图 ${cached.originalWidth} × ${cached.originalHeight}，已按设置缩放）` : ""}`;
  } catch (error) { if (request === previewEpoch) $("preview-empty").textContent = message(error); }
}

async function selectResult(kind, id) {
  selection = { kind, id };
  selectedResult = null;
  const request = ++resultEpoch;
  renderHistory(); renderResult();
  if (snapshot?.result?.id === id) { renderResult(); return; }
  try {
    const value = await invoke("ocr.result", { id });
    if (request !== resultEpoch || disposed) return;
    selectedResult = value;
    renderResult();
    if (!value) notice("这条结果已被移除或尚未生成。");
  } catch (error) { if (request === resultEpoch) notice(message(error), true); }
}

function currentResult() {
  if (selection.kind === "live" || snapshot?.result?.id === selection.id) return snapshot?.result;
  return selectedResult;
}

function renderHistory() {
  const history = snapshot.history || [];
  $("history-count").textContent = String(history.length);
  $("history-empty").hidden = !!history.length;
  const key = JSON.stringify([history, selection]);
  if (key === lastHistoryKey) return;
  lastHistoryKey = key;
  const fragment = document.createDocumentFragment();
  for (const item of history) {
    const row = document.createElement("li"); row.className = `history-item${selection.id === item.id ? " selected" : ""}`;
    const open = document.createElement("button"); open.type = "button"; open.className = "history-select";
    const title = document.createElement("strong"); title.textContent = item.name;
    const info = document.createElement("span");
    const date = new Date(item.createdAt);
    info.textContent = `${Number.isNaN(date.valueOf()) ? item.createdAt : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} · ${item.complete ? "完整" : "可能不完整"} · ${item.modelId}`;
    open.append(title, info); open.title = item.preview || item.name;
    open.addEventListener("click", () => selectResult("history", item.id));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "icon-button history-delete"; remove.textContent = "×"; remove.title = `删除历史记录 ${item.name}`; remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => action(async () => {
      await mutate("ocr.history.delete", { id: item.id });
      if (selection.id === item.id) { selection = { kind: "live", id: null }; selectedResult = null; resultEpoch++; renderResult(); }
    }));
    row.append(open, remove); fragment.append(row);
  }
  $("history-list").replaceChildren(fragment);
}

function renderResult() {
  const result = currentResult();
  const hasText = !!result?.text;
  $("copy").disabled = !hasText;
  $("export").disabled = !hasText || result?.status === "running" || !!snapshot?.exporting;
  $("export").textContent = snapshot?.exporting ? "正在另存…" : "另存为";
  $("result-name").textContent = result?.name || (selection.kind === "live" ? "等待识别" : "正在读取结果…");
  $("return-live").hidden = selection.kind === "live";
  $("result-badge").hidden = !result;
  $("result-badge").textContent = result?.status === "running" ? "正在输出" : result?.complete ? "完整" : "可能不完整";
  $("result-badge").className = `badge${result?.complete ? " success" : result?.status === "running" ? "" : " warning"}`;
  $("result-error").hidden = !result?.error && result?.finishReason !== "length";
  $("result-error").textContent = result?.error || (result?.finishReason === "length" ? "本次输出达到最大 token 上限，内容可能不完整。可调整参数后重新导入该图片识别。" : "");
  $("result-empty").hidden = hasText;
  $("markdown-output").hidden = !hasText || view !== "markdown";
  $("source-output").hidden = !hasText || view !== "text";
  const key = JSON.stringify([result?.id, result?.text, view]);
  if (key !== lastResultKey) {
    lastResultKey = key;
    if (hasText && view === "markdown") {
      const html = marked.parse(result.text, { async: false, gfm: true, breaks: false });
      $("markdown-output").innerHTML = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "del", "s", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "a", "span", "sub", "sup"],
        ALLOWED_ATTR: ["colspan", "rowspan", "align", "start"],
        ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
      });
    } else if (hasText) $("source-output").textContent = result.text;
    if (!hasText) { $("markdown-output").replaceChildren(); $("source-output").textContent = ""; }
  }
  renderPerformance(result);
}

function number(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function time(value, divisor = 1000) { const n = number(value); return n === null ? "耗时不可用" : `${(n / divisor).toFixed(2)} ms`; }
function renderPerformance(result) {
  $("performance").hidden = !result || !result.text;
  if (!result) return;
  const record = result.performance;
  const timings = record?.status === "completed" ? record.performance?.timings : null;
  const usage = record?.usage || result.usage;
  const rate = (phase, tokens) => {
    const micros = number(timings?.[`${phase}_us`]);
    const count = number(tokens);
    return micros === null || micros === 0 || count === null ? "不可用" : `${(count / micros * 1e6).toFixed(2)} token/s`;
  };
  $("prefill-rate").textContent = rate("prefill", usage?.prompt_tokens);
  $("decode-rate").textContent = rate("decode", usage?.completion_tokens);
  $("prefill-time").textContent = time(timings?.prefill_us);
  $("decode-time").textContent = time(timings?.decode_us);
  $("token-counts").textContent = number(usage?.prompt_tokens) !== null && number(usage?.completion_tokens) !== null ? `${usage.prompt_tokens} / ${usage.completion_tokens}` : "不可用";
  $("execution-time").textContent = record ? `执行 ${time(record.timings?.execution_ms, 1)}` : "执行耗时不可用";
  $("elapsed-time").textContent = number(result.elapsedMs) === null ? "本次总耗时不可用" : `本次总耗时 ${(result.elapsedMs / 1000).toFixed(2)} 秒（含请求准备与加载）`;
  $("performance-status").textContent = result.status === "running" ? "完成后显示" : !record ? "后端未提供分阶段指标" : "";
  $("performance-note").textContent = timings
    ? "Prefill 含图片编码；Decode 已扣同步输出回调。执行耗时不含排队与加载，缺失指标不会估算为 0。"
    : "此结果没有 Prefill / Decode 分阶段数据，无法计算对应速度。总耗时包含请求准备；token 用量仅显示后端返回的数值。";
}

async function uploadImage(image) {
  const mimeType = image.dataUrl.slice(5, image.dataUrl.indexOf(";"));
  const { uploadId } = await invoke("ocr.image.begin", { name: image.name, width: image.width, height: image.height, bytes: image.bytes, mimeType, dataLength: image.dataUrl.length });
  try {
    for (let offset = 0; offset < image.dataUrl.length; offset += 196608) {
      if (disposed) throw new Error("页面已关闭，图片导入中止。");
      await invoke("ocr.image.chunk", { uploadId, chunk: image.dataUrl.slice(offset, offset + 196608) });
    }
    const { id } = await invoke("ocr.image.commit", { uploadId });
    imageCache.set(id, image);
    return id;
  } catch (error) {
    await invoke("ocr.image.abort", { uploadId }).catch(() => {});
    throw error;
  }
}

async function importFiles(files) {
  if (importing || snapshot?.busy || !files.length) return;
  importing = true;
  renderControls();
  let imported = 0;
  const failures = [];
  try {
    await flushSettings();
    const available = MAX_QUEUE - (snapshot?.queue.length || 0);
    if (files.length > available) throw new Error(`队列还可导入 ${available} 张，请减少所选图片；本次没有导入。`);
    const edge = Number(controls.maxImageEdge.value);
    epoch++;
    for (const [index, file] of files.entries()) {
      $("import-progress").textContent = `正在导入 ${index + 1} / ${files.length}：${file.name}`;
      try {
        const image = await prepareImage(file, edge);
        const id = await uploadImage(image);
        selectedQueueId ||= id;
        imported++;
      } catch (error) { failures.push(`${file.name}：${message(error)}`); }
    }
    applySnapshot(await invoke("ocr.snapshot"));
    await renderPreview();
    notice(`已按导入顺序添加 ${imported} 张图片。${failures.length ? `\n${failures.join("\n")}` : ""}`, !!failures.length);
  } catch (error) { notice(message(error), true); }
  finally {
    importing = false;
    $("file-input").value = "";
    $("import-progress").textContent = "按选择顺序识别，最多 20 张；单张 PNG/JPEG ≤ 4 MiB。";
    renderControls();
  }
}

function setHistoryOpen(open) {
  $("history-panel").hidden = !open;
  $("history-toggle").setAttribute("aria-expanded", String(open));
}

for (const [key, input] of Object.entries(controls)) {
  input.addEventListener(input.tagName === "SELECT" || booleanFields.has(key) ? "change" : "input", () => {
    dirty.add(key);
    if (key === "backend" || key === "baseUrl") {
      // Never carry a key to a changed destination. A key explicitly typed after
      // this change may be saved in the same settings request for that endpoint.
      $("token").value = "";
      tokenDirty = false;
      connectedOnce = false;
      if (key === "backend") {
        controls.baseUrl.value = backend() === "nexa" ? "http://127.0.0.1:18080" : "http://127.0.0.1:8080/v1";
        controls.modelId.value = "";
        controls.autoLoad.checked = false;
        for (const dependent of ["baseUrl", "modelId", "autoLoad"]) dirty.add(dependent);
        if (backend() === "nexa" && Number(controls.maxTokens.value) > 4096) { controls.maxTokens.value = "4096"; dirty.add("maxTokens"); }
      }
      $("model-options").replaceChildren();
      delete $("model-options").dataset.key;
      renderBackend();
      notice("后端或地址已修改，原密钥和连接将清除。若新服务需要密钥，请重新填写后连接。");
    }
    scheduleSave();
  });
}
$("token").addEventListener("input", () => { tokenDirty = true; scheduleSave(); });
$("connection-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(async () => { await flushSettings(); await mutate("ocr.connect"); notice("正在连接本机服务…"); void poll(); });
});
$("clear-token").addEventListener("click", () => action(async () => { await mutate("ocr.clearToken"); $("token").value = ""; tokenDirty = false; notice("已清除插件保存的 API 密钥。"); }));
$("token-file-open").addEventListener("click", () => $("token-file").click());
$("token-file").addEventListener("change", async () => {
  const file = $("token-file").files?.[0];
  if (!file) return;
  try {
    if (file.size > 16384 || file.size < 1) throw new Error("请选择只包含 API 密钥的文本文件（最多 16 KiB）。");
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).trim()); reader.onerror = () => reject(new Error("密钥文件读取失败。")); reader.onabort = () => reject(new Error("密钥文件读取已中止。")); reader.readAsText(file);
    });
    validateToken(text);
    $("token").value = text; tokenDirty = true; await flushSettings(); notice("API 密钥已导入，可以连接本机服务。");
  } catch (error) { notice(message(error), true); }
  finally { $("token-file").value = ""; }
});
$("import").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", () => importFiles(Array.from($("file-input").files || [])));
$("clear-queue").addEventListener("click", () => action(async () => { await mutate("ocr.queue", { action: "clear" }); notice("图片队列已清空，已保存的识别历史仍可查看。"); }));
$("start").addEventListener("click", () => action(async () => {
  await flushSettings(); selection = { kind: "live", id: null }; selectedResult = null; resultEpoch++;
  await mutate("ocr.start"); notice(""); await poll();
}));
// Stop is intentionally independent of the action lock so it can interrupt work.
$("stop").addEventListener("click", async () => {
  $("stop").disabled = true;
  try {
    await mutate("ocr.stop");
    notice(backend() === "nexa" ? "正在停止。已有文字将保留，未开始的图片可稍后继续。" : "正在停止本次请求并断开连接。已有文字将保留；通用接口无法确认服务端已取消推理，请检查服务状态后继续。");
    await poll();
  }
  catch (error) { notice(message(error), true); }
});
$("preview-mode").addEventListener("change", () => { previewMode = $("preview-mode").value; $("preview-area").className = `preview-area ${previewMode}`; });
for (const [id, next] of [["view-markdown", "markdown"], ["view-source", "text"]]) $(id).addEventListener("click", () => {
  view = next; renderResult(); renderControls();
  dirty.add("view");
  if (!snapshot?.busy) scheduleSave();
  else deferredViewSave = true;
});
$("history-toggle").addEventListener("click", () => setHistoryOpen($("history-panel").hidden));
$("history-close").addEventListener("click", () => setHistoryOpen(false));
$("return-live").addEventListener("click", () => { selection = { kind: "live", id: null }; selectedResult = null; resultEpoch++; renderHistory(); renderResult(); });
$("copy").addEventListener("click", async () => {
  const result = currentResult(); if (!result?.text) return;
  try { await invoke("clipboard.writeText", { text: result.text }); notice("识别原文已复制，未附加性能摘要。"); }
  catch (error) { notice(message(error), true); }
});
$("export").addEventListener("click", () => action(async () => {
  const result = currentResult(); if (!result?.text) return;
  const exported = await invoke("ocr.export", { id: result.id });
  if (exported?.cancelled || exported?.saved === false) return;
  notice(exported?.started ? "请选择 Markdown 保存目录…" : "Markdown 已保存到所选目录。");
}));

// Adapted from VastSa Side Chat's MIT appearance helper: follow the host's
// resolved palette, preserve it on system-only updates, and apply theme tokens.
let appearanceFingerprint = "";
function applyAppearance(value) {
  if (!value || typeof value !== "object") return;
  const fingerprint = JSON.stringify(value);
  if (fingerprint === appearanceFingerprint) return;
  appearanceFingerprint = fingerprint;
  const base = ["light", "dark"].includes(value.base) ? value.base : ["light", "dark"].includes(value.theme) ? value.theme : value.pluginTheme?.base;
  if (["light", "dark"].includes(base)) document.documentElement.dataset.theme = base;
  document.documentElement.dataset.hostLocale = value.locale || "zh-CN";
  let style = $("host-theme");
  if (!style) { style = document.createElement("style"); style.id = "host-theme"; document.head.append(style); }
  // The host validates and sanitizes plugin theme CSS before this delivery.
  style.textContent = typeof value.pluginTheme?.css === "string" ? value.pluginTheme.css : "";
}

if (bridge?.on) bridge.on("appearance:changed", applyAppearance);
void invoke("app.getAppearance").then(applyAppearance).catch(() => {
  if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
});
const appearanceTimer = setInterval(() => {
  if (!document.hidden) void invoke("app.getAppearance").then(applyAppearance).catch(() => {});
}, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void poll(); });
window.addEventListener("pagehide", () => {
  if (!snapshot?.busy && (dirty.size || tokenDirty)) void flushSettings().catch(() => {});
  disposed = true; previewEpoch++; resultEpoch++;
  clearTimeout(pollTimer); clearTimeout(saveTimer); clearInterval(appearanceTimer);
  imageCache.clear();
  // Do not stop the shared controller when one of its two possible views closes.
});
renderControls();
void poll();
