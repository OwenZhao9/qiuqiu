/**
 * 主窗口。三栏布局，`design/interaction.md` § 3。
 *
 * **AD-5：主窗口是唯一 SSE 持有者。** `/chat` 与 `/events` 都在这里建连，
 * 桌宠要的 delta、done、状态经 `window.qiuqiu` 转发过去。
 * 网页端没有 `window.qiuqiu`，`getBridge()` 自动退到内存事件总线，同一份代码。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getThresholds, type MemoryEventEnvelope, type Thresholds } from './api.js';
import { getBridge } from './bridge.js';
import { ChatPanel } from './components/ChatPanel.js';
import { Composer } from './components/Composer.js';
import { MemoryLibrary } from './components/MemoryLibrary.js';
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
  const qiuqiuRef = useRef<QiuqiuInstance | null>(null);
  const [page, setPage] = useState<Page>('chat');
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
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
        onReplyComplete(full, userText) {
          qiuqiuRef.current?.applyReply(full, userText);
        },
        onStreamError() {
          qiuqiuRef.current?.applyError();
        }
      }),
    [bridge, sessionId]
  );

  const chatState = useSyncExternalStore(chat.subscribe, chat.get, chat.get);
  const eventsState = useSyncExternalStore(events.subscribe, events.get, events.get);

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

  // 桌宠的输入交主窗口发出（AD-5）
  useEffect(() => {
    bridge.onSubmitFromPet((text: string) => chat.send(text));
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
            onReady={(q) => {
              qiuqiuRef.current = q;
              q.setState(chat.get().character);
            }}
          />
          <div className="qq-left__state qq-collapsible">丘丘{stateLabel(chatState.character)}</div>
        </div>

        <div className="qq-sessions qq-collapsible">
          <div className="qq-sessions__label">会话</div>
          <button type="button" className="qq-nav__item" aria-current="page">
            当前会话
          </button>
          <p className="qq-note">
            契约 § 1 还没有会话列表的路由，这里先只有一条。补上之后换成真的列表。
          </p>
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
          <span className="qq-muted" style={{ fontSize: 'var(--qq-text-sm)' }}>
            {stateLabel(chatState.character)}
          </span>
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
              onVoiceActive={(active) => chat.setCharacterState(active ? 'listening' : 'idle')}
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
