/** SSE 解析的单测。`docs/CONVENTIONS.md` 要求 `apps/web` 的 SSE 解析有单测。 */

import { describe, expect, it } from 'vitest';
import { createSseParser, cursorOf } from '../src/api.js';

describe('createSseParser', () => {
  it('一帧一帧地拆出 event 与 data', () => {
    const p = createSseParser();
    const frames = p.feed(
      'event: delta\ndata: {"text":"你"}\n\nevent: delta\ndata: {"text":"好"}\n\n'
    );
    expect(frames).toEqual([
      { event: 'delta', data: '{"text":"你"}', id: undefined },
      { event: 'delta', data: '{"text":"好"}', id: undefined }
    ]);
  });

  it('半行留在缓冲里，等下一个 chunk 拼上', () => {
    const p = createSseParser();
    expect(p.feed('event: del')).toEqual([]);
    expect(p.feed('ta\ndata: {"text":"半"}')).toEqual([]);
    const frames = p.feed('\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event: 'delta', data: '{"text":"半"}' });
  });

  it('多行 data 用 \\n 拼起来', () => {
    const p = createSseParser();
    const frames = p.feed('event: write\ndata: 第一行\ndata: 第二行\n\n');
    expect(frames[0].data).toBe('第一行\n第二行');
  });

  it('冒号后的一个空格要吃掉，多的留着', () => {
    const p = createSseParser();
    const frames = p.feed('event: meta\ndata:  两个空格\n\n');
    expect(frames[0].data).toBe(' 两个空格');
  });

  it('CRLF 与单独的 CR 都算换行', () => {
    const p = createSseParser();
    const a = p.feed('event: done\r\ndata: {}\r\n\r\n');
    expect(a[0]).toMatchObject({ event: 'done', data: '{}' });
    const b = p.feed('event: done\rdata: {}\r\r');
    expect(b[0]).toMatchObject({ event: 'done', data: '{}' });
  });

  it('冒号开头的注释（心跳）跳过，不产生帧', () => {
    const p = createSseParser();
    expect(p.feed(': keep-alive\n\n')).toEqual([]);
  });

  it('没写 event 字段时事件名回落 message', () => {
    const p = createSseParser();
    const frames = p.feed('data: {"id":"evt_1"}\n\n');
    expect(frames[0].event).toBe('message');
  });

  it('id 字段带出来，供 Last-Event-ID 用', () => {
    const p = createSseParser();
    const frames = p.feed('id: 42\nevent: message\ndata: {}\n\n');
    expect(frames[0].id).toBe('42');
  });

  it('flush 把最后一帧没有空行收尾的补上', () => {
    const p = createSseParser();
    expect(p.feed('event: done\ndata: {"x":1}')).toEqual([]);
    const frames = p.flush();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event: 'done', data: '{"x":1}' });
  });

  it('单个字符喂进去也拆得对', () => {
    const p = createSseParser();
    const raw = 'event: delta\ndata: {"text":"a"}\n\n';
    const out = [...raw].flatMap((c) => p.feed(c));
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe('{"text":"a"}');
  });
});

describe('cursorOf', () => {
  it('从 evt_ 前缀里取出自增 id', () => {
    expect(cursorOf('evt_128')).toBe(128);
  });

  it('后端直接给数字也认', () => {
    expect(cursorOf('77')).toBe(77);
  });

  it('认不出来时给 null，游标不前进', () => {
    expect(cursorOf('evt_abc')).toBeNull();
  });
});
