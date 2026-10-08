import { marked } from "marked";
import DOMPurify from "dompurify";
import { MAX_QUEUE, prepareImage, type PreparedImage } from "./image.ts";
import type { Channel, InvokeArgs, OcrInvoke, Reply, Settings, Snapshot, OcrResult, HistoryResult } from "../shared/contracts.ts";

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`界面元素缺失：${id}`);
  return element;
}
function inputElement(id: string): HTMLInputElement {
  const element = $(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`输入元素类型错误：${id}`);
  return element;
}
function selectElement(id: string): HTMLSelectElement {
  const element = $(id);
  if (!(element instanceof HTMLSelectElement)) throw new Error(`选择元素类型错误：${id}`);
  return element;
}
function textAreaElement(id: string): HTMLTextAreaElement {
  const element = $(id);
  if (!(element instanceof HTMLTextAreaElement)) throw new Error(`文本元素类型错误：${id}`);
  return element;
}
function buttonElement(id: string): HTMLButtonElement {
  const element = $(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`按钮元素类型错误：${id}`);
  return element;
}
function imageElement(id: string): HTMLImageElement {
  const element = $(id);
  if (!(element instanceof HTMLImageElement)) throw new Error(`图片元素类型错误：${id}`);
  return element;
}
function detailsElement(id: string): HTMLDetailsElement {
  const element = $(id);
  if (!(element instanceof HTMLDetailsElement)) throw new Error(`折叠元素类型错误：${id}`);
  return element;
}
interface CachedImage {
  dataUrl: string;
  resized?: boolean;
  originalWidth?: number;
  originalHeight?: number;
}
type ResultSelection = { kind: "live"; id: null } | { kind: "queue"; id: string };
type DisplayResult = OcrResult | HistoryResult;
const bridge = window.pluginBridge;
const imageCache = new Map<string, CachedImage>();
const controls = {
  backend: selectElement("backend"), baseUrl: inputElement("base-url"), modelId: inputElement("model-id"), prompt: textAreaElement("prompt"),
  maxTokens: inputElement("max-output"), timeoutSeconds: inputElement("timeout"), maxImageEdge: selectElement("image-edge"),
  rememberToken: inputElement("remember-token"), autoLoad: inputElement("auto-load"),
};
type ControlKey = keyof typeof controls;
type DirtyKey = ControlKey | "view";
const controlKeys: readonly ControlKey[] = ["backend", "baseUrl", "modelId", "prompt", "maxTokens", "timeoutSeconds", "maxImageEdge", "rememberToken", "autoLoad"];
const booleanFields = new Set<ControlKey>(["rememberToken", "autoLoad"]);
const dirty = new Set<DirtyKey>();
const statuses = { pending: "待识别", running: "识别中", completed: "已完成", cancelled: "已停止", failed: "失败" };
const phases: Record<string, string> = { idle: "准备就绪", connecting: "正在连接本机服务…", checking_model: "正在检查模型状态…", switching_model: "正在切换所选模型…", loading: "正在加载模型，CPU 首次加载可能需要一些时间…", testing: "正在测试连接…", prefill: "正在编码图片与处理输入…", decode: "正在生成识别文本…", finished: "本张识别已结束", generating: "正在识别…", running: "正在识别…", preparing: "正在准备图片…", stopping: "正在停止并保存已有输出…", saving: "正在保存结果…", performance: "正在读取性能指标…" };
let snapshot: Snapshot | null = null;
let selectedQueueId: string | null = null;
let selection: ResultSelection = { kind: "live", id: null };
let selectedResult: DisplayResult | null = null;
let view: Settings["view"] = "markdown";
let previewMode = "fit-width";
let selectedHistoryId: string | null = null;
let selectedHistory: HistoryResult | null = null;
let historyView: Settings["view"] = "markdown";
let historyEpoch = 0;
let lastHistoryResultKey = "";
let historyLoading = false;
let importing = false;
let actionBusy = false;
let disposed = false;
let saving: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let pollPromise: Promise<void> | null = null;
let epoch = 0;
let resultEpoch = 0;
let previewEpoch = 0;
let tokenDirty = false;
let settingsInitialized = false;
let lastQueueKey = "";
let lastHistoryKey = "";
let lastResultKey = "";
let connectedOnce = false;
let lastExportMessage: string | null = null;
let deferredViewSave = false;

function notice(message: string, error = false): void {
  $("notice").textContent = message || "";
  $("notice").hidden = !message;
  $("notice").className = `notice${error ? " error" : ""}`;
}

function message(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" && error.message) return error.message;
  return String(error || "操作失败，请重试。");
}

const invoke: OcrInvoke = async <C extends Channel>(...args: InvokeArgs<C>): Promise<Reply<C>> => {
  if (!bridge?.invoke) throw new Error("此页面需要在 PI Desktop OCR 插件中打开。");
  return bridge.invoke(...args);
};
async function getAppearance(): Promise<unknown> {
  if (!bridge?.invoke) throw new Error("此页面需要在 PI Desktop OCR 插件中打开。");
  return bridge.invoke("app.getAppearance");
}
async function copyText(text: string): Promise<void> {
  if (!bridge?.invoke) throw new Error("此页面需要在 PI Desktop OCR 插件中打开。");
  await bridge.invoke("clipboard.writeText", { text });
}

function applySnapshot(value: Snapshot): void {
  if (!value?.settings || !Array.isArray(value.queue)) return;
  snapshot = value;
  for (const key of controlKeys) {
    const input = controls[key];
    if (dirty.has(key) || document.activeElement === input) continue;
    if (key === "rememberToken" || key === "autoLoad") controls[key].checked = !!value.settings[key];
    else if (key !== "modelId") {
      if (key === "maxImageEdge" && ![...controls.maxImageEdge.options].some((option) => option.value === String(value.settings[key]))) controls.maxImageEdge.append(new Option(`${value.settings[key]} 像素`, String(value.settings[key])));
      input.value = String(value.settings[key] ?? "");
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

async function poll(): Promise<void> {
  if (pollPromise) return pollPromise;
  if (disposed) return;
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

function numericValue(input: HTMLInputElement | HTMLSelectElement): number {
  if (!input.validity.valid || input.value === "") {
    const label = input.closest("label")?.firstChild?.textContent?.trim() || input.id;
    throw new Error(`请检查“${label}”的范围。`);
  }
  return Number(input.value);
}
const fieldReaders: { [K in DirtyKey]: () => Settings[K] } = {
  backend,
  baseUrl: () => controls.baseUrl.value,
  modelId: () => controls.modelId.value,
  prompt: () => controls.prompt.value,
  maxTokens: () => numericValue(controls.maxTokens),
  timeoutSeconds: () => numericValue(controls.timeoutSeconds),
  maxImageEdge: () => numericValue(controls.maxImageEdge),
  rememberToken: () => controls.rememberToken.checked,
  autoLoad: () => controls.autoLoad.checked,
  view: () => view,
};
function fieldValue<K extends DirtyKey>(key: K): Settings[K] { return fieldReaders[key](); }
function readPatchField<K extends DirtyKey>(patch: Partial<Settings>, key: K): void { patch[key] = fieldValue(key); }

async function flushSettings() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!dirty.size && !tokenDirty) return;
  if (snapshot?.busy) throw new Error("识别运行期间不能修改设置，请先停止。");
  const keys = [...dirty];
  const patch: Partial<Settings> = {};
  for (const key of keys) readPatchField(patch, key);
  const token = tokenDirty ? inputElement("token").value.trim() : undefined;
  if (token) validateToken(token);
  $("settings-status").textContent = "正在保存设置…";
  epoch++;
  saving = invoke("ocr.settings", { patch, ...(tokenDirty ? { token } : {}) }).then((value) => {
    for (const key of keys) {
      const current = key === "view" ? view : fieldValue(key);
      if (current === patch[key]) dirty.delete(key);
    }
    if (inputElement("token").value.trim() === token) {
      inputElement("token").value = "";
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

async function action(callback: () => Promise<void>): Promise<void> {
  if (actionBusy) return;
  actionBusy = true;
  renderControls();
  try { await callback(); }
  catch (error) { notice(message(error), true); }
  finally { actionBusy = false; renderControls(); }
}

type MutationChannel = "ocr.settings" | "ocr.clearToken" | "ocr.connect" | "ocr.queue" | "ocr.start" | "ocr.stop" | "ocr.history.delete" | "ocr.history.clear";
async function mutate<C extends MutationChannel>(...args: InvokeArgs<C>): Promise<Reply<C>> {
  epoch++;
  const value = await invoke<C>(...args);
  if ("settings" in value) applySnapshot(value);
  return value;
}

function backend(): Settings["backend"] {
  const value = controls.backend.value || snapshot?.settings.backend || "openai";
  if (value !== "openai" && value !== "nexa") throw new Error("后端类型无效。");
  return value;
}

function validateToken(token: string): void {
  if (backend() === "nexa") {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Nexa API 令牌应为 64 位小写十六进制字符，请复制或选择 api-token 文件。");
  } else if (!token || token.length > 4096 || /[\r\n\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("API 密钥应为 1 至 4096 个字符，不能含换行或控制字符。");
  }
}

function renderBackend() {
  const nexa = backend() === "nexa";
  const hasToken = snapshot?.hasToken && !dirty.has("backend") && !dirty.has("baseUrl");
  inputElement("token").placeholder = hasToken ? "已设置；留空保持当前密钥" : nexa ? "粘贴 64 位 Nexa 本机 API 令牌" : "服务未设置密钥时可留空";
  $("credential-hint").textContent = nexa
    ? "Nexa 令牌文件通常在 %LOCALAPPDATA%\\Nexa\\secrets\\api-token。默认仅本次运行使用；勾选记住后保存到插件私有目录。"
    : "密钥可选，默认仅本次运行使用；勾选记住后保存到插件私有目录。当前支持 127.0.0.1 本机服务。";
  $("auto-load-option").hidden = !nexa;
  controls.maxTokens.max = nexa ? "4096" : "32768";
  controls.baseUrl.placeholder = nexa ? "http://127.0.0.1:18080" : "http://127.0.0.1:8080/v1";
}

function renderModels() {
  if (!snapshot) return;
  const input = inputElement("model-id");
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
  for (const element of [inputElement("token"), buttonElement("connect"), buttonElement("token-file-open"), controls.rememberToken, buttonElement("clear-token"), controls.autoLoad]) element.disabled = locked;
  buttonElement("clear-token").disabled ||= !snapshot?.hasToken;
  buttonElement("import").disabled = locked || !snapshot || (snapshot.queue.length >= MAX_QUEUE);
  buttonElement("clear-queue").disabled = locked || !snapshot?.queue.length;
  const pending = snapshot?.queue.filter((item) => item.status === "pending").length || 0;
  const configured = !!snapshot?.settings.modelId && (snapshot?.settings.backend !== "nexa" || !!snapshot?.hasToken);
  buttonElement("start").disabled = locked || !pending || !configured;
  buttonElement("stop").disabled = !busy || !!snapshot?.stopping;
  const started = snapshot?.queue.some((item) => item.status !== "pending");
  buttonElement("start").textContent = busy ? "识别中…" : started && pending ? `继续未开始的 ${pending} 张` : pending > 1 ? `开始识别 ${pending} 张` : "开始识别";
  buttonElement("stop").textContent = snapshot?.stopping ? "停止中…" : "停止";
  for (const button of document.querySelectorAll(".queue-actions button, .history-delete")) {
    if (button instanceof HTMLButtonElement) button.disabled = locked || button.dataset.boundary === "true";
  }
  buttonElement("view-markdown").setAttribute("aria-pressed", String(view === "markdown"));
  buttonElement("view-source").setAttribute("aria-pressed", String(view === "text"));
}

function render() {
  if (!snapshot) return;
  const connection = snapshot.connection || {};
  const connected = connection.state === "connected";
  $("connection-badge").textContent = { connected: "服务已连接", connecting: "连接中…", disconnected: "尚未连接", error: "连接异常" }[connection.state] || "尚未连接";
  $("connection-badge").className = `badge${connected ? " success" : connection.state === "error" ? " error" : ""}`;
  $("connection-summary").textContent = connection.message || (connected ? snapshot.settings.baseUrl : "连接本机 OCR 服务");
  if (connected && !connectedOnce) { connectedOnce = true; detailsElement("connection-panel").open = false; }
  if (connection.state === "error") detailsElement("connection-panel").open = true;
  const modelId = snapshot.settings.modelId;
  const model = snapshot.models?.find((item) => item.id === modelId);
  $("model-hint").textContent = backend() === "nexa"
    ? model ? `${model.name || model.id} · ${model.hasProjector ? "已配对 mmproj" : "尚未配对 mmproj"}。模型参数使用 Nexa 中保存的配置。` : "在 Nexa 登记主模型并配对 mmproj；可在下方启用开始识别时自动加载。"
    : "请在服务端加载支持图片输入的模型。模型列表不代表已验证图片识别能力，可手动填写模型 ID。";
  if (snapshot.persistenceError) $("settings-status").textContent = `保存失败：${snapshot.persistenceError}`;
  if (snapshot.exportMessage && snapshot.exportMessage !== lastExportMessage) {
    lastExportMessage = snapshot.exportMessage;
    notice(snapshot.exportMessage);
    if (historyDialog().open) historyNotice(snapshot.exportMessage);
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
  if (!snapshot) return;
  const queue = snapshot.queue;
  const key = JSON.stringify([queue, selectedQueueId]);
  if (key === lastQueueKey) return;
  lastQueueKey = key;
  const fragment = document.createDocumentFragment();
  queue.map((item, index) => ({ item, index })).reverse().forEach(({ item, index }) => {
    const row = document.createElement("li");
    row.className = `queue-item${item.id === selectedQueueId ? " selected" : ""}`;
    const button = document.createElement("button");
    button.type = "button"; button.className = "queue-select";
    button.setAttribute("aria-label", `预览第 ${index + 1} 张：${item.name}`);
    button.title = `识别顺序：第 ${index + 1} 张（按导入顺序识别，新导入图片显示在顶部）`;
    const number = document.createElement("span"); number.className = "queue-number"; number.textContent = String(index + 1);
    const description = document.createElement("span"); description.className = "queue-description";
    const name = document.createElement("span"); name.className = "queue-filename"; name.textContent = item.name; name.title = item.name;
    const meta = document.createElement("span"); meta.className = "queue-meta"; meta.textContent = `${item.width} × ${item.height} · ${statuses[item.status] || item.status}`;
    description.append(name, meta); button.append(number, description);
    button.addEventListener("click", () => { selectedQueueId = item.id; renderQueue(); void renderPreview(); if (item.status !== "pending") void selectResult("queue", item.id); });
    const buttons = document.createElement("div"); buttons.className = "queue-actions";
    for (const [symbol, label, direction] of [["↓", "提前识别", -1], ["↑", "延后识别", 1], ["×", "移除", 0]] as const) {
      const control = document.createElement("button"); control.type = "button"; control.className = "icon-button"; control.textContent = symbol; control.title = `${label} ${item.name}`; control.setAttribute("aria-label", control.title);
      control.dataset.boundary = String(direction === -1 && index === 0 || direction === 1 && index === queue.length - 1);
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
  imageElement("preview-image").hidden = true;
  imageElement("preview-image").removeAttribute("src");
  $("preview-empty").hidden = false;
  $("preview-info").textContent = "";
  if (!item || !id) { $("preview-empty").textContent = "选择队列中的图片查看预览"; return; }
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
    imageElement("preview-image").src = cached.dataUrl;
    imageElement("preview-image").alt = item.name;
    imageElement("preview-image").hidden = false;
    $("preview-empty").hidden = true;
    $("preview-area").scrollTop = 0;
    $("preview-area").scrollLeft = 0;
    $("preview-info").textContent = `${item.name} · ${item.width} × ${item.height} · ${(item.bytes / 1024).toFixed(0)} KiB${cached.resized ? `（原图 ${cached.originalWidth} × ${cached.originalHeight}，已按设置缩放）` : ""}`;
  } catch (error) { if (request === previewEpoch) $("preview-empty").textContent = message(error); }
}

async function selectResult(kind: "queue", id: string): Promise<void> {
  selection = { kind, id };
  selectedResult = null;
  const request = ++resultEpoch;
  renderResult();
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
  const history = snapshot?.history || [];
  $("history-count").textContent = String(history.length);
  $("history-empty").hidden = !!history.length;
  if (selectedHistoryId && !history.some((item) => item.id === selectedHistoryId)) {
    selectedHistoryId = null; selectedHistory = null; historyLoading = false; historyEpoch++;
  }
  renderHistoryResult();
  const key = JSON.stringify([history, selectedHistoryId]);
  if (key === lastHistoryKey) return;
  lastHistoryKey = key;
  const fragment = document.createDocumentFragment();
  for (const item of history) {
    const row = document.createElement("li"); row.className = `history-item${selectedHistoryId === item.id ? " selected" : ""}`;
    const open = document.createElement("button"); open.type = "button"; open.className = "history-select";
    const title = document.createElement("strong"); title.textContent = item.name;
    const info = document.createElement("span");
    info.textContent = item.preview || "";
    open.append(title, info); open.title = item.preview || item.name;
    open.addEventListener("click", () => selectHistory(item.id));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "icon-button history-delete"; remove.textContent = "×"; remove.title = `删除历史记录 ${item.name}`; remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => action(async () => {
      try {
        await mutate("ocr.history.delete", { id: item.id });
        historyNotice("历史记录已删除。");
        if (selectedHistoryId === item.id) { selectedHistoryId = null; selectedHistory = null; historyEpoch++; renderHistory(); }
      } catch (error) { historyNotice(message(error), true); }
    }));
    row.append(open, remove); fragment.append(row);
  }
  $("history-list").replaceChildren(fragment);
}

function isOcrResult(result: DisplayResult): result is OcrResult { return "status" in result; }

function renderResult() {
  const result = currentResult();
  const liveResult = result && isOcrResult(result) ? result : null;
  const hasText = !!result?.text;
  buttonElement("copy").disabled = !hasText;
  buttonElement("export").disabled = !hasText || liveResult?.status === "running" || !!snapshot?.exporting;
  buttonElement("export").textContent = snapshot?.exporting ? "正在另存…" : "另存为";
  $("result-name").textContent = result?.name || (selection.kind === "live" ? "等待识别" : "正在读取结果…");
  buttonElement("return-live").hidden = selection.kind === "live";
  $("result-badge").hidden = !liveResult;
  $("result-badge").textContent = liveResult?.status === "running" ? "正在输出" : liveResult?.complete ? "完整" : "可能不完整";
  $("result-badge").className = `badge${liveResult?.complete ? " success" : liveResult?.status === "running" ? "" : " warning"}`;
  $("result-error").hidden = !liveResult?.error && liveResult?.finishReason !== "length";
  $("result-error").textContent = liveResult?.error || (liveResult?.finishReason === "length" ? "本次输出达到最大 token 上限，内容可能不完整。可调整参数后重新导入该图片识别。" : "");
  $("result-empty").hidden = hasText;
  $("markdown-output").hidden = !hasText || view !== "markdown";
  $("source-output").hidden = !hasText || view !== "text";
  const key = JSON.stringify([result?.id, result?.text, view]);
  if (key !== lastResultKey) {
    lastResultKey = key;
    if (result?.text && view === "markdown") {
      $("markdown-output").innerHTML = renderMarkdown(result.text);
    } else if (result?.text) $("source-output").textContent = result.text;
    if (!hasText) { $("markdown-output").replaceChildren(); $("source-output").textContent = ""; }
  }
  renderPerformance(liveResult);
}

function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: false });
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "del", "s", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "a", "span", "sub", "sup"],
    ALLOWED_ATTR: ["colspan", "rowspan", "align", "start"],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
}

async function selectHistory(id: string): Promise<void> {
  selectedHistoryId = id;
  selectedHistory = null;
  historyLoading = true;
  const request = ++historyEpoch;
  historyNotice("");
  renderHistory();
  try {
    const value = await invoke("ocr.result", { id });
    if (request !== historyEpoch || disposed) return;
    selectedHistory = value ? { id: value.id, name: value.name, text: value.text } : null;
    if (!value) historyNotice("这条历史记录已被移除。", true);
  } catch (error) {
    if (request === historyEpoch) historyNotice(message(error), true);
  } finally {
    if (request === historyEpoch) { historyLoading = false; renderHistoryResult(); }
  }
}

function historyNotice(text: string, error = false): void {
  const element = $("history-notice");
  element.textContent = text;
  element.hidden = !text;
  element.className = `notice${error ? " error" : ""}`;
}

function renderHistoryResult(): void {
  const result = selectedHistory;
  const hasText = !!result?.text;
  $("history-result-name").textContent = result?.name || (historyLoading ? "正在读取结果…" : "选择一条历史记录");
  $("history-result-empty").hidden = hasText;
  $("history-result-empty").textContent = historyLoading ? "正在读取识别文字…" : "选择左侧或上方的记录查看识别文字。历史记录只保存原文件名和文字，不保存图片。";
  $("history-markdown-output").hidden = !hasText || historyView !== "markdown";
  $("history-source-output").hidden = !hasText || historyView !== "text";
  buttonElement("history-copy").disabled = !hasText;
  buttonElement("history-export").disabled = !hasText || !!snapshot?.exporting;
  buttonElement("history-export").textContent = snapshot?.exporting ? "正在另存…" : "另存为";
  buttonElement("history-view-markdown").setAttribute("aria-pressed", String(historyView === "markdown"));
  buttonElement("history-view-source").setAttribute("aria-pressed", String(historyView === "text"));
  const key = JSON.stringify([result?.id, result?.text, historyView]);
  if (key === lastHistoryResultKey) return;
  lastHistoryResultKey = key;
  if (result?.text && historyView === "markdown") $("history-markdown-output").innerHTML = renderMarkdown(result.text);
  else if (result?.text) $("history-source-output").textContent = result.text;
  if (!hasText) { $("history-markdown-output").replaceChildren(); $("history-source-output").textContent = ""; }
}

function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function time(value: unknown, divisor = 1000): string { const n = number(value); return n === null ? "耗时不可用" : `${(n / divisor).toFixed(2)} ms`; }
function renderPerformance(result: OcrResult | null): void {
  $("performance").hidden = !result || !result.text;
  if (!result) return;
  const record = result.performance;
  const timings = record?.status === "completed" ? record.performance?.timings : null;
  const usage = record?.usage || result.usage;
  const rate = (phase: "prefill" | "decode", tokens: unknown): string => {
    const micros = number(timings?.[`${phase}_us`]);
    const count = number(tokens);
    return micros === null || micros === 0 || count === null ? "不可用" : `${(count / micros * 1e6).toFixed(2)} token/s`;
  };
  $("prefill-rate").textContent = rate("prefill", usage?.prompt_tokens);
  $("decode-rate").textContent = rate("decode", usage?.completion_tokens);
  $("prefill-time").textContent = time(timings?.prefill_us);
  $("decode-time").textContent = time(timings?.decode_us);
  $("token-counts").textContent = number(usage?.prompt_tokens) !== null && number(usage?.completion_tokens) !== null ? `${usage?.prompt_tokens} / ${usage?.completion_tokens}` : "不可用";
  $("execution-time").textContent = record ? `执行 ${time(record.timings?.execution_ms, 1)}` : "执行耗时不可用";
  const elapsedMs = number(result.elapsedMs);
  $("elapsed-time").textContent = elapsedMs === null ? "本次总耗时不可用" : `本次总耗时 ${(elapsedMs / 1000).toFixed(2)} 秒（含请求准备与加载）`;
  $("performance-status").textContent = result.status === "running" ? "完成后显示" : !record ? "后端未提供分阶段指标" : "";
  $("performance-note").textContent = timings
    ? "Prefill 含图片编码；Decode 已扣同步输出回调。执行耗时不含排队与加载，缺失指标不会估算为 0。"
    : "此结果没有 Prefill / Decode 分阶段数据，无法计算对应速度。总耗时包含请求准备；token 用量仅显示后端返回的数值。";
}

async function uploadImage(image: PreparedImage): Promise<string> {
  const mimeType = image.dataUrl.slice(5, image.dataUrl.indexOf(";"));
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new Error("图片编码类型无效。");
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

async function importFiles(files: File[]): Promise<void> {
  if (importing || snapshot?.busy || !files.length) return;
  importing = true;
  renderControls();
  let imported = 0;
  const failures: string[] = [];
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
    inputElement("file-input").value = "";
    $("import-progress").textContent = "新图片在顶部，编号为识别顺序；最多 20 张，单张 PNG/JPEG ≤ 4 MiB。";
    renderControls();
  }
}

function historyDialog(): HTMLDialogElement {
  const element = $("history-panel");
  if (!(element instanceof HTMLDialogElement)) throw new Error("历史记录窗口类型错误。");
  return element;
}
function setHistoryOpen(open: boolean): void {
  const dialog = historyDialog();
  if (open) {
    if (!dialog.open) dialog.showModal();
    buttonElement("history-toggle").setAttribute("aria-expanded", "true");
    renderHistory();
  } else if (dialog.open) dialog.close();
}

for (const key of controlKeys) {
    const input = controls[key];
  input.addEventListener(input.tagName === "SELECT" || booleanFields.has(key) ? "change" : "input", () => {
    dirty.add(key);
    if (key === "backend" || key === "baseUrl") {
      // Never carry a key to a changed destination. A key explicitly typed after
      // this change may be saved in the same settings request for that endpoint.
      inputElement("token").value = "";
      tokenDirty = false;
      connectedOnce = false;
      if (key === "backend") {
        controls.baseUrl.value = backend() === "nexa" ? "http://127.0.0.1:18080" : "http://127.0.0.1:8080/v1";
        controls.modelId.value = "";
        controls.autoLoad.checked = false;
        for (const dependent of ["baseUrl", "modelId", "autoLoad"] as const) dirty.add(dependent);
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
inputElement("token").addEventListener("input", () => { tokenDirty = true; scheduleSave(); });
$("connection-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(async () => { await flushSettings(); await mutate("ocr.connect"); notice("正在连接本机服务…"); void poll(); });
});
buttonElement("clear-token").addEventListener("click", () => action(async () => { await mutate("ocr.clearToken"); inputElement("token").value = ""; tokenDirty = false; notice("已清除插件保存的 API 密钥。"); }));
buttonElement("token-file-open").addEventListener("click", () => inputElement("token-file").click());
inputElement("token-file").addEventListener("change", async () => {
  const file = inputElement("token-file").files?.[0];
  if (!file) return;
  try {
    if (file.size > 16384 || file.size < 1) throw new Error("请选择只包含 API 密钥的文本文件（最多 16 KiB）。");
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).trim()); reader.onerror = () => reject(new Error("密钥文件读取失败。")); reader.onabort = () => reject(new Error("密钥文件读取已中止。")); reader.readAsText(file);
    });
    validateToken(text);
    inputElement("token").value = text; tokenDirty = true; await flushSettings(); notice("API 密钥已导入，可以连接本机服务。");
  } catch (error) { notice(message(error), true); }
  finally { inputElement("token-file").value = ""; }
});
buttonElement("import").addEventListener("click", () => inputElement("file-input").click());
inputElement("file-input").addEventListener("change", () => importFiles(Array.from(inputElement("file-input").files || [])));
buttonElement("clear-queue").addEventListener("click", () => action(async () => { await mutate("ocr.queue", { action: "clear" }); notice("图片队列已清空，已保存的识别历史仍可查看。"); }));
buttonElement("start").addEventListener("click", () => action(async () => {
  await flushSettings(); selection = { kind: "live", id: null }; selectedResult = null; resultEpoch++;
  await mutate("ocr.start"); notice(""); await poll();
}));
// Stop is intentionally independent of the action lock so it can interrupt work.
buttonElement("stop").addEventListener("click", async () => {
  buttonElement("stop").disabled = true;
  try {
    await mutate("ocr.stop");
    notice(backend() === "nexa" ? "正在停止。已有文字将保留，未开始的图片可稍后继续。" : "正在停止本次请求并断开连接。已有文字将保留；通用接口无法确认服务端已取消推理，请检查服务状态后继续。");
    await poll();
  }
  catch (error) { notice(message(error), true); }
});
selectElement("preview-mode").addEventListener("change", () => { previewMode = selectElement("preview-mode").value; $("preview-area").className = `preview-area ${previewMode}`; });
for (const [id, next] of [["view-markdown", "markdown"], ["view-source", "text"]] as const) $(id).addEventListener("click", () => {
  view = next; renderResult(); renderControls();
  dirty.add("view");
  if (!snapshot?.busy) scheduleSave();
  else deferredViewSave = true;
});
buttonElement("history-toggle").addEventListener("click", () => setHistoryOpen(true));
buttonElement("history-close").addEventListener("click", () => setHistoryOpen(false));
historyDialog().addEventListener("close", () => {
  buttonElement("history-toggle").setAttribute("aria-expanded", "false");
  buttonElement("history-toggle").focus();
});
for (const [id, next] of [["history-view-markdown", "markdown"], ["history-view-source", "text"]] as const) buttonElement(id).addEventListener("click", () => {
  historyView = next; renderHistoryResult();
});
buttonElement("history-copy").addEventListener("click", async () => {
  if (!selectedHistory?.text) return;
  try { await copyText(selectedHistory.text); historyNotice("识别原文已复制。"); }
  catch (error) { historyNotice(message(error), true); }
});
buttonElement("history-export").addEventListener("click", () => action(async () => {
  if (!selectedHistory?.text) return;
  try {
    await invoke("ocr.export", { id: selectedHistory.id });
    historyNotice("请选择 Markdown 保存目录…");
  } catch (error) { historyNotice(message(error), true); }
}));
buttonElement("return-live").addEventListener("click", () => { selection = { kind: "live", id: null }; selectedResult = null; resultEpoch++; renderHistory(); renderResult(); });
buttonElement("copy").addEventListener("click", async () => {
  const result = currentResult(); if (!result?.text) return;
  try { await copyText(result.text); notice("识别原文已复制，未附加性能摘要。"); }
  catch (error) { notice(message(error), true); }
});
buttonElement("export").addEventListener("click", () => action(async () => {
  const result = currentResult(); if (!result?.text) return;
  const exported = await invoke("ocr.export", { id: result.id });
  if (exported.started) notice("请选择 Markdown 保存目录…");
}));

// Adapted from VastSa Side Chat's MIT appearance helper: follow the host's
// resolved palette, preserve it on system-only updates, and apply theme tokens.
let appearanceFingerprint = "";
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isTheme(value: unknown): value is "light" | "dark" { return value === "light" || value === "dark"; }
function applyAppearance(value: unknown): void {
  if (!isRecord(value)) return;
  const fingerprint = JSON.stringify(value);
  if (fingerprint === appearanceFingerprint) return;
  appearanceFingerprint = fingerprint;
  const pluginTheme = isRecord(value.pluginTheme) ? value.pluginTheme : null;
  const base = isTheme(value.base) ? value.base : isTheme(value.theme) ? value.theme : pluginTheme?.base;
  if (isTheme(base)) document.documentElement.dataset.theme = base;
  document.documentElement.dataset.hostLocale = typeof value.locale === "string" && value.locale ? value.locale : "zh-CN";
  let style = document.getElementById("host-theme");
  if (!style) { style = document.createElement("style"); style.id = "host-theme"; document.head.append(style); }
  // The host validates and sanitizes plugin theme CSS before this delivery.
  style.textContent = typeof pluginTheme?.css === "string" ? pluginTheme.css : "";
}

if (bridge?.on) bridge.on("appearance:changed", applyAppearance);
void getAppearance().then(applyAppearance).catch(() => {
  if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
});
const appearanceTimer = setInterval(() => {
  if (!document.hidden) void getAppearance().then(applyAppearance).catch(() => {});
}, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void poll(); });
window.addEventListener("pagehide", () => {
  if (!snapshot?.busy && (dirty.size || tokenDirty)) void flushSettings().catch(() => {});
  disposed = true; previewEpoch++; resultEpoch++; historyEpoch++;
  clearTimeout(pollTimer); clearTimeout(saveTimer); clearInterval(appearanceTimer);
  imageCache.clear();
  // Do not stop the shared controller when one of its two possible views closes.
});
renderControls();
void poll();
