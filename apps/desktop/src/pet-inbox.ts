/**
 * 桌宠发出的话在主窗口就绪之前先攒着。
 *
 * `ensureMain()` 只是把主窗口建出来，渲染进程要过几百毫秒才跑到挂监听那一步。
 * 在那之前 `webContents.send` 是**丢掉**的，不报错也不排队——桌宠里打的第一句
 * 话就是这么没的：窗口是开了，话没了，两边都看不出发生过什么。
 *
 * 纯函数模块，不 import electron，主进程与 vitest 都能用。
 */

export interface PetInbox {
  /** 渲染进程报到之前调，返回 true 表示已经攒下了、调用方不要再发。 */
  hold(text: string): boolean;
  /** 渲染进程报到。返回攒着的话，按进来的顺序，并清空。 */
  ready(): string[];
  /** 渲染进程重新加载（含开发时热重载）时调，重新回到未就绪。 */
  reset(): void;
  /** 现在就绪了没有。 */
  isReady(): boolean;
  /** 还攒着几条。 */
  size(): number;
}

/**
 * @param limit 最多攒多少条。攒满了丢最旧的——桌宠连着打十几句而主窗口一直起不来
 *              是不正常状态，与其无限攒着不如保住最近的几句。
 */
export function createPetInbox(limit = 20): PetInbox {
  let ready = false;
  const queue: string[] = [];

  return {
    hold(text) {
      if (ready) return false;
      queue.push(text);
      if (queue.length > limit) queue.splice(0, queue.length - limit);
      return true;
    },
    ready() {
      ready = true;
      return queue.splice(0, queue.length);
    },
    reset() {
      ready = false;
    },
    isReady: () => ready,
    size: () => queue.length
  };
}
