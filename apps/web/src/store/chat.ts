/**
 * 对话编排 + 角色状态机的本地驱动。
 *
 * **AD-1：四态由前端本地切换，不等后端。** 迁移表逐条对着
 * `design/state-machine.md` § 2 实现：
 *
 *   T1  idle      → thinking  用户提交文本
 *   T5  thinking  → speaking  本轮首个 `delta`（`text` 长度 > 0）
 *   T6  thinking  → idle      `error`；`done` 先于任何 `delta`；用户点停止
 *   T7  speaking  → idle      `done` **且这一轮的语音已经播完**；`error`；用户点停止
 *   T8  speaking  → thinking  回复途中再次提交，先中止当前流
 *
 * **AD-5：主窗口是唯一 SSE 持有者。** 每个 `delta` 与 `done` 立刻经
 * `forwardReply` / `forwardDone` 转发给桌宠窗口；桌宠自己不连任何流。
 * 转发的是**这一轮到此为止的全文**，不是增量：桌宠只负责显示，不自己拼字，
 * 拼字就等于第二套消息处理，漏一条两个窗口就不一样了。
 *
 * T2 / T3 / T4 / T9 属于语音链路（`voice.ts` 的端到端实时通话）；
 * T10 断连由 `useEventStream` 那边触发。
 */

import type { StoredMessage } from '../api.js';
import {
  postChat,
  type Attachment,
  type ChatDone,
  type ChatMeta,
  type ChatStream,
  type ErrorPayload
} from '../api.js';
import type { QiuqiuBridgeExt } from '../bridge.js';
import { createStore, type Store } from './store.js';
import type { CharacterState } from '@qiuqiu/character';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 还在流式输出。 */
  streaming: boolean;
  /** `meta.recall_ids`，回复下方「参考了 N 条记忆」点开就看它。 */
  recallIds: string[];
  memoryUsed: boolean;
  model: string | null;
  attachments: Attachment[];
  error: ErrorPayload | null;
  at: number;
}

export interface ChatState {
  sessionId: string;
  messages: ChatMessage[];
  /** 四态之一，本地推断。 */
  character: CharacterState;
  /** 本轮是否还在跑（`thinking` 或 `speaking`）。 */
  busy: boolean;
  /** 用户发过的话，`↑` 往前翻用。最新在末尾。 */
  outbox: string[];
  lastError: ErrorPayload | null;
}

export interface ChatStoreDeps {
  bridge: QiuqiuBridgeExt;
  /** 角色状态变化的落点：主窗口里的丘丘实例。 */
  onCharacterState?(state: CharacterState): void;
  /** 一轮回复结束后跑拒绝式与情绪推断（`packages/character` 的 `applyReply`）。 */
  onReplyComplete?(fullText: string, userText: string): void;
  /**
   * 回复还在流的过程中，隔一段给一次到此为止的全文。
   *
   * 情绪推断原来只在 `done` 之后跑一次：整段回复期间丘丘都是「说话中」那一个
   * 表情，末尾才闪 1.6 秒真正的情绪。问它「你喜欢我吗」，害羞那个表情基本看不到。
   */
  onReplyPartial?(textSoFar: string): void;
  /** SSE / WS 出错 → 表情 `34`。 */
  onStreamError?(err: ErrorPayload): void;
  /** 用户按下发送。带图片时表情不一样（好奇，而不是点头收到）。 */
  onSubmit?(hasImages: boolean): void;
  /** 用户点停止中止本轮。 */
  onStopped?(): void;
  /**
   * 收到一帧 TTS 音频。
   *
   * 原来这里是空的，收到就丢弃——后端每轮都在合成，钱照花，声音一次没响过。
   */
  onAudio?(pcmB64: string, sampleRate: number): void;
  /** 本轮结束或被打断：该闭嘴了。 */
  onSpeechEnd?(): void;
  /**
   * 这一轮的语音还在响吗。
   *
   * `done` 是**文字**流结束，不是丘丘闭嘴：TTS 帧跟在文字后面走，
   * 最后几秒还在播的时候 `done` 早就到了。原来 `done` 当场回 idle，
   * 于是丘丘还在出声、窗口上已经写着「丘丘待机」。
   * 不传这个依赖时行为不变（`done` 直接回 idle），测试与网页端照旧。
   */
  speechActive?(): boolean;
  /** 注入 `postChat`，测试与 mock 用。 */
  chat?: typeof postChat;
  now?(): number;
  newId?(): string;
}

export interface ChatStore extends Store<ChatState> {
  send(text: string, attachments?: Attachment[]): void;
  /** 语音播完了。宿主在 `Speaker` 排空时调，补上被 `done` 抢先的那次 T7。 */
  noteSpeechDrained(): void;
  /** 用户点「停止」：中止本轮，T6 / T7 回 `idle`。 */
  stop(): void;
  /** 只切状态（语音链路的 T2 / T4 用）。 */
  setCharacterState(next: CharacterState): void;
  /**
   * 把这个会话的历史消息铺进来（进程起来时调一次）。
   *
   * 后端一直把消息存在 SQLite 里，下一轮也会把历史喂给模型——所以丘丘记得。
   * 但界面从不去读，重启之后聊天区一片空白：你问「刚才我说啥」它答得出来，
   * 屏幕上却什么都没有，两边对不上。
   *
   * 已经聊上了就不铺（`messages` 非空时直接返回），免得把当前这一轮冲掉。
   */
  hydrate(rows: readonly StoredMessage[]): void;
  /**
   * 把一句已经定稿的话记进对话记录，**不发请求**。
   *
   * 端到端语音的对话在后端与模型之间进行，前端只负责显示——不能走 `send()`，
   * 那会再往 `/chat` 发一遍，等于同一句话说两次。
   */
  addTranscript(role: 'user' | 'assistant', text: string): void;
  destroy(): void;
}

let seq = 0;
function defaultId(): string {
  seq += 1;
  return 'm' + Date.now().toString(36) + '_' + seq;
}

export function createChatStore(sessionId: string, deps: ChatStoreDeps): ChatStore {
  const chat = deps.chat ?? postChat;
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? defaultId;

  const store = createStore<ChatState>({
    sessionId,
    messages: [],
    character: 'idle',
    busy: false,
    outbox: [],
    lastError: null
  });

  let stream: ChatStream | null = null;
  /** 本轮 assistant 消息的 id，deltas 往它上面拼。 */
  let replyId: string | null = null;
  let sawDelta = false;
  let userText = '';

  /* ---- 转发给桌宠：按帧合并，推全文 ----
     一个字一条 IPC 的话，桌宠那边每个字都要量一次气泡高度、主进程每个字都可能
     resize 一次窗口——透明置顶窗口 resize 很贵，回复就会一个字一个字地爬。
     合并到一帧一条之后，字数再多也只是同一条消息变长。 */
  let replyRaf = 0;
  let replySent = '';

  /** 上次跑情绪推断的时刻。推断本身很便宜，但表情切太勤会闪。 */
  let inferredAt = 0;
  const INFER_EVERY_MS = 600;

  function sendReply(): void {
    replyRaf = 0;
    // 括号里的动作描写后端就滤掉了（`stagecut.py`），这里拿到的已经是干净的
    const text = store.get().messages.find((m) => m.id === replyId)?.content ?? '';
    if (text === replySent) return;
    replySent = text;
    deps.bridge.forwardReply(store.get().sessionId, text);
  }

  /** @param now 立刻发，不等下一帧。收尾时用，否则桌宠停在倒数第二帧。 */
  function pushReply(now = false): void {
    if (now) {
      if (replyRaf) {
        cancelAnimationFrame(replyRaf);
        replyRaf = 0;
      }
      sendReply();
      return;
    }
    if (replyRaf) return;
    replyRaf = requestAnimationFrame(sendReply);
  }

  function toState(next: CharacterState): void {
    if (store.get().character === next) return;
    store.set((s) => ({ ...s, character: next }));
    // AD-5：桌宠的表情来自主窗口的 setPetState，桌宠自己不推断
    deps.bridge.setPetState(next);
    deps.onCharacterState?.(next);
  }

  function patchReply(fn: (m: ChatMessage) => ChatMessage): void {
    const id = replyId;
    if (!id) return;
    store.set((s) => ({
      ...s,
      messages: s.messages.map((m) => (m.id === id ? fn(m) : m))
    }));
  }

  /** `done` 到了但语音还没播完，正等着 T7。 */
  let awaitingSpeech = false;

  function endTurn(): void {
    stream = null;
    replyId = null;
    sawDelta = false;
    store.set((s) => ({ ...s, busy: false }));
    // 声音还在响就先不回 idle——那一下会把「丘丘在说」写成「丘丘待机」，
    // 而人耳听见的还是它在说。等 `noteSpeechDrained()` 来收尾
    if (deps.speechActive?.()) {
      awaitingSpeech = true;
      return;
    }
    awaitingSpeech = false;
    toState('idle');
  }

  function send(text: string, attachments: Attachment[] = []): void {
    const content = text.trim();
    if (content === '') return; // 空内容不发，也不报错（design/interaction.md § 2）

    // T8：回复途中再次提交，先中止当前流。上一轮的声音也一起掐掉
    deps.onSpeechEnd?.();
    awaitingSpeech = false;
    if (stream) {
      stream.abort();
      patchReply((m) => ({ ...m, streaming: false }));
      stream = null;
    }

    // 提交先点个头「收到了」，再进思考。跳过这一下的话，从待机直接变思考，
    // 用户按完发送那一刻没有任何回应
    deps.onSubmit?.(attachments.length > 0);

    const userMsg: ChatMessage = {
      id: newId(),
      role: 'user',
      content,
      streaming: false,
      recallIds: [],
      memoryUsed: false,
      model: null,
      attachments,
      error: null,
      at: now()
    };
    const assistantMsg: ChatMessage = {
      id: newId(),
      role: 'assistant',
      content: '',
      streaming: true,
      recallIds: [],
      memoryUsed: false,
      model: null,
      attachments: [],
      error: null,
      at: now()
    };
    replyId = assistantMsg.id;
    sawDelta = false;
    replySent = '';
    inferredAt = 0;
    userText = content;

    store.set((s) => ({
      ...s,
      messages: [...s.messages, userMsg, assistantMsg],
      outbox: [...s.outbox, content],
      busy: true,
      lastError: null
    }));

    // T1 / T8：本地立刻进 thinking，不等后端第一个字节
    toState('thinking');

    const handle = chat(
      { session_id: store.get().sessionId, content, attachments },
      {
        onMeta(meta: ChatMeta) {
          patchReply((m) => ({
            ...m,
            model: meta.model,
            memoryUsed: Boolean(meta.memory_used),
            recallIds: Array.isArray(meta.recall_ids) ? meta.recall_ids : []
          }));
        },
        onDelta(delta) {
          if (delta.text.length === 0) return;
          if (!sawDelta) {
            sawDelta = true;
            toState('speaking'); // T5
          }
          patchReply((m) => ({ ...m, content: m.content + delta.text }));
          pushReply();

          // 边说边推断情绪，别等说完。节流到 600 ms 一次：推断很便宜，
          // 但表情一句一换会闪
          const now = Date.now();
          if (now - inferredAt >= INFER_EVERY_MS) {
            inferredAt = now;
            const soFar = store.get().messages.find((m) => m.id === replyId)?.content ?? '';
            if (soFar) deps.onReplyPartial?.(soFar);
          }
        },
        onDone(_done: ChatDone) {
          const full = store.get().messages.find((m) => m.id === replyId)?.content ?? '';
          patchReply((m) => ({ ...m, streaming: false }));
          pushReply(true); // 收尾这一帧一定要发出去，不然桌宠停在倒数第二帧
          deps.bridge.forwardDone(store.get().sessionId);
          if (full.length > 0) deps.onReplyComplete?.(full, userText);
          endTurn(); // T6（done 先于 delta）或 T7
        },
        onAudio(a) {
          deps.onAudio?.(a.pcm_b64, Number(a.sample_rate) || 16000);
        },
        onError(err) {
          patchReply((m) => ({ ...m, streaming: false, error: err }));
          store.set((s) => ({ ...s, lastError: err }));
          deps.onStreamError?.(err);
          pushReply(true);
          deps.bridge.forwardDone(store.get().sessionId);
          endTurn(); // T6 / T7
        }
      }
    );
    stream = handle;

    handle.finished.catch((err: unknown) => {
      if (stream !== handle) return;
      const bag = err as { code?: unknown; message?: unknown; hint?: unknown } | null;
      const payload: ErrorPayload =
        bag && typeof bag === 'object' && typeof bag.code === 'string'
          ? {
              code: bag.code,
              message: String(bag.message ?? '请求失败'),
              hint: String(bag.hint ?? '检查后端是否还活着，再重发这句话')
            }
          : { code: 'chat_failed', message: String(err), hint: '检查后端是否还活着，再重发这句话' };
      patchReply((m) => ({ ...m, streaming: false, error: payload }));
      store.set((s) => ({ ...s, lastError: payload }));
      deps.onStreamError?.(payload);
      endTurn();
    });
  }

  return {
    ...store,
    send,
    noteSpeechDrained() {
      if (!awaitingSpeech) return;
      awaitingSpeech = false;
      toState('idle');
    },
    stop() {
      if (!stream) return;
      stream.abort();
      patchReply((m) => ({ ...m, streaming: false }));
      deps.onStopped?.();
      deps.onSpeechEnd?.();
      endTurn();
    },
    setCharacterState: toState,
    hydrate(rows) {
      if (rows.length === 0 || store.get().messages.length > 0) return;
      store.set((st) => ({
        ...st,
        messages: rows.map((r) => ({
          id: r.id,
          role: r.role,
          content: r.content,
          streaming: false,
          recallIds: [],
          memoryUsed: false,
          model: r.model,
          attachments: (r.attachments ?? []).map((blob_id) => ({
            type: 'image' as const,
            blob_id
          })),
          error: null,
          at: Date.parse(r.created_at) || now()
        }))
      }));
    },
    addTranscript(role, text) {
      const content = text.trim();
      if (content === '') return;
      store.set((st) => ({
        ...st,
        messages: [
          ...st.messages,
          {
            id: newId(),
            role,
            content,
            streaming: false,
            recallIds: [],
            memoryUsed: false,
            model: null,
            attachments: [],
            error: null,
            at: now()
          }
        ],
        // 用户说的话进历史，上下键能翻到
        outbox: role === 'user' ? [...st.outbox, content] : st.outbox
      }));
    },
    destroy() {
      stream?.abort();
      stream = null;
    }
  };
}
