export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 8192;
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
export const MAX_QUEUE = 20;

export interface ImageDimensions { width: number; height: number }
export interface PreparedImage extends ImageDimensions {
  id: string;
  name: string;
  dataUrl: string;
  bytes: number;
  originalWidth: number;
  originalHeight: number;
  resized: boolean;
}
export type ImageMime = "image/png" | "image/jpeg";

export function imageType(bytes: Uint8Array): ImageMime {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  throw new Error("文件内容不是 PNG 或 JPEG 图片。");
}

export function outputDimensions(width: number, height: number, edge = 0): ImageDimensions {
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0) || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    throw new Error(`原图尺寸 ${width} × ${height} 无效；单边最多 8192 像素。`);
  }
  if (!Number.isSafeInteger(edge) || edge < 0 || edge > MAX_IMAGE_EDGE || edge > 0 && edge < 256) {
    throw new Error("缩放最长边应为 256–8192，或 0（原图）。");
  }
  const scale = edge > 0 ? Math.min(1, edge / Math.max(width, height)) : 1;
  const result = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  if (result.width * result.height > MAX_IMAGE_PIXELS) {
    throw new Error(`图片 ${width} × ${height} 共 ${(width * height / 1048576).toFixed(2)} Mi 像素，超过 16 Mi 上限。请先选择缩放最长边，再重新导入。`);
  }
  return result;
}

export function dataUrlBytes(url: string): number {
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match?.[1] || match[1].length % 4 !== 0) throw new Error("图片编码无效，请重新导入。");
  const body = match[1];
  return body.length / 4 * 3 - (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0);
}

function readFile(blob: Blob, mode: "buffer"): Promise<ArrayBuffer>;
function readFile(blob: Blob, mode: "url"): Promise<string>;
function readFile(blob: Blob, mode: "buffer" | "url"): Promise<ArrayBuffer | string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (mode === "buffer" && result instanceof ArrayBuffer || mode === "url" && typeof result === "string") resolve(result);
      else reject(new Error("无法读取图片。"));
    };
    reader.onerror = () => reject(new Error("无法读取图片，请重新选择文件。"));
    reader.onabort = () => reject(new Error("图片读取已中止。"));
    if (mode === "buffer") reader.readAsArrayBuffer(blob);
    else reader.readAsDataURL(blob);
  });
}

/** Inspect the declared dimensions before passing untrusted bytes to a decoder. */
export function headerDimensions(bytes: Uint8Array, type: ImageMime = imageType(bytes)): ImageDimensions {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/png") {
    if (bytes.length < 24 || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error("PNG 图片头不完整。");
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  let index = 2;
  while (index + 3 < bytes.length) {
    if (bytes[index++] !== 0xff) throw new Error("JPEG 图片头无效。");
    while (bytes[index] === 0xff) index++;
    const marker = bytes[index++];
    if (marker === undefined) break;
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
    if (index + 2 > bytes.length) break;
    const length = view.getUint16(index);
    if (length < 2 || index + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) break;
      return { width: view.getUint16(index + 5), height: view.getUint16(index + 3) };
    }
    index += length;
  }
  throw new Error("JPEG 图片尺寸不可读，请重新导出图片。");
}

/** The explicit file input is the only source; no native path crosses the bridge. */
export async function prepareImage(file: File, edge = 0): Promise<PreparedImage> {
  if (!file.size) throw new Error("图片文件为空。");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("原图文件不能超过 4 MiB，请先用图片编辑器另存为 PNG 或 JPEG。");
  const buffer = await readFile(file, "buffer");
  if (!buffer.byteLength || buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("图片文件大小无效或超过 4 MiB。");
  const bytes = new Uint8Array(buffer);
  const mime = imageType(bytes);
  const declared = headerDimensions(bytes, mime);
  outputDimensions(declared.width, declared.height, edge);
  // Browser MIME associations may be missing on Windows: label the detected bytes.
  const original = await readFile(new Blob([buffer], { type: mime }), "url");
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const value = new Image();
    value.onload = () => resolve(value);
    value.onerror = () => reject(new Error("图片损坏或浏览器无法解码。"));
    value.src = original;
  });
  const dimensions = outputDimensions(image.naturalWidth, image.naturalHeight, edge);
  let dataUrl = original;
  const resized = dimensions.width !== image.naturalWidth || dimensions.height !== image.naturalHeight;
  if (resized) {
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建图片缩放画布。");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    dataUrl = canvas.toDataURL("image/png");
    canvas.width = canvas.height = 0;
  }
  const size = dataUrlBytes(dataUrl);
  if (size > MAX_IMAGE_BYTES) throw new Error("缩放后的 PNG 超过 4 MiB。请选择更小的最长边，或在图片编辑器中调整后重新导入。");
  // An EXIF-oriented JPEG may have swapped browser dimensions. Unmodified bytes
  // must report their actual encoded header, which the main process verifies.
  const transmitted = resized ? dimensions : declared;
  return {
    id: crypto.randomUUID(), name: file.name, dataUrl,
    width: transmitted.width, height: transmitted.height, bytes: size,
    originalWidth: image.naturalWidth, originalHeight: image.naturalHeight, resized,
  };
}
