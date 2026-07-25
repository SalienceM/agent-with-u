class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    this.totalInputSamples = 0;
    this.nextOutputAt = 0;
    this.lastInputSample = null;
    this.output = [];
    this.closed = false;
    this.frameSamples = 1600; // 100ms @ 16kHz，避免每 128 samples 发送一个碎包
    this.port.onmessage = (event) => {
      if (event.data?.type === 'flush') {
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  emit(force = false) {
    while (this.output.length >= this.frameSamples || (force && this.output.length > 0)) {
      const size = force
        ? Math.min(this.output.length, this.frameSamples)
        : this.frameSamples;
      const pcm = new Int16Array(size);
      for (let i = 0; i < size; i++) pcm[i] = this.output[i];
      this.output.splice(0, size);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
  }

  consume(float32) {
    if (!float32.length) return;
    const hasPrevious = this.lastInputSample !== null;
    const merged = new Float32Array(float32.length + (hasPrevious ? 1 : 0));
    if (hasPrevious) {
      merged[0] = this.lastInputSample;
      merged.set(float32, 1);
    } else {
      merged.set(float32);
    }
    const absoluteStart = this.totalInputSamples - (hasPrevious ? 1 : 0);
    const absoluteEnd = absoluteStart + merged.length - 1;

    // 用绝对输入采样位置记录相位，不能按每个 128-sample Worklet block
    // 重新取整，否则 48k → 16k 每秒会额外产生约 125 个采样点。
    while (this.nextOutputAt < absoluteEnd) {
      const relative = this.nextOutputAt - absoluteStart;
      const left = Math.floor(relative);
      const frac = relative - left;
      const sample = merged[left] + (merged[left + 1] - merged[left]) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.output.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF);
      this.nextOutputAt += this.ratio;
    }

    this.totalInputSamples += float32.length;
    this.lastInputSample = float32[float32.length - 1];
    this.emit(false);
  }

  flush() {
    if (this.closed) return;
    if (
      this.lastInputSample !== null
      && this.nextOutputAt <= this.totalInputSamples - 1
    ) {
      const clamped = Math.max(-1, Math.min(1, this.lastInputSample));
      this.output.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF);
      this.nextOutputAt += this.ratio;
    }
    this.emit(true);
    this.closed = true;
  }

  process(inputs) {
    if (this.closed) return true;
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    this.consume(input[0]);
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
