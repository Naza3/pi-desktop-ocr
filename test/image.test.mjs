import test from 'node:test';
import assert from 'node:assert/strict';
import { imageType, headerDimensions, outputDimensions, dataUrlBytes } from '../renderer/image.js';

function png(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); view.setUint32(12, 0x49484452);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}

test('image identity uses bytes, including files with missing or incorrect MIME', () => {
  assert.equal(imageType(png(1, 1)), 'image/png');
  assert.equal(imageType(new Uint8Array([255, 216, 255, 224])), 'image/jpeg');
  assert.throws(() => imageType(new Uint8Array([71, 73, 70, 56, 57, 97])));
  assert.throws(() => imageType(new Uint8Array()));
});

test('PNG dimensions are read before browser decoding; truncated or fake IHDR fails', () => {
  assert.deepEqual(headerDimensions(png(3056, 5812)), { width: 3056, height: 5812 });
  assert.throws(() => headerDimensions(png(1, 1).slice(0, 23)));
  const fake = png(1, 1); fake[12] = 0;
  assert.throws(() => headerDimensions(fake));
});

test('JPEG dimensions skip metadata and support progressive SOF', () => {
  const data = new Uint8Array([255, 216, 255, 225, 0, 4, 12, 34, 255, 194, 0, 8, 8, 2, 0, 4, 0, 1]);
  assert.deepEqual(headerDimensions(data), { width: 1024, height: 512 });
  assert.throws(() => headerDimensions(data.slice(0, -1)));
  assert.throws(() => headerDimensions(new Uint8Array([255, 216, 255, 225, 255, 255])));
});

test('originals are not silently resized and the user long table needs explicit scaling', () => {
  assert.deepEqual(outputDimensions(1077, 2048), { width: 1077, height: 2048 });
  assert.throws(() => outputDimensions(3056, 5812), /超过 16 Mi/);
  assert.deepEqual(outputDimensions(3056, 5812, 4096), { width: 2154, height: 4096 });
  assert.deepEqual(outputDimensions(500, 800, 2048), { width: 500, height: 800 });
  assert.throws(() => outputDimensions(16384, 100, 4096), /单边最多/);
});

test('dimension limits include exactly 16 Mi pixels and reject invalid scale values', () => {
  assert.deepEqual(outputDimensions(8192, 2048), { width: 8192, height: 2048 });
  assert.throws(() => outputDimensions(8192, 2049));
  for (const value of [-1, 1, 255, 8193, 2.5, NaN]) assert.throws(() => outputDimensions(1000, 1000, value));
  for (const [width, height] of [[0, 1], [1, 0], [1.2, 100], [Infinity, 1]]) assert.throws(() => outputDimensions(width, height));
});

test('small explicit scaling preserves aspect ratio and never enlarges smaller originals', () => {
  assert.deepEqual(outputDimensions(1024, 512, 256), { width: 256, height: 128 });
  assert.deepEqual(outputDimensions(3056, 5812, 256), { width: 135, height: 256 });
  assert.deepEqual(outputDimensions(3056, 5812, 512), { width: 269, height: 512 });
  assert.deepEqual(outputDimensions(3056, 5812, 1024), { width: 538, height: 1024 });
  assert.deepEqual(outputDimensions(128, 64, 256), { width: 128, height: 64 });
});

test('base64 byte counting handles padding and rejects URL or non-image data', () => {
  assert.equal(dataUrlBytes('data:image/png;base64,AA=='), 1);
  assert.equal(dataUrlBytes('data:image/jpeg;base64,AAA='), 2);
  assert.equal(dataUrlBytes('data:image/png;base64,AAAA'), 3);
  for (const invalid of ['https://example.test/image.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,', 'data:image/png;base64,AAA', 'data:image/png;base64,AA\n==']) assert.throws(() => dataUrlBytes(invalid));
});
