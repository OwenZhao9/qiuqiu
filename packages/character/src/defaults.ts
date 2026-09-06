/**
 * 出厂默认：装完不改任何设置时，丘丘是什么样子。
 *
 * **为什么单独一个文件。** 这些值原来散在三处——皮肤在 `apps/web/src/skin.ts`
 * 的一个字符串字面量里，人格预设在 Python 那边是「压根没有」，表情的停留时长
 * 在 `state-machine.ts` 的常量里。想知道「这套系统默认长什么样」得读三个包。
 * 配置一个系统的人要找的是一张表，不是三处常量。
 *
 * 契约见 `docs/CONTRACTS.md` § 9，两边的测试都对着那一节读。
 *
 * **这里是「种子」不是「兜底」。** 空库第一次启动种进去，此后用户改过的以库为准。
 * 写成兜底（读不到就用这里的值）会让「用户主动清空」永远回不去——
 * 人格预设的真空态（AD-11）下次启动就自己变回可爱了。
 */

import { type EmotionId } from './types.js';

/** 出厂皮肤 id，与 `apps/web/src/skin.ts::SKINS` 里的 id 对应。 */
export type FactorySkin = 'default' | 'kawaii' | 'anime';

/** 出厂人格预设 id，与 `packages/memory/qiuqiu_memory/persona.py::PRESETS` 对应。 */
export type FactoryPreset = 'warm' | 'quiet' | 'cute' | 'sassy';

export interface FactoryDefaults {
  /** 页面配色与圆角。 */
  skin: FactorySkin;
  /** 人格预设。`null` 是真空（AD-11），出厂不用真空——新装的丘丘该有性格。 */
  personaPreset: FactoryPreset | null;
  emotion: {
    /** 记忆事件的表情停留多久。一闪而过的提示。 */
    eventHoldMs: number;
    /** 「这句回复的情绪」停留多久。比事件长——那是这句话本身的表情。 */
    replyHoldMs: number;
    /** 提交那一下点个头，停多久。 */
    submitHoldMs: number;
    /** 状态切换的最短停留，防抖用。 */
    minDwellMs: number;
    /**
     * 表情由谁决定。**永远是 `system`**，这个字段存在是为了让这条约束
     * 在代码里有个名字，而不是只写在文档里。
     *
     * `model` 这个取值不存在：模型既收不到当前表情（prompt 里没有这一项），
     * 也没有输出表情标记的口子（它写的括号旁白在 `stagecut.py` 就被滤掉了）。
     * 32 个表情的调度权整个在本地的规则表里，见 `emotion.ts::RULES` 与
     * `event-map.ts::EVENT_EMOTION_TABLE`。
     */
    decidedBy: 'system';
  };
}

/** 出厂默认可爱风：粉色皮肤 + `cute` 人格。 */
export const FACTORY: Readonly<FactoryDefaults> = Object.freeze({
  skin: 'kawaii',
  personaPreset: 'cute',
  emotion: Object.freeze({
    eventHoldMs: 1600,
    replyHoldMs: 2000,
    submitHoldMs: 600,
    minDwellMs: 500,
    decidedBy: 'system'
  })
}) as Readonly<FactoryDefaults>;

/**
 * 四态各自的出厂表情。真正的取值在 `state-machine.ts::STATE_EMOTION`——
 * 这里只是把它挂进出厂表，方便一处看全。契约 § 6 是它俩共同的来源。
 */
export const FACTORY_STATE_EMOTION: Readonly<Record<string, EmotionId>> = Object.freeze({
  idle: '02',
  listening: '35',
  thinking: '30',
  speaking: '39'
});
