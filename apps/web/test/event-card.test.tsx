/** 四类事件卡的渲染。字段与颜色逐条对着 `design/memory-panel.md` § 2 与 § 3。 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EventCard } from '../src/components/EventCard.js';
import { makeEvent } from './helpers.js';

function show(event: ReturnType<typeof makeEvent>, expanded = false) {
  return render(<EventCard event={event} expanded={expanded} onToggle={vi.fn()} />);
}

describe('EventCard · 卡头', () => {
  it('时间格式化成 HH:mm:ss，title 里给完整 ISO 与 trace_id', () => {
    const ev = makeEvent('write', {
      facts: [{ id: 'f1', text: '他住深圳', entities: [], valid_from: '' }]
    });
    ev.ts = '2026-09-05T10:20:33.000Z';
    show(ev);
    const head = screen.getByRole('button', { expanded: false });
    expect(head.getAttribute('title')).toContain('trc_test');
    expect(head.getAttribute('title')).toContain('2026-09-05T10:20:33.000Z');
    expect(head.textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('write 的摘要取第一条 fact，多于一条时加「等 N 条」', () => {
    show(
      makeEvent('write', {
        facts: [
          { id: 'f1', text: '他住深圳', entities: [], valid_from: '' },
          { id: 'f2', text: '他爱旧书店', entities: [], valid_from: '' }
        ]
      })
    );
    expect(screen.getByText('他住深圳 等 2 条')).toBeTruthy();
  });

  it('merge 的摘要取 result_text，recall 取 query，filter 取 input_preview', () => {
    show(makeEvent('merge', { result_id: 'r', result_text: '并成一条' }));
    expect(screen.getByText('并成一条')).toBeTruthy();
    show(makeEvent('recall', { query: '上次那事', hits: [], cold_promoted: [] }));
    expect(screen.getByText('上次那事')).toBeTruthy();
    show(makeEvent('filter', { decision: 'accept', score: 0.9, input_preview: '明天下午' }));
    expect(screen.getByText('明天下午')).toBeTruthy();
  });
});

describe('EventCard · 四类事件的视觉', () => {
  it('filter.reject 整卡打灰，用 reject 配色', () => {
    const { container } = show(
      makeEvent('filter', { decision: 'reject', score: 0.1, input_preview: 'x' })
    );
    expect(container.querySelector('.qq-card--filter-reject')).toBeTruthy();
  });

  it('filter.uncertain 有「留下 / 丢掉」二选一', () => {
    show(makeEvent('filter', { decision: 'uncertain', score: 0.5, input_preview: 'x' }));
    expect(screen.getByText('留下')).toBeTruthy();
    expect(screen.getByText('丢掉')).toBeTruthy();
  });

  it('filter.accept 用 write 的绿色，不打灰', () => {
    const { container } = show(
      makeEvent('filter', { decision: 'accept', score: 0.9, input_preview: 'x' })
    );
    expect(container.querySelector('.qq-card--filter-accept')).toBeTruthy();
    expect(container.querySelector('.qq-card--filter-reject')).toBeNull();
  });

  it('recall 的 cold_promoted 非空时右上角有「回热 N 条」', () => {
    show(makeEvent('recall', { query: 'q', hits: [], cold_promoted: ['a', 'b'] }));
    expect(screen.getByText('回热 2 条')).toBeTruthy();
  });

  it('拖动阈值时按新阈值重新着色，但徽章仍显示原判定', () => {
    const ev = makeEvent('filter', { decision: 'reject', score: 0.5, input_preview: 'x' });
    const { container } = render(
      <EventCard
        event={ev}
        expanded={false}
        onToggle={vi.fn()}
        preview={{ accept: 0.9, uncertain: 0.4 }}
      />
    );
    expect(container.querySelector('.qq-card--filter-uncertain')).toBeTruthy();
    expect(screen.getByText('筛选·丢掉')).toBeTruthy();
  });
});

describe('EventCard · 展开态', () => {
  it('filter 展开后有 score（两位小数、等宽）、reason、source 中文名', () => {
    show(
      makeEvent('filter', {
        decision: 'uncertain',
        score: 0.5,
        reason: '像是安排，但时间缺',
        source: 'ambient_audio',
        input_preview: '……明天下午……'
      }),
      true
    );
    expect(screen.getByText('0.50')).toBeTruthy();
    expect(screen.getByText('像是安排，但时间缺')).toBeTruthy();
    expect(screen.getByText('环境音')).toBeTruthy();
  });

  it('write 展开后每条事实一行，标签最多 3 个、超出显示 +N，valid_from 格式化成日期', () => {
    const { container } = show(
      makeEvent('write', {
        raw: '我上周搬到深圳了',
        speaker: 'user',
        facts: [
          {
            id: 'fact_abc',
            text: '他上周搬到深圳',
            entities: ['时间', '地点', '人物', '习惯'],
            valid_from: '2026-09-05T00:00:00.000Z'
          }
        ],
        dropped_spans: ['嗯……']
      }),
      true
    );
    expect(screen.getByText('你')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('2026-09-05')).toBeTruthy();
    // fact id 不显示，放进 data-fact-id 供「跳到记忆库」用
    expect(container.querySelector('[data-fact-id="fact_abc"]')).toBeTruthy();
    expect(screen.getByText('丢掉了 1 段')).toBeTruthy();
    expect(screen.getByText('看原话')).toBeTruthy();
  });

  it('merge 展开后旧条划线，result_id 放进 data-memory-id', () => {
    const { container } = show(
      makeEvent('merge', {
        result_id: 'fact_new',
        result_text: '他现在住在深圳',
        absorbed: [{ id: 'fact_old1', text: '他上周搬到深圳' }],
        invalidated: [{ id: 'fact_old2', text: '他住在北京', valid_to: '2026-09-05T00:00:00.000Z' }]
      }),
      true
    );
    expect(container.querySelector('[data-memory-id="fact_new"]')).toBeTruthy();
    expect(screen.getByText('合并了 1 条')).toBeTruthy();
    expect(screen.getByText('作废 1 条')).toBeTruthy();
    const struck = container.querySelectorAll('.qq-strike');
    expect(struck.length).toBe(2);
  });

  it('recall 展开后画路径胶囊，skipped 的加删除线，改写行与 query 相同时不渲染', () => {
    const { container } = show(
      makeEvent('recall', {
        query: '上次那事',
        plan: { paths: ['semantic', 'lexical'], depth: 2, rewritten: '上次那事' },
        hits: [{ id: 'fact_9a13c2f0', text: '他上周搬到深圳', path: 'semantic', score: 0.83 }],
        skipped_paths: ['symbolic'],
        tokens_injected: 184,
        cold_promoted: []
      }),
      true
    );
    expect(screen.getAllByText('按意思').length).toBeGreaterThan(0);
    expect(screen.getByText('按标签').className).toContain('qq-pill--skipped');
    expect(screen.getByText('深度 2')).toBeTruthy();
    expect(screen.getByText('注入 184 tokens')).toBeTruthy();
    expect(container.textContent).not.toContain('改写为');
  });

  it('空数组的小节整段不渲染，不显示「0 条」', () => {
    const { container } = show(
      makeEvent('write', { raw: '', speaker: 'user', facts: [], dropped_spans: [] }),
      true
    );
    expect(container.textContent).not.toContain('丢掉了');
    expect(container.textContent).not.toContain('0 条');
  });

  it('recall 的 hits 没有 text 时退化成 id 前 8 位', () => {
    show(
      makeEvent('recall', {
        query: 'q',
        plan: { paths: ['lexical'], depth: 1, rewritten: 'q' },
        hits: [{ id: 'fact_9a13c2f0aaaa', text: '', path: 'lexical', score: 0.5 }],
        skipped_paths: [],
        tokens_injected: 0,
        cold_promoted: []
      }),
      true
    );
    expect(screen.getByText('fact_9a1…')).toBeTruthy();
  });
});
