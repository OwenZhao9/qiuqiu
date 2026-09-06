/**
 * 显示层的纯函数。
 *
 * `reasonCN` 守的是一条：后端那几个筛选理由是任务书钉死的验收条件
 * （`docs/agents/05-memory.md` 拿 `Silence detected` 当断言），改不得；
 * 但它们会原样出现在中文界面里。翻译只在显示这一层做。
 */

import { describe, expect, it } from 'vitest';
import { reasonCN } from '../src/format.js';

describe('reasonCN', () => {
  it('固定的几条照表翻', () => {
    expect(reasonCN('Silence detected')).toBe('这一段没有人声');
    expect(reasonCN('Blank frame detected')).toBe('画面是空的');
    expect(reasonCN('Empty input')).toBe('没有内容');
    expect(reasonCN('Question, not a statement')).toBe('是个问句，不记');
  });

  it('带数字的把数字带过来', () => {
    expect(reasonCN('Low information density (2 content tokens)')).toBe(
      '信息太少，只有 2 个信息单元'
    );
    expect(reasonCN('Informative speech (11 content tokens)')).toBe('有内容，11 个信息单元');
    expect(reasonCN('Informative speech (1 content token)')).toBe('有内容，1 个信息单元');
  });

  it('去重那条把重合度和原句都带上', () => {
    expect(reasonCN('Duplicate of recent input (Jaccard 0.86): 我住深圳')).toBe(
      '跟刚才那句重了（重合度 0.86）：我住深圳'
    );
  });

  it('不认识的原样返回，不吞掉信息', () => {
    expect(reasonCN('Some new reason from the future')).toBe('Some new reason from the future');
  });

  it('空的就是空的', () => {
    expect(reasonCN('')).toBe('');
    expect(reasonCN('   ')).toBe('');
  });
});
