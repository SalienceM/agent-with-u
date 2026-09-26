const test = require('node:test');
const assert = require('node:assert/strict');
const { fitImageScale, imageScaleLimits, constrainImageView, zoomImageAt, wheelImageScale } = require('../../.home-test-dist/utils/imageViewport.js');

test('portrait, landscape, huge and small images fit completely without upscaling', () => {
  for (const viewport of [{ width: 320, height: 440 }, { width: 1400, height: 750 }]) {
    for (const image of [{ width: 2400, height: 8000 }, { width: 8000, height: 2000 }, { width: 100000, height: 2 }, { width: 12, height: 18 }]) {
      const scale = fitImageScale(image, viewport);
      assert.ok(scale > 0 && scale <= 1);
      assert.ok(image.width * scale <= viewport.width - 24 + 1e-8);
      assert.ok(image.height * scale <= viewport.height - 24 + 1e-8);
      assert.ok(imageScaleLimits(image, viewport).min < scale);
    }
  }
});

test('continuous wheel zoom handles pixels, lines and pages without quantized steps', () => {
  assert.ok(wheelImageScale(1, -0.5, 0, 800) > 1);
  assert.ok(wheelImageScale(1, -1, 0, 800) > wheelImageScale(1, -0.5, 0, 800));
  assert.equal(wheelImageScale(1, 1, 1, 800), wheelImageScale(1, 16, 0, 800));
  assert.equal(wheelImageScale(1, 1, 2, 800), wheelImageScale(1, 800, 0, 800));
});

test('zoom fixes the image coordinate at the pointer and pinch moves its midpoint', () => {
  const image = { width: 3000, height: 4000 }, viewport = { width: 500, height: 600 };
  const start = { scale: 1, x: 30, y: -70 }, anchor = { x: 100, y: 140 };
  const result = zoomImageAt(start, image, viewport, 2, anchor);
  assert.equal((anchor.x - result.x) / result.scale, (anchor.x - start.x) / start.scale);
  assert.equal((anchor.y - result.y) / result.scale, (anchor.y - start.y) / start.scale);
  const pinch = zoomImageAt(start, image, viewport, 2, anchor, { x: 130, y: 180 });
  assert.equal(pinch.x, result.x + 30);
  assert.equal(pinch.y, result.y + 40);
});

test('pan reveals every edge but cannot lose the image; fitting resets small axes', () => {
  const image = { width: 1000, height: 2000 }, viewport = { width: 500, height: 600 };
  assert.deepEqual(constrainImageView({ scale: 1, x: 1e9, y: -1e9 }, image, viewport), { scale: 1, x: 250, y: -700 });
  const view = constrainImageView({ scale: fitImageScale(image, viewport), x: 250, y: -700 }, image, viewport);
  assert.equal(Math.abs(view.x), 0);
  assert.equal(Math.abs(view.y), 0);
  assert.equal(constrainImageView({ scale: 1e9, x: 0, y: 0 }, image, viewport).scale, 16);
});
