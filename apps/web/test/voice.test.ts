/**
 * 语音链路的纯函数部分。降采样错了只表现为「声音变调」，
 * 在浏览器里很难查，所以在这里钉死。
 */

import { describe, expect, it } from 'vitest';
import { downsample, UPLINK_RATE } from '../src/voice.js';

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
