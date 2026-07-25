const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'pcm-worklet.js'),
  'utf8',
);

function runWorklet(inputRate, seconds) {
  let Processor;
  const context = {
    sampleRate: inputRate,
    Float32Array,
    Int16Array,
    ArrayBuffer,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          frames: [],
          onmessage: null,
          postMessage: (data) => this.port.frames.push(data),
        };
      }
    },
    registerProcessor: (_name, cls) => {
      Processor = cls;
    },
  };
  vm.runInNewContext(source, context);

  const processor = new Processor();
  let remaining = Math.round(inputRate * seconds);
  while (remaining > 0) {
    const count = Math.min(128, remaining);
    processor.process([[new Float32Array(count).fill(0.25)]]);
    remaining -= count;
  }
  processor.port.onmessage({ data: { type: 'flush' } });

  const frames = processor.port.frames.filter((frame) => frame instanceof ArrayBuffer);
  const outputSamples = frames.reduce(
    (total, frame) => total + frame.byteLength / 2,
    0,
  );
  return { frames, outputSamples };
}

test('PCM worklet resamples common device rates to an exact 16kHz timeline', () => {
  for (const inputRate of [16000, 44100, 48000]) {
    const { frames, outputSamples } = runWorklet(inputRate, 1);
    assert.equal(outputSamples, 16000);
    assert.ok(frames.every((frame) => frame.byteLength === 3200));
  }
});

test('PCM worklet sends 100ms frames and flushes the final partial frame', () => {
  const { frames, outputSamples } = runWorklet(48000, 3.25);

  assert.equal(outputSamples, 52000);
  assert.equal(frames.length, 33);
  assert.ok(frames.slice(0, -1).every((frame) => frame.byteLength === 3200));
  assert.equal(frames.at(-1).byteLength, 1600);
});
