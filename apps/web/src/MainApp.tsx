/**
 * 主窗口。三栏布局，`design/interaction.md` § 3。
 *
 * **AD-5：主窗口是唯一 SSE 持有者。** `/chat` 与 `/events` 都在这里建连，
 * 桌宠要的 delta、done、状态经 `window.qiuqiu` 转发过去。
 * 网页端没有 `window.qiuqiu`，`getBridge()` 自动退到内存事件总线，同一份代码。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  getSessionMessages,
  getThresholds,
  type MemoryEventEnvelope,
  type Thresholds
} from './api.js';
import { getBridge } from './bridge.js';
import { createSpeaker } from './speak.js';
import { ChatPanel } from './components/ChatPanel.js';
import { Composer } from './components/Composer.js';
import { MemoryLibrary } from './components/MemoryLibrary.js';
import { MemoryMap } from './components/MemoryMap.js';
import { MemorySidebar } from './components/MemorySidebar.js';
import { PersonaPage } from './components/PersonaPage.js';
import { QiuqiuBall } from './components/QiuqiuBall.js';
import { SettingsPage } from './components/SettingsPage.js';
import { stateLabel } from './format.js';
import { createChatStore } from './store/chat.js';
import { createEventsStore } from './store/events.js';
import { DEFAULT_THRESHOLDS } from './store/thresholds.js';
import type { QiuqiuInstance } from '@qiuqiu/character';

type Page = 'chat' | 'memories' | 'persona' | 'settings';

const NAV: Array<{ page: Page; label: string }> = [
  { page: 'chat', label: '对话' },
  { page: 'memories', label: '记忆库' },
  { page: 'persona', label: '人格' },
  { page: 'settings', label: '设置' }
];

/** T10：连接断开且 8 s 内未重连成功 → 回 `idle`。 */
const DISCONNECT_TO_IDLE_MS = 8000;

export interface MainAppProps {
  sessionId?: string;
  /** 网页端把丘丘嵌在左栏顶部，尺寸 160；桌面端主窗口用 120。 */
  ballPreset?: 'main' | 'web';
}

export function MainApp({ sessionId = 'default', ballPreset }: MainAppProps): React.JSX.Element {
  const bridge = useMemo(() => getBridge(), []);
  const speaker = useMemo(() => createSpeaker(), []);
  const qiuqiuRef = useRef<QiuqiuInstance | null>(null);
  const [page, setPage] = useState<Page>('chat');
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [leftOpen, setLeftOpen] = useState(false);
  /**
   * 被动采集开着没有。**默认关**——开摄像头必须是用户自己按的。
   * 存本地：这是本机的隐私选择，不该跟着账号或后端设置跑。
   */
  const [rightOpen, setRightOpen] = useState(false);
  /** 主页那条记忆结构展开没有。存本地，纯界面偏好。 */
  const [mapOpen, setMapOpen] = useState(() => {
    try {
      return localStorage.getItem('qiuqiu.mapOpen') !== '0';
    } catch {
      return true;
    }
  });
  const onMapToggle = useCallback((e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const open = e.currentTarget.open;
    setMapOpen(open);
    try {
      localStorage.setItem('qiuqiu.mapOpen', open ? '1' : '0');
    } catch {
      /* 存不下就只在本次生效 */
    }
  }, []);
  const [recallTexts, setRecallTexts] = useState<ReadonlyMap<string, string>>(new Map());

  const events = useMemo(
    () =>
      createEventsStore({
        onEvent(ev: MemoryEventEnvelope) {
          // 事件表情：映射表在 packages/character 里，这里只把事件递过去
          qiuqiuRef.current?.applyEvent(ev);
          if (ev.type !== 'recall') return;
          setRecallTexts((prev) => {
            const next = new Map(prev);
            for (const h of ev.payload.hits ?? []) if (h.text) next.set(h.id, h.text);
            return next;
          });
        }
      }),
    []
  );

  const chat = useMemo(
    () =>
      createChatStore(sessionId, {
        bridge,
        onCharacterState(state) {
          qiuqiuRef.current?.setState(state);
        },
        onSubmit(hasImages) {
          qiuqiuRef.current?.applySubmit(hasImages);
        },
        onStopped() {
          qiuqiuRef.current?.applyStop();
        },
        // 后端合成好的语音在这里放出来，顺便喂给丘丘驱动口型脉动
        onAudio(pcmB64, sampleRate) {
          speaker.push(pcmB64, sampleRate);
        },
        onSpeechEnd() {
          speaker.stop();
        },
        // `done` 只说明文字流完了，声音通常还要再响几秒。这两个钩子把
        // 「回 idle」推迟到真的没声音为止，不然丘丘还在说、窗口写着待机
        speechActive: () => speaker.speaking(),
        onReplyComplete(full, userText) {
          qiuqiuRef.current?.applyReply(full, userText);
        },
        // 边说边换表情。只跑推断那一半，拒绝式要等全文才判得准
        onReplyPartial(textSoFar) {
          qiuqiuRef.current?.applyReply(textSoFar);
        },
        onStreamError() {
          qiuqiuRef.current?.applyError();
        }
      }),
    [bridge, sessionId]
  );

  const chatState = useSyncExternalStore(chat.subscribe, chat.get, chat.get);
  const eventsState = useSyncExternalStore(events.subscribe, events.get, events.get);

  // 进程起来时把这个会话的历史铺回来。后端一直存着，界面不读的话重启就一片空白
  useEffect(() => {
    let alive = true;
    getSessionMessages(sessionId)
      .then((rows) => {
        if (alive) chat.hydrate(rows);
      })
      .catch(() => {
        /* 后端没起来时聊天区空着就好，别拿一个红框挡住整页 */
      });
    return () => {
      alive = false;
    };
  }, [sessionId, chat]);

  // 语音播完了通知 store 收尾（T7）。挂在这儿而不是 createChatStore 里：
  // speaker 与 chat 是两个独立对象，谁也不该持有对方
  useEffect(() => {
    speaker.onDrained(() => chat.noteSpeechDrained());
    return () => speaker.onDrained(null);
  }, [speaker, chat]);

  useEffect(() => {
    events.connect();
    getThresholds()
      .then(setThresholds)
      .catch(() => {
        /* 后端还没起来时用默认值，侧栏照常显示 */
      });
    return () => {
      events.destroy();
      chat.destroy();
    };
  }, [events, chat]);

  // 桌宠的输入交主窗口发出（AD-5）。**挂完监听立刻报到**：桌宠先说话时主窗口
  // 可能刚被建出来、渲染进程还没跑到这儿，主进程会把那句话攒着等这一声
  useEffect(() => {
    const off = [
      bridge.onSubmitFromPet((text: string) => chat.send(text)),
      // 用户在动桌宠。闲置计时在这只丘丘身上，不复位的话人玩着桌宠它却睡过去
      bridge.onPoke(() => qiuqiuRef.current?.resetIdle())
      // 托盘那个「暂停被动采集」原来翻的是一个没人读的标志位，这里把它接上
    ];
    bridge.mainReady();
    return () => {
      for (const f of off) f();
    };
  }, [bridge, chat]);

  // T10：断连超过 8 s 还没连上，回 idle
  useEffect(() => {
    if (eventsState.status === 'open' || eventsState.status === 'connecting') return;
    const t = setTimeout(() => {
      if (events.get().status !== 'open') chat.setCharacterState('idle');
    }, DISCONNECT_TO_IDLE_MS);
    return () => clearTimeout(t);
  }, [eventsState.status, events, chat]);

  // 两个抽屉不能同时打开，后开的关掉先开的
  const openLeft = useCallback(() => {
    setRightOpen(false);
    setLeftOpen((v) => !v);
  }, []);
  const openRight = useCallback(() => {
    setLeftOpen(false);
    setRightOpen((v) => !v);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setLeftOpen(false);
      setRightOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const preset = ballPreset ?? (bridge.platform() === 'web' ? 'web' : 'main');

  return (
    <div className="qq-shell">
      <nav className={'qq-left' + (leftOpen ? ' qq-left--open' : '')} aria-label="侧栏">
        <div className="qq-left__hero">
          <QiuqiuBall
            preset={preset}
            state={chatState.character}
            onReady={(q) => {
              qiuqiuRef.current = q;
              q.setState(chat.get().character);
              // 桌宠不自己推断表情（AD-5），所以主窗口这只丘丘每换一次表情就镜像
              // 过去一次。只发 `setPetState(state)` 的话桌宠永远只有四个状态表情，
              // 事件表情（写入 10、召回 31…）与情绪推断的结果全丢，两个窗口两张脸。
              q.onEmotion((id) => bridge.setPetState(q.getState(), id));
            }}
          />
          <div className="qq-left__state qq-collapsible">丘丘{stateLabel(chatState.character)}</div>
        </div>

        <div className="qq-sessions qq-collapsible">
          <div className="qq-sessions__label">会话</div>
          <button type="button" className="qq-nav__item" aria-current="page">
            当前会话
          </button>
        </div>

        <div className="qq-nav">
          {NAV.map((n) => (
            <button
              key={n.page}
              type="button"
              className="qq-nav__item qq-focusable"
              aria-current={page === n.page ? 'page' : undefined}
              onClick={() => {
                setPage(n.page);
                setLeftOpen(false);
              }}
            >
              <span className="qq-collapsible">{n.label}</span>
            </button>
          ))}
        </div>
      </nav>

      <main className="qq-main">
        <div className="qq-header">
          <button
            type="button"
            className="qq-btn qq-btn--ghost qq-focusable qq-drawer-toggle--left"
            aria-label="打开侧栏"
            onClick={openLeft}
          >
            ☰
          </button>
          <h1 className="qq-header__title">{NAV.find((n) => n.page === page)?.label}</h1>
          <span className="qq-header__state">{stateLabel(chatState.character)}</span>
          <span className="qq-spacer" />
          <button
            type="button"
            className="qq-btn qq-btn--ghost qq-focusable qq-drawer-toggle--right"
            aria-label="打开记忆过程"
            onClick={openRight}
          >
            记忆过程
          </button>
        </div>

        {page === 'chat' ? (
          <>
            {/* 记忆结构就在主页上方。折叠状态记在本地，不占后端的 settings */}
            <details className="qq-mapstrip" open={mapOpen} onToggle={onMapToggle}>
              <summary className="qq-mapstrip__head">
                记忆结构
                <span className="qq-mapstrip__hint">
                  {mapOpen ? '点这里收起' : '点这里看这句话在系统里怎么走'}
                </span>
              </summary>
              <MemoryMap events={eventsState.events} compact />
            </details>
            <ChatPanel messages={chatState.messages} recallTexts={recallTexts} />
            <Composer
              variant="main"
              history={chatState.outbox}
              streaming={chatState.busy}
              onStop={chat.stop}
              onSubmit={(text, attachments) => chat.send(text, attachments)}
              // 端到端语音的对话在后端进行，前端只把定稿的话记进来（不能走 send）
              onVoiceFinal={(role, text) => chat.addTranscript(role, text)}
              onVoiceLevel={(rms) => qiuqiuRef.current?.feedEnvelope(rms)}
              // 接通时先进「在听」，挂断回 idle；通话过程中的听 / 想 / 说走 onVoicePhase。
              // 只按接通与否切的话，整通电话丘丘都是「在听」那一个表情
              onVoiceActive={(active) => chat.setCharacterState(active ? 'listening' : 'idle')}
              onVoicePhase={(phase) => chat.setCharacterState(phase)}
            />
          </>
        ) : null}
        {page === 'memories' ? <MemoryLibrary /> : null}
        {page === 'persona' ? <PersonaPage /> : null}
        {page === 'settings' ? <SettingsPage /> : null}
      </main>

      <MemorySidebar
        store={events}
        thresholds={thresholds}
        onThresholdsChange={setThresholds}
        open={rightOpen}
      />

      {leftOpen || rightOpen ? (
        <button
          type="button"
          className="qq-scrim"
          aria-label="关闭抽屉"
          onClick={() => {
            setLeftOpen(false);
            setRightOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
