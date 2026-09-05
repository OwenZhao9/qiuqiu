/** 最小的可订阅存储，配 React 的 `useSyncExternalStore` 用。不引状态库。 */
export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(cb: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? (next as (prev: T) => T)(state) : (next as T);
      if (Object.is(value, state)) return;
      state = value;
      for (const cb of [...subs]) cb();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    }
  };
}
