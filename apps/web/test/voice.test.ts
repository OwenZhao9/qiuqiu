/**
 * 语音链路的纯函数部分。降采样错了只表现为「声音变调」，
 * 在浏览器里很难查，所以在这里钉死。
 */

import { describe, expect, it } from 'vitest';
import { downsample, nextPhase, UPLINK_RATE, type VoicePhase } from '../src/voice.js';

/** 一段正弦，采样率可变。 */
function sine(hz: number, rate: number, ms: number): Float32Array {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.sin((2 * Math.PI * hz * i) / rate) * 0.5;
  return out;
}

/** 过零次数 ≈ 频率 × 时长 × 2，用它验降采样没把音高弄错。 */
function zeroCrossings(pcm: Int16Array): number {
  let n = 0;
  for (let i = 1; i < pcm.length; i += 1) {
    if ((pcm[i - 1] < 0 && pcm[i] >= 0) || (pcm[i - 1] >= 0 && pcm[i] < 0)) n += 1;
  }
  return n;
}

describe('downsample', () => {
  it('48k 降到 16k 长度正好三分之一', () => {
    const out = downsample(sine(440, 48000, 100), 48000, UPLINK_RATE);
    expect(out.length).toBe(1600); // 100ms @16k
  });

  it('44.1k 也能降，长度按比例', () => {
    const out = downsample(sine(440, 44100, 100), 44100, UPLINK_RATE);
    expect(out.length).toBe(Math.floor(4410 / (44100 / 16000)));
  });

  it('采样率相同就只做格式转换，长度不变', () => {
    const input = sine(440, 16000, 50);
    expect(downsample(input, 16000, 16000).length).toBe(input.length);
  });

  it('音高不变——降采样最容易错的就是这个', () => {
    // 440Hz 响 100ms，过零约 88 次。差太多说明重采样比例算错了
    const out = downsample(sine(440, 48000, 100), 48000, UPLINK_RATE);
    expect(zeroCrossings(out)).toBeGreaterThan(80);
    expect(zeroCrossings(out)).toBeLessThan(96);
  });

  it('输出是 int16 且不溢出', () => {
    const loud = new Float32Array(100).fill(2); // 故意超出 [-1,1]
    const out = downsample(loud, 48000, UPLINK_RATE);
    expect(out).toBeInstanceOf(Int16Array);
    for (const v of out) expect(Math.abs(v)).toBeLessThanOrEqual(32767);
  });

  it('静音进去静音出来', () => {
    const out = downsample(new Float32Array(4800), 48000, UPLINK_RATE);
    expect([...out].every((v) => v === 0)).toBe(true);
  });
});

describe('nextPhase · 通话过程中的听 / 想 / 说', () => {
  /**
   * 原来整通电话只报一次 `listening`：丘丘在想、在说，脸上一点变化都没有。
   * 端到端链路的帧里没有「现在轮到谁」，只能按帧推。
   */
  it('用户这句定稿了 → 在想', () => {
    expect(nextPhase('listening', { type: 'final', role: 'user' })).toBe('thinking');
  });

  it('模型那句定稿不算 —— 它是说完之后才发的', () => {
    expect(nextPhase('speaking', { type: 'final', role: 'assistant' })).toBeNull();
  });

  it('第一帧音频 → 在说', () => {
    expect(nextPhase('thinking', { type: 'audio' })).toBe('speaking');
  });

  it('说的过程中每帧音频都来，只在头一帧报一次', () => {
    expect(nextPhase('speaking', { type: 'audio' })).toBeNull();
  });

  it('一轮说完 → 回到在听', () => {
    expect(nextPhase('speaking', { type: 'turn_end' })).toBe('listening');
  });

  it('用户中途插话 → 立刻回到在听', () => {
    expect(nextPhase('speaking', { type: 'interrupt' })).toBe('listening');
  });

  it('别的帧不动段落', () => {
    for (const type of ['partial', 'error', '']) {
      expect(nextPhase('listening', { type })).toBeNull();
    }
  });

  it('一整轮走下来是 听 → 想 → 说 → 听', () => {
    const frames = [
      { type: 'partial' },
      { type: 'final', role: 'user' },
      { type: 'audio' },
      { type: 'audio' },
      { type: 'final', role: 'assistant' },
      { type: 'turn_end' }
    ];
    let phase: VoicePhase = 'listening';
    const seen: VoicePhase[] = [];
    for (const f of frames) {
      const moved = nextPhase(phase, f);
      if (moved) {
        phase = moved;
        seen.push(moved);
      }
    }
    // 中间那一下 thinking 是必须的：状态机挡着 listening → speaking
    expect(seen).toEqual(['thinking', 'speaking', 'listening']);
  });
});
