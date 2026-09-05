/**
 * 丘丘的主题补丁：暖奶油体色 `#F2E7D3` + 暖墨眼色 `#2A2621`。
 *
 * **不走 `EmotionBall.create` 的 `opts.color` / `opts.eyeColor`。**
 * 引擎每帧无条件执行 `pose.body.color = theme.body`，会同时废掉三处色彩表演：
 * `21` 生气变红、`14` 害羞变粉、`34` 出错红白闪。丘丘这三个都用得上。
 *
 * 改为在创建任何实例**之前**用公开 API `EmotionBall.config.register()`
 * 打一遍纯数据补丁，不触碰 `vendor/emotion-ball/` 任何文件。
 * 算法与补丁表逐行来自 `design/character.md` § 2，契约见 `docs/CONTRACTS.md` § 6。
 */

import {
  ALL_EMOTION_IDS,
  type EmotionBallGlobal,
  type EmotionId,
  type EmotionRaw
} from './types.js';

/** 丘丘体色，暖奶油。 */
export const QIUQIU_BODY_COLOR = '#F2E7D3';

/** 丘丘眼色，暖墨。比引擎默认 `#1A1A1A` 略暖，与体色对比度 13.4:1。 */
export const QIUQIU_EYE_COLOR = '#2A2621';

/**
 * 体色补丁表：只列 11 个自带语义体色的表情，其余 21 个统一 `#F2E7D3`。
 * `21` 生气与 `34` 出错的语义红原样保留。
 */
export const BODY_COLOR_PATCH: Readonly<Partial<Record<EmotionId, string>>> = {
  '00': '#E9DECB', // 睡眠，暗一档
  '06': '#E5DAC6', // 休眠，暗两档
  '10': '#F8EEDA', // 开心，亮一档
  '12': '#E7E0D2', // 失落，暗一档、去暖
  '14': '#F3D2C6', // 害羞，暖粉
  '15': '#EBE1CF', // 疲惫，暗一档
  '19': '#F7EDD8', // 满意，亮一档
  '21': '#E4574A', // 生气，语义红，原样保留
  '34': '#E25B5B', // 出错，语义红，原样保留
  '38': '#EAE0D2', // 拒绝，暗一档
  '41': '#E6DCC9' // 停止，暗一档
};

/**
 * 序列帧里要替换成丘丘体色的上游默认色。
 * `34` 出错序列里的 `#DE5555` 是红闪的第二帧，保留不动。
 */
export const UPSTREAM_BASE_COLORS: readonly string[] = ['#F3F0EA', '#F6F3EC'];

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 已经打过补丁的 EmotionBall 全局对象，重复调用直接跳过。 */
const patched = new WeakSet<object>();

export interface ApplyThemeResult {
  /** 实际重新注册了多少个表情。 */
  patched: number;
  /** 配置里找不到的 ID（正常应为空数组）。 */
  missing: EmotionId[];
  /** 本次是不是真的跑了（重复调用且未 force 时为 false）。 */
  ran: boolean;
}

/**
 * 对 32 个表情逐个打主题补丁，全局生效，创建实例之前执行一次。
 *
 * 1. 体色：在补丁表里的用表里的值，否则统一 `#F2E7D3`
 * 2. 序列起始色：`#F3F0EA` / `#F6F3EC` 一律换成 `#F2E7D3`
 * 3. 眼色：`raw.eyes = { both: { color: '#2A2621' }, ...raw.eyes }`
 *    —— 实际做的是深合并，见函数内注释；表情自带的 `both` / `left` / `right` 都不受影响。
 */
export function applyQiuqiuTheme(
  eb: EmotionBallGlobal,
  opts: { force?: boolean } = {}
): ApplyThemeResult {
  if (!eb || !eb.config) {
    throw new Error(
      '[qiuqiu] applyQiuqiuTheme：拿不到 EmotionBall.config，先加载 vendor/emotion-ball 的四个脚本'
    );
  }
  if (patched.has(eb) && !opts.force) {
    return { patched: 0, missing: [], ran: false };
  }

  const missing: EmotionId[] = [];
  let count = 0;

  for (const id of ALL_EMOTION_IDS) {
    const def = eb.config.get(id);
    if (!def || !def.raw) {
      missing.push(id);
      continue;
    }
    const raw = deepClone(def.raw) as EmotionRaw;

    // 1 · 体色
    const body: Record<string, unknown> = isPlainObject(raw.body) ? { ...raw.body } : {};
    body.color = BODY_COLOR_PATCH[id] ?? QIUQIU_BODY_COLOR;
    raw.body = body as EmotionRaw['body'];

    // 2 · 序列起始色
    if (raw.sequence && Array.isArray(raw.sequence.frames)) {
      for (const frame of raw.sequence.frames) {
        const fb = frame.body;
        if (
          isPlainObject(fb) &&
          typeof fb.color === 'string' &&
          UPSTREAM_BASE_COLORS.includes(fb.color)
        ) {
          fb.color = QIUQIU_BODY_COLOR;
        }
      }
    }

    // 3 · 眼色
    // design/character.md § 2 写的是 `raw.eyes = { both: { color }, ...raw.eyes }`，
    // 但 32 个表情里有 30 处声明了 `eyes.both`（`00` 的 `{ y: 4, lookY: 2 }` 之类），
    // 浅展开会把整个 `both` 覆盖掉、连眼色一起丢。这里按文档的**意图**做深合并：
    // 先铺眼色再铺表情自带的 `both` 字段。没有任何一个表情声明过眼色，两者不冲突；
    // `applySpec` 恒先应用 `both` 再应用 `left` / `right`，左右差异同样不受影响。
    const eyes: Record<string, unknown> = isPlainObject(raw.eyes) ? { ...raw.eyes } : {};
    eyes.both = {
      color: QIUQIU_EYE_COLOR,
      ...(isPlainObject(eyes.both) ? eyes.both : {})
    };
    raw.eyes = eyes;

    const res = eb.config.register(raw);
    if (!res || res.ok === false) {
      throw new Error(
        `[qiuqiu] 主题补丁注册失败：${id} —— ${res && res.errors ? res.errors.join('；') : '未知原因'}`
      );
    }
    count++;
  }

  patched.add(eb);
  return { patched: count, missing, ran: true };
}

/** 仅供测试：忘掉某个 EmotionBall 已打过补丁的记录。 */
export function resetThemeFlag(eb: EmotionBallGlobal): void {
  patched.delete(eb);
}
