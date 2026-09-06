/**
 * 记忆管线流程图。「记忆过程看得见」是第一质量属性，这张图是它的落点。
 *
 * 测的是**事件 → 管线状态**的映射：哪一段亮、哪一段跳过、丢掉的片段有没有显示出来。
 * 图上每个字都得能追到某条事件的某个字段（AD-14）。
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryFlow } from '../src/components/MemoryFlow.js';
import { derivePipeline } from '../src/store/pipeline.js';
import type { MemoryEventEnvelope } from '../src/api.js';

let seq = 0;
function ev(
  type: MemoryEventEnvelope['type'],
  payload: unknown,
  trace = 'trc_same'
): MemoryEventEnvelope {
  seq += 1;
  return {
    id: 'evt_' + seq,
    ts: '2026-09-05T00:00:00.000Z',
    trace_id: trace,
    type,
    payload
  } as MemoryEventEnvelope;
}

const WRITE = {
  raw: '我叫赵宁，住深圳。今天天气还行吧。',
  speaker: 'user',
  facts: [
    { id: 'f1', text: '赵宁住在深圳', entities: [], valid_from: '' },
    { id: 'f2', text: '用户叫赵宁', entities: [], valid_from: '' }
  ],
  dropped_spans: ['今天天气还行吧。']
};

describe('derivePipeline', () => {
  it('没有事件时是空管线', () => {
    const p = derivePipeline([]);
    expect(p.lane).toBeNull();
    expect(p.stages.compress.status).toBe('idle');
  });

  it('主动输入把筛选那段标成跳过，不是没走到', () => {
    // AD-3：用户主动说的不筛。图上要能看出「不筛」和「还没走到」的区别
    const p = derivePipeline([ev('write', WRITE)]);
    expect(p.stages.filter.status).toBe('skip');
    expect(p.stages.filter.detail).toContain('主动输入');
    expect(p.stages.compress.status).toBe('done');
    expect(p.stages.store.detail).toContain('2');
  });

  it('被动采集判丢掉时，后面三段全部跳过', () => {
    const p = derivePipeline([
      ev('filter', {
        decision: 'reject',
        score: 0.1,
        reason: 'VAD 判定这一段没有人声',
        source: 'ambient_audio',
        input_preview: '[音频片段]'
      })
    ]);
    expect(p.stages.filter.detail).toBe('丢掉');
    for (const id of ['compress', 'synthesize', 'store'] as const) {
      expect(p.stages[id].status).toBe('skip');
    }
  });

  it('合成没发事件就是无可并，不是没走到', () => {
    const p = derivePipeline([ev('write', WRITE)]);
    expect(p.stages.synthesize.status).toBe('done');
    expect(p.stages.synthesize.detail).toBe('无可并');
  });

  it('合成发了事件就算并掉的条数', () => {
    const p = derivePipeline([
      ev('write', WRITE),
      ev('merge', {
        result_id: 'f9',
        result_text: '赵宁住在深圳',
        absorbed: [{ id: 'f1', text: '赵宁在深圳' }],
        invalidated: [{ id: 'f0', text: '赵宁住在北京', valid_to: '' }]
      })
    ]);
    expect(p.stages.synthesize.detail).toContain('2');
    expect(p.invalidated[0].text).toBe('赵宁住在北京');
  });

  it('一轮里两次写入不互相覆盖', () => {
    // AD-6：用户那句和 AI 那句都进记忆，同一条 trace 下会有两条 write。
    // 后一条覆盖前一条的话，图上显示「拆出 0 条」而卡片里明明有事实——踩过。
    const p = derivePipeline([
      ev('write', WRITE),
      ev('write', {
        raw: '你好呀',
        speaker: 'assistant',
        facts: [{ id: 'r1', text: '丘丘向赵宁做了自我介绍', entities: [], valid_from: '' }],
        dropped_spans: []
      })
    ]);
    expect(p.facts).toHaveLength(2);
    expect(p.replyFacts).toHaveLength(1);
    expect(p.stages.compress.detail).toBe('拆出 3 条');
    // 用户那句的原话不能被 AI 那句顶掉
    expect(p.input).toBe(WRITE.raw);
  });

  it('AI 那句拆出零条时，用户那句的计数还在', () => {
    const p = derivePipeline([
      ev('write', WRITE),
      ev('write', { raw: '好的', speaker: 'assistant', facts: [], dropped_spans: ['好的'] })
    ]);
    expect(p.stages.store.detail).toBe('写入 2 条');
  });

  it('召回走另一条线，记下走了哪几路、跳过哪几路', () => {
    const p = derivePipeline([
      ev('recall', {
        query: '我住哪儿',
        plan: { paths: ['semantic', 'lexical'], depth: 1, rewritten: '' },
        hits: [{ id: 'f1', text: '赵宁住在深圳', path: 'semantic', score: 0.9 }],
        skipped_paths: ['symbolic'],
        tokens_injected: 40,
        cold_promoted: ['f7']
      })
    ]);
    expect(p.lane).toBe('recall');
    expect(p.paths).toEqual(['semantic', 'lexical']);
    expect(p.skipped).toEqual(['symbolic']);
    expect(p.stages.recall.detail).toContain('回热');
  });

  it('只画最近一条 trace，几轮不会糊在一起', () => {
    const p = derivePipeline([
      ev('write', { ...WRITE, raw: '上一轮' }, 'trc_old'),
      ev('write', { ...WRITE, raw: '这一轮' }, 'trc_new')
    ]);
    expect(p.traceId).toBe('trc_new');
    expect(p.input).toBe('这一轮');
  });
});

describe('MemoryFlow', () => {
  it('空态给一句能看懂的提示', () => {
    render(<MemoryFlow events={[]} />);
    expect(screen.getByText(/说点什么/)).toBeTruthy();
  });

  it('写入这轮画出四段与拆出来的事实', () => {
    render(<MemoryFlow events={[ev('write', WRITE)]} />);
    const list = screen.getByRole('list', { name: '记忆管线' });
    for (const label of ['筛选', '压缩', '合成', '热存储']) {
      expect(within(list).getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('赵宁住在深圳')).toBeTruthy();
    expect(screen.getByText('我叫赵宁，住深圳。今天天气还行吧。')).toBeTruthy();
  });

  it('被丢掉的片段显示出来，不是悄悄没了', () => {
    render(<MemoryFlow events={[ev('write', WRITE)]} />);
    expect(screen.getByLabelText('被丢掉的片段').textContent).toContain('今天天气还行吧');
  });

  it('召回这轮画的是另外三段', () => {
    render(
      <MemoryFlow
        events={[
          ev('recall', {
            query: '我住哪儿',
            plan: { paths: ['semantic'], depth: 1, rewritten: '' },
            hits: [{ id: 'f1', text: '赵宁住在深圳', path: 'semantic', score: 0.9 }],
            skipped_paths: ['lexical'],
            tokens_injected: 20,
            cold_promoted: []
          })
        ]}
      />
    );
    const list = screen.getByRole('list', { name: '记忆管线' });
    expect(within(list).getByText('检索规划')).toBeTruthy();
    expect(within(list).queryByText('压缩')).toBeNull();
    // 走了的路与跳过的路都要看得见。「按意思」在三路标签和命中条目上各出现一次，
    // 所以按 class 限定，别用全局文字查找
    const onPath = document.querySelector('.qq-flow__path--on');
    const offPath = document.querySelector('.qq-flow__path--off');
    expect(onPath?.textContent).toBe('按意思');
    expect(offPath?.textContent).toBe('按字面');
  });

  it('每一段带得上无障碍名字，读屏也能听出走到哪了', () => {
    render(<MemoryFlow events={[ev('write', WRITE)]} />);
    expect(screen.getByLabelText(/压缩：拆出 2 条/)).toBeTruthy();
  });
});

const RECALL_PAYLOAD = {
  query: '我住哪儿',
  plan: { paths: ['semantic'], depth: 1, rewritten: '' },
  hits: [{ id: 'f1', text: '赵宁住在深圳', path: 'semantic', score: 0.9 }],
  skipped_paths: [],
  tokens_injected: 40,
  cold_promoted: []
};

describe('derivePipeline · 一轮里两条线的先后', () => {
  /**
   * 一句话通常两条线都走：先检索拿旧记忆去答，答完再把这句和回复记下来。
   * 只看 `lane`（最后一条事件属于哪条线）的话，图上永远只画得出其中一条。
   */
  it('两条都走过时按第一次出现的先后记下来', () => {
    const p = derivePipeline([
      ev('recall', RECALL_PAYLOAD, 't1'),
      ev('write', WRITE, 't1'),
      ev('merge', { absorbed: [], invalidated: [] }, 't1')
    ]);
    expect(p.lanes).toEqual(['recall', 'ingest']);
  });

  it('只走了一条就只有一条', () => {
    expect(derivePipeline([ev('write', WRITE)]).lanes).toEqual(['ingest']);
    expect(derivePipeline([ev('recall', RECALL_PAYLOAD)]).lanes).toEqual(['recall']);
  });

  it('没有事件时是空的', () => {
    expect(derivePipeline([]).lanes).toEqual([]);
  });
});
