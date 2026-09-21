import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { personConfidence, prepareImage } from '../src/person-detector.js';

test('only person class contributes to confidence, not other highly confident objects', () => {
  const result = { dims: [1, 3, 6], data: new Float32Array([
    10, 20, 30, 40, 0.99, 15,
    10, 20, 30, 40, 0.31, 0,
    10, 20, 30, 40, 0.04, 0,
  ]) };
  assert.ok(Math.abs(personConfidence(result) - 0.31) < 1e-6);
  result.data[11] = 15;
  result.data[17] = 15;
  assert.equal(personConfidence(result), 0);
});

test('unexpected output shape and nonfinite scores cause errors rather than false', () => {
  assert.throws(() => personConfidence({ dims: [1, 84, 8400], data: [] }), /不支持/);
  assert.throws(() => personConfidence({ dims: [1, 1, 6], data: [0, 0, 0, 0, NaN, 0] }), /无效/);
});

test('preprocessing preserves aspect ratio with gray padding and RGB planar normalization', async () => {
  const picture = await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  const tensor = await prepareImage(picture, 8);
  try {
    assert.deepEqual(tensor.dims, [1, 3, 8, 8]);
    const { data } = tensor;
    const center = 4 * 8 + 4;
    assert.equal(data[center], 1);
    assert.equal(data[64 + center], 0);
    assert.equal(data[128 + center], 0);
    for (const channel of [0, 1, 2]) assert.ok(Math.abs(data[channel * 64] - 114 / 255) < 1e-6);
  } finally { tensor.dispose(); }
});

test('unreadable images reject, never masquerade as a negative detection', async () => {
  await assert.rejects(prepareImage(Buffer.from('not an image'), 640));
});
