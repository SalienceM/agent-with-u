const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IncrementalSpeechChunker,
  ToolAwareSpeechGate,
  VoiceSummaryProjector,
  cleanSpeechText,
  computeTurnEndSilenceMs,
  echoProtectedBargeIn,
  isLikelyPlaybackEcho,
  isSpeakableAgentDelta,
  matchWakeDirectedInterruption,
  matchWakePhrase,
  normalizeContinuousVoiceWindowMs,
  pcm16Rms,
  pickWakeAcknowledgement,
  resolveLatchedWakeText,
  resolveRealtimeVoiceInteractionMode,
  resolveWakeUtteranceCommand,
  shouldRelockContinuousVoice,
  systemSpeechRate,
  updatePlaybackEchoFloor,
} = require('../../.home-test-dist/utils/realtimeVoice.js');

test('speech chunker emits a small first phrase and keeps later text ordered', () => {
  const chunker = new IncrementalSpeechChunker({
    firstMinChars: 4,
    firstMaxChars: 8,
    nextMinChars: 6,
    nextMaxChars: 12,
  });

  assert.deepEqual(chunker.pushDelta('你好，我来'), []);
  assert.deepEqual(chunker.pushDelta('回答。后面的内容还在生成'), ['你好，我来回答。']);
  assert.deepEqual(chunker.pushDelta('，请稍等一下。'), ['后面的内容还在生成，', '请稍等一下。']);
  assert.deepEqual(chunker.finish(), []);
});

test('fenced code is omitted even when fence markers cross delta boundaries', () => {
  const chunker = new IncrementalSpeechChunker({
    firstMinChars: 4,
    firstMaxChars: 10,
    nextMinChars: 4,
    nextMaxChars: 10,
  });

  const spoken = [];
  spoken.push(...chunker.pushDelta('说明如下。``'));
  spoken.push(...chunker.pushDelta('`python\nprint("不要朗读")\n``'));
  spoken.push(...chunker.pushDelta('`\n已经完成。'));
  spoken.push(...chunker.finish());

  assert.deepEqual(spoken, ['说明如下。', '已经完成。']);
  assert.equal(spoken.join('').includes('print'), false);
});

test('speech cleanup removes URLs and visual markdown', () => {
  const cleaned = cleanSpeechText('## 结果\n请看 [文档](https://example.com/a) **重点**。');
  assert.equal(cleaned, '结果。请看 文档 重点。');
  assert.equal(cleaned.includes('https://'), false);
});

test('PCM16 RMS distinguishes silence from speech-like samples', () => {
  const silence = new Int16Array(160);
  const signal = new Int16Array(160);
  signal.fill(8192);
  assert.equal(pcm16Rms(silence.buffer), 0);
  assert.ok(Math.abs(pcm16Rms(signal.buffer) - 0.25) < 0.0001);
});

test('wake phrase accepts common 小U aliases and preserves the command', () => {
  assert.deepEqual(matchWakePhrase('小优，帮我总结今天的内容', '小U'), {
    matched: true,
    matchedText: '小优',
    remainder: '帮我总结今天的内容',
  });
  assert.equal(matchWakePhrase('嗯，你好，小 悠！查一下天气', '小U').matched, true);
  assert.equal(matchWakePhrase('我们刚才讨论了小U的设计', '小U').matched, false);
  assert.equal(matchWakePhrase('这是没有唤醒词的环境对话', '小U').matched, false);
});

test('Yuki wake phrase accepts bounded phonetic aliases and preserves the command', () => {
  assert.deepEqual(matchWakePhrase('Yuki，帮我继续处理', 'Yuki'), {
    matched: true,
    matchedText: 'Yuki',
    remainder: '帮我继续处理',
  });
  assert.equal(matchWakePhrase('Hey, you key，停一下', 'Yuki').matched, true);
  assert.equal(matchWakePhrase('由纪，继续', 'Yuki').matched, true);
  assert.equal(matchWakePhrase('尤基，继续', 'Yuki').matched, true);
  assert.equal(matchWakePhrase('U key，继续', 'Yuki').matched, true);
  assert.deepEqual(matchWakePhrase('有机。', 'Yuki'), {
    matched: true,
    matchedText: '有机',
    finalOnly: true,
    remainder: '',
  });
  assert.equal(matchWakePhrase('有机食品很好', 'Yuki').matched, false);
  assert.equal(matchWakePhrase('尤其需要注意', 'Yuki').matched, false);
  assert.equal(matchWakePhrase('这句话中间提到 Yuki', 'Yuki').matched, false);
});

test('a latched partial wake survives an empty or rewritten final transcript', () => {
  assert.equal(resolveLatchedWakeText('', 'Yuki', ''), '');
  assert.equal(resolveLatchedWakeText('未知短词', 'Yuki', ''), '');
  assert.equal(resolveLatchedWakeText('未知开头 帮我继续处理', 'Yuki', ''), '未知开头 帮我继续处理');
  assert.equal(resolveLatchedWakeText('Yuki，帮我继续处理', 'Yuki', ''), '帮我继续处理');
  assert.equal(resolveLatchedWakeText('最终识别改写', 'Yuki', '帮我继续处理'), '帮我继续处理');
});

test('every Yuki sound segment stays local and only the next segment becomes a command', () => {
  assert.equal(resolveWakeUtteranceCommand('Yuki', 'Yuki'), '');
  assert.equal(resolveWakeUtteranceCommand('Yuki，你在吗', 'Yuki'), '');
  assert.equal(resolveWakeUtteranceCommand('Yuki，帮我查天气', 'Yuki'), '');
  assert.equal(resolveWakeUtteranceCommand('Yuki，你怎么看这个问题', 'Yuki'), '');
  assert.equal(resolveWakeUtteranceCommand('最终识别改写成一段问题', 'Yuki', true), '');
  assert.equal(resolveWakeUtteranceCommand('帮我查天气', 'Yuki', false), '帮我查天气');
  assert.equal(resolveWakeUtteranceCommand('直接开始', '', false), '直接开始');
});

test('wake acknowledgement varies without immediately repeating', () => {
  const first = pickWakeAcknowledgement('', () => 0);
  const second = pickWakeAcknowledgement(first, () => 0);
  assert.equal(first, '我在');
  assert.notEqual(second, first);
});

test('empty wake phrase disables wake gating', () => {
  assert.deepEqual(matchWakePhrase('直接开始对话', ''), {
    matched: true,
    remainder: '直接开始对话',
  });
});

test('continuous conversation relocks only after idle timeout', () => {
  assert.equal(normalizeContinuousVoiceWindowMs(Number.NaN), 30_000);
  assert.equal(normalizeContinuousVoiceWindowMs(2_000), 10_000);
  assert.equal(normalizeContinuousVoiceWindowMs(500_000), 120_000);
  assert.equal(shouldRelockContinuousVoice('Yuki', 29_999, 30_000), false);
  assert.equal(shouldRelockContinuousVoice('Yuki', 30_000, 30_000), true);
  assert.equal(shouldRelockContinuousVoice('Yuki', 60_000, 30_000, true), false);
  assert.equal(shouldRelockContinuousVoice('', 60_000, 30_000), false);
});

test('wake-directed interruption rejects ambient speech and preserves command remainder', () => {
  assert.deepEqual(matchWakeDirectedInterruption('旁边的人正在聊天', '小U'), {
    matched: false,
    remainder: '',
  });
  assert.deepEqual(matchWakeDirectedInterruption('小优，停一下，重新查', '小U'), {
    matched: true,
    matchedText: '小优',
    remainder: '',
  });
  assert.equal(matchWakeDirectedInterruption('小U，停止', '').matched, false);
  assert.equal(
    matchWakeDirectedInterruption('小U', '小U', '你可以说小U来继续。').matched,
    false,
  );
  assert.deepEqual(matchWakeDirectedInterruption('Yuki，你在吗', 'Yuki'), {
    matched: true,
    matchedText: 'Yuki',
    remainder: '',
  });
  assert.deepEqual(matchWakeDirectedInterruption('Yuki，你在吗？重新查天气', 'Yuki'), {
    matched: true,
    matchedText: 'Yuki',
    remainder: '',
  });
});

test('foreground voice projector handles split and repeated hidden summary markers', () => {
  const projector = new VoiceSummaryProjector();
  const spoken = [];
  spoken.push(...projector.pushText('<!--AWU-'));
  spoken.push(...projector.pushText('VOICE-->先说阶段'));
  spoken.push(...projector.pushText('结论。<!--/AWU-'));
  spoken.push(...projector.pushText('VOICE-->这里是界面完整细节。'));
  spoken.push(...projector.pushText('<!--AWU-VOICE-->最终归纳。<!--/AWU-VOICE-->'));
  spoken.push(...projector.finish());
  assert.equal(spoken.join(''), '先说阶段结论。最终归纳。');
  assert.equal(spoken.join('').includes('完整细节'), false);
});

test('foreground voice projector streams ordinary prose when markers are missing', () => {
  const projector = new VoiceSummaryProjector();
  assert.deepEqual(projector.pushText('模型没有遵循隐藏标记，'), ['模型没有遵循隐藏标记，']);
  assert.deepEqual(projector.pushText('但回答仍然必须可朗读。'), ['但回答仍然必须可朗读。']);
  assert.deepEqual(projector.finish(), []);
});

test('voice interaction mode changes only for a hidden or minimized surface', () => {
  assert.equal(resolveRealtimeVoiceInteractionMode({}), 'realtime-voice-foreground');
  assert.equal(
    resolveRealtimeVoiceInteractionMode({ minimized: true, visible: true }),
    'realtime-voice-background',
  );
  assert.equal(
    resolveRealtimeVoiceInteractionMode({ documentHidden: true }),
    'realtime-voice-background',
  );
});

test('adaptive endpoint gives unfinished speech more thinking time', () => {
  assert.equal(computeTurnEndSilenceMs(1500, '这是完整的一句话。'), 1500);
  assert.equal(computeTurnEndSilenceMs(1500, '这句话还没有说完'), 1900);
  assert.equal(computeTurnEndSilenceMs(1500, '我接下来想说的是，然后'), 2800);
  assert.equal(computeTurnEndSilenceMs(1500, '还有一点，'), 2800);
  assert.equal(computeTurnEndSilenceMs(3000, '因为'), 4000);
  assert.equal(computeTurnEndSilenceMs(100, '完成。'), 900);
});

test('default speech chunker keeps the first unpunctuated chunk short', () => {
  const chunker = new IncrementalSpeechChunker();
  const chunks = chunker.pushDelta('这是第一段需要尽快播放随后再继续保持自然语气');
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].length <= 12);
  assert.ok(chunks[0].length >= 5);
});

test('system speech rate remains inside browser-safe realtime bounds', () => {
  assert.equal(systemSpeechRate(0), 1);
  assert.equal(systemSpeechRate(50), 1.5);
  assert.equal(systemSpeechRate(-50), 0.6);
  assert.equal(systemSpeechRate(500), 1.5);
});

test('tool-aware speech gate keeps Agent prose continuous across a tool boundary', () => {
  const gate = new ToolAwareSpeechGate({
    firstMinChars: 2,
    firstMaxChars: 12,
    nextMinChars: 2,
    nextMaxChars: 16,
  });
  assert.deepEqual(gate.pushText('我先帮你查询一下。'), []);
  assert.equal(gate.hasStagedSpeech, true);

  assert.deepEqual(gate.toolStarted(), ['我先帮你查询一下。']);
  assert.deepEqual(gate.pushText('已经取得天气数据。', true), ['已经取得天气数据。']);
  assert.deepEqual(gate.pushText('上海明天有阵雨，建议带伞。', false), ['上海明天有阵雨，建议带伞。']);
  assert.deepEqual(gate.finish(), []);
});

test('later tools preserve spoken stage results in order', () => {
  const gate = new ToolAwareSpeechGate({ firstMinChars: 2, firstMaxChars: 20 });
  const spoken = [];
  spoken.push(...gate.pushText('准备处理。'));
  spoken.push(...gate.toolStarted());
  spoken.push(...gate.pushText('第一步结果。', true));
  spoken.push(...gate.toolStarted());
  spoken.push(...gate.pushText('最终结论。', false));
  spoken.push(...gate.finish());
  assert.deepEqual(spoken, ['准备处理。', '第一步结果。', '最终结论。']);
});

test('only Agent text deltas are eligible for speech, never tool payloads', () => {
  assert.equal(isSpeakableAgentDelta('text_delta'), true);
  for (const type of [
    'thinking', 'tool_start', 'tool_input', 'tool_result', 'tool_end',
    'subagent_start', 'subagent_progress', 'subagent_done',
  ]) {
    assert.equal(isSpeakableAgentDelta(type), false, type);
  }
});

test('plain replies leave the stability window and then stream normally', () => {
  const gate = new ToolAwareSpeechGate({
    firstMinChars: 2,
    firstMaxChars: 12,
    nextMinChars: 2,
    nextMaxChars: 12,
  });
  gate.pushText('第一句完成。');
  assert.deepEqual(gate.commitStable(), ['第一句完成。']);
  assert.deepEqual(gate.pushText('第二句完成。'), ['第二句完成。']);
  assert.deepEqual(gate.finish(), []);
});

test('barge-in policy has no playback blind zone and adapts to residual echo', () => {
  const opening = echoProtectedBargeIn(0.018, true, 80, Infinity, 0.008);
  assert.equal(opening.enabled, true);
  assert.equal(opening.requiredFrames, 3);
  const speaking = echoProtectedBargeIn(0.018, true, 900, Infinity, 0.008);
  assert.equal(speaking.enabled, true);
  assert.equal(speaking.requiredFrames, 2);
  assert.ok(speaking.threshold < 0.025);
  const noisyPlayback = echoProtectedBargeIn(0.018, true, 900, Infinity, 0.03);
  assert.ok(noisyPlayback.threshold > speaking.threshold);
  assert.equal(echoProtectedBargeIn(0.018, false, 0, 100).enabled, false);
  assert.deepEqual(echoProtectedBargeIn(0.018, false, 0, 1000), {
    enabled: true,
    threshold: 0.018,
    requiredFrames: 3,
  });
});

test('playback echo floor follows quiet output quickly but human peaks slowly', () => {
  const initial = updatePlaybackEchoFloor(0, 0.01);
  const quieter = updatePlaybackEchoFloor(initial, 0.006);
  const humanPeak = updatePlaybackEchoFloor(quieter, 0.08);
  assert.equal(initial, 0.01);
  assert.ok(quieter < initial);
  assert.ok(humanPeak < 0.012);
  assert.ok(humanPeak < 0.08 / 6);
});

test('recent assistant playback is not accepted as a new user utterance', () => {
  assert.equal(
    isLikelyPlaybackEcho('上海明天有阵雨', '查询完成。上海明天有阵雨，建议带伞。'),
    true,
  );
  assert.equal(
    isLikelyPlaybackEcho('不对，请重新查', '查询完成。上海明天有阵雨，建议带伞。'),
    false,
  );
  assert.equal(isLikelyPlaybackEcho('等等', '请稍等一下。'), false);
});
