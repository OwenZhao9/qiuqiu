/**
 * 丘丘的主题补丁：给 32 个表情逐个换体色与眼色。
 *
 * **不走 `EmotionBall.create` 的 `opts.color` / `opts.eyeColor`。**
 * 引擎每帧无条件执行 `pose.body.color = theme.body`，会同时废掉三处色彩表演：
 * `21` 生气变红、`14` 害羞变粉、`34` 出错红白闪。丘丘这三个都用得上。
 *
 * 改为在创建任何实例**之前**用公开 API `EmotionBall.config.register()`
 * 打一遍纯数据补丁，不触碰 `vendor/emotion-ball/` 任何文件。
 * 算法与补丁表逐行来自 `design/character.md` § 2，契约见 `docs/CONTRACTS.md` § 6。
 *
 * 两套配色（`CharacterLook`）：
 *
 * - `warm`  —— 原本的暖奶油，页面皮肤「素净」「卡哇伊」都用它
 * - `anime` —— 二次元少女的樱色瓷白 + 紫瞳，配 `costume.ts` 的高光腮红呆毛
 *
 * 补丁是**注册表级别**的，一次调用对同一个 `EmotionBall` 上的所有实例生效。
 */

import {
  ALL_EMOTION_IDS,
  type CharacterLook,
  type EmotionBallGlobal,
  type EmotionId,
  type EmotionRaw
} from './types.js';

/** 一套配色：底色、眼色，加 11 个自带语义体色的表情的单独取值。 */
export interface CharacterPalette {
  /** 21 个没有语义体色的表情统一用它。 */
  body: string;
  /** 全部 32 个表情的眼色。 */
  eye: string;
  /** 有语义体色的表情单独列，键不在表里就落回 `body`。 */
  bodyByEmotion: Readonly<Partial<Record<EmotionId, string>>>;
  /** 序列帧里要被替换掉的上游默认色。 */
  upstreamBase: readonly string[];
}

/** 序列帧里要替换成丘丘体色的上游默认色。
 * `34` 出错序列里的 `#DE5555` 是红闪的第二帧，保留不动。 */
export const UPSTREAM_BASE_COLORS: readonly string[] = ['#F3F0EA', '#F6F3EC'];

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

/** 二次元体色，樱色瓷白。比暖奶油更冷更亮，衬得出紫瞳。 */
export const ANIME_BODY_COLOR = '#FBE4EC';

/**
 * 二次元眼色，深堇紫。二次元的眼睛几乎不用纯黑——有色相才有「瞳」的感觉。
 * 与 `#FBE4EC` 的对比度 8.9:1，远高于 4.5:1 的下限，缩到桌宠 200 px 也看得清。
 */
export const ANIME_EYE_COLOR = '#4E3A7A';

/** 二次元的体色补丁表。语义红两条与暖色版一致——生气和出错不该因为换皮就不红了。 */
export const ANIME_BODY_COLOR_PATCH: Readonly<Partial<Record<EmotionId, string>>> = {
  '00': '#F1D8E3', // 睡眠，暗一档
  '06': '#E9CFDC', // 休眠，暗两档
  '10': '#FFEFF4', // 开心，亮一档
  '12': '#E8DEE5', // 失落，暗一档、去粉
  '14': '#FFC3D8', // 害羞，二次元的脸红要更浓
  '15': '#EFDAE4', // 疲惫，暗一档
  '19': '#FFEDF3', // 满意，亮一档
  '21': '#E4574A', // 生气，语义红，与暖色版同值
  '34': '#E25B5B', // 出错，语义红，与暖色版同值
  '38': '#EEDBE4', // 拒绝，暗一档
  '41': '#ECD8E1' // 停止，暗一档
};

/** 两套配色。`applyQiuqiuTheme` 的 `look` 选哪一套。 */
export const PALETTES: Readonly<Record<CharacterLook, CharacterPalette>> = {
  warm: {
    body: QIUQIU_BODY_COLOR,
    eye: QIUQIU_EYE_COLOR,
    bodyByEmotion: BODY_COLOR_PATCH,
    upstreamBase: UPSTREAM_BASE_COLORS
  },
  anime: {
    body: ANIME_BODY_COLOR,
    eye: ANIME_EYE_COLOR,
    bodyByEmotion: ANIME_BODY_COLOR_PATCH,
    upstreamBase: UPSTREAM_BASE_COLORS
  }
};

/**
 * 待机时关掉「小动作」的表情。
 *
 * 上游的 `antics` 是待机随机小动作：45% 概率原地自旋一圈，自旋会甩出一圈彩带。
 * 一共四个表情开了它——`02` 待机放空、`04` 发呆、`10` 开心、`19` 满意。
 *
 * 后两个是**反应**，转一圈甩点彩带是在表达「高兴」，留着。
 * 前两个是**待机**，人没在跟丘丘说话的时候，桌面上那颗球每隔十几秒自己转一圈
 * 撒一把彩带——那既不表示刚记住了什么，也不表示正在想什么，纯粹是动静。
 * `design/character.md` 的原则是「表情是信息不是装饰」，所以待机这两个关掉。
 *
 * 关掉的只是自旋与弹跳，呼吸、眨眼、看鼠标都还在，球不会变成一张静态图。
 */
export const IDLE_ANTICS_OFF: readonly EmotionId[] = ['02', '04'];

/** 序列帧里允许被换掉的起始色：上游默认色，加上每一套配色的体色。 */
const REPLACEABLE_BASE: ReadonlySet<string> = new Set([
  ...UPSTREAM_BASE_COLORS,
  ...Object.values(PALETTES).map((p) => p.body)
]);

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 每个 EmotionBall 全局对象**当前**打的是哪套配色。同一套重复调用直接跳过。 */
const patched = new WeakMap<object, CharacterLook>();

export interface ApplyThemeResult {
  /** 这次应用的配色。 */
  look: CharacterLook;
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
 * 1. 体色：在补丁表里的用表里的值，否则统一用调色板的 `body`
 * 2. 序列起始色：`#F3F0EA` / `#F6F3EC` 一律换成调色板的 `body`
 * 3. 眼色：`raw.eyes = { both: { color: 调色板的 eye }, ...raw.eyes }`
 *    —— 实际做的是深合并，见函数内注释；表情自带的 `both` / `left` / `right` 都不受影响。
 *
 * 换 `look` 会重打一遍。注意补丁读的是**当前注册表**里的 `raw`，也就是上一次补丁
 * 的产物，不是上游原文——所以每一处覆盖都必须写成「无条件赋成这次的值」，
 * 不能写成「原来没有才补上」，否则来回切形象会把上一套颜色留在里面。
 * 眼色与序列起始色这两处都踩过这个坑，见函数里的注释。
 */
export function applyQiuqiuTheme(
  eb: EmotionBallGlobal,
  opts: { force?: boolean; look?: CharacterLook } = {}
): ApplyThemeResult {
  if (!eb || !eb.config) {
    throw new Error(
      '[qiuqiu] applyQiuqiuTheme：拿不到 EmotionBall.config，先加载 vendor/emotion-ball 的四个脚本'
    );
  }
  const look: CharacterLook = opts.look ?? 'warm';
  const palette = PALETTES[look];
  if (!palette) {
    throw new Error(`[qiuqiu] applyQiuqiuTheme：未知配色 "${look}"，只有 warm / anime`);
  }
  if (patched.get(eb) === look && !opts.force) {
    return { look, patched: 0, missing: [], ran: false };
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
    body.color = palette.bodyByEmotion[id] ?? palette.body;
    raw.body = body as EmotionRaw['body'];

    // 2 · 序列起始色
    // 可替换的不只是上游默认色，还包括**任何一套配色的体色**——重打补丁时
    // `fb.color` 已经是上一套的体色了，只认上游默认色就再也换不动。
    // `34` 出错序列里的 `#DE5555`（红闪第二帧）两个集合都不在，保留不动。
    if (raw.sequence && Array.isArray(raw.sequence.frames)) {
      for (const frame of raw.sequence.frames) {
        const fb = frame.body;
        if (isPlainObject(fb) && typeof fb.color === 'string' && REPLACEABLE_BASE.has(fb.color)) {
          fb.color = palette.body;
        }
      }
    }

    // 3 · 眼色
    // design/character.md § 2 写的是 `raw.eyes = { both: { color }, ...raw.eyes }`，
    // 但 32 个表情里有 30 处声明了 `eyes.both`（`00` 的 `{ y: 4, lookY: 2 }` 之类），
    // 浅展开会把整个 `both` 覆盖掉、连眼色一起丢。这里按文档的**意图**做深合并：
    // 先铺眼色再铺表情自带的 `both` 字段。没有任何一个表情声明过眼色，两者不冲突；
    // `applySpec` 恒先应用 `both` 再应用 `left` / `right`，左右差异同样不受影响。
    // 眼色写在**最后**，不能写在展开之前：`raw` 是上一次补丁的产物，它的
    // `both.color` 是上一套配色的眼色，放前面会被展开原样盖回去，换形象就换不动眼睛。
    // 上游 32 个表情没有一个自己声明过眼色（`theme.test.ts` 有断言守着），
    // 所以先摘掉 `color` 再铺回来，不会丢任何上游数据。
    const eyes: Record<string, unknown> = isPlainObject(raw.eyes) ? { ...raw.eyes } : {};
    const prevBoth: Record<string, unknown> = isPlainObject(eyes.both) ? { ...eyes.both } : {};
    delete prevBoth.color;
    eyes.both = { ...prevBoth, color: palette.eye };
    raw.eyes = eyes;

    // 4 · 待机不再自己转圈甩彩带，见 IDLE_ANTICS_OFF
    if (IDLE_ANTICS_OFF.includes(id)) raw.antics = false;

    const res = eb.config.register(raw);
    if (!res || res.ok === false) {
      throw new Error(
        `[qiuqiu] 主题补丁注册失败：${id} —— ${res && res.errors ? res.errors.join('；') : '未知原因'}`
      );
    }
    count++;
  }

  patched.set(eb, look);
  return { look, patched: count, missing, ran: true };
}

/** 仅供测试：忘掉某个 EmotionBall 已打过补丁的记录。 */
export function resetThemeFlag(eb: EmotionBallGlobal): void {
  patched.delete(eb);
}

/** 某个 EmotionBall 当前打的是哪套配色；没打过是 `null`。 */
export function currentLook(eb: EmotionBallGlobal): CharacterLook | null {
  return patched.get(eb) ?? null;
}
