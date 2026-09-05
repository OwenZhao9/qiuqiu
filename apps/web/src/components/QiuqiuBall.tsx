/**
 * 丘丘的挂载点。尺寸由 `preset` 决定（`design/character.md` § 3）：
 * 桌宠 200、主窗口 120、网页 160。容器自己写死像素，引擎铺满容器。
 */

import type { QiuqiuInstance, QiuqiuPreset } from '@qiuqiu/character';
import { useQiuqiu } from '../qiuqiu/useQiuqiu.js';

const SIZE_CLASS: Record<QiuqiuPreset, string> = {
  pet: 'qq-pet__ball',
  main: 'qq-main-ball',
  web: 'qq-web-ball'
};

export interface QiuqiuBallProps {
  preset: QiuqiuPreset;
  gaze?: 'pointer' | false;
  onReady?(q: QiuqiuInstance): void;
  className?: string;
}

export function QiuqiuBall({
  preset,
  gaze,
  onReady,
  className
}: QiuqiuBallProps): React.JSX.Element {
  const { ref, error } = useQiuqiu({ preset, gaze, onReady });
  return (
    <div
      className={(className ?? SIZE_CLASS[preset]) + ' qq-ball-host'}
      ref={ref}
      data-testid="qiuqiu"
    >
      {error ? (
        <div className="qq-error">
          丘丘没画出来：{error.message}
          <span className="qq-error__hint">
            确认构建把 packages/character/vendor/emotion-ball 拷进了 dist/vendor 下
          </span>
        </div>
      ) : null}
    </div>
  );
}
