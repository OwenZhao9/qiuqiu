/** 侧栏与对话面板的格式化。字段名与格式全部按 `design/memory-panel.md` § 3。 */

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** `ts` → `HH:mm:ss`。解析不出来时原样回显，不显示 `Invalid Date`。 */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `valid_from` / `valid_to` → `YYYY-MM-DD`。 */
export function formatDay(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 只有 id 没有文本时显示 id 前 8 位加省略号。 */
export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8) + '…';
}

export function score2(v: number | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—';
}

const SOURCE_CN: Record<string, string> = {
  ambient_audio: '环境音',
  ambient_image: '摄像头'
};

export function sourceLabel(source: string | undefined): string {
  return source ? (SOURCE_CN[source] ?? source) : '';
}

const SPEAKER_CN: Record<string, string> = { user: '你', assistant: '丘丘' };

export function speakerLabel(speaker: string | undefined): string {
  return speaker ? (SPEAKER_CN[speaker] ?? speaker) : '';
}

const PATH_CN: Record<string, string> = {
  semantic: '按意思',
  lexical: '按字面',
  symbolic: '按标签'
};

export function pathLabel(path: string): string {
  return PATH_CN[path] ?? path;
}

const TYPE_CN: Record<string, string> = {
  filter: '筛选',
  write: '写入',
  merge: '合并',
  recall: '召回'
};

export function eventTypeLabel(type: string): string {
  return TYPE_CN[type] ?? type;
}

const STATE_CN: Record<string, string> = {
  idle: '待机',
  listening: '在听',
  thinking: '在想',
  speaking: '在说'
};

/** `< 720 px` 时中栏标题栏用一行文字表示状态（`design/interaction.md` § 3）。 */
export function stateLabel(state: string): string {
  return STATE_CN[state] ?? state;
}

export const LAYER_CN: Record<string, { title: string; hint: string }> = {
  L0: { title: '身份', hint: '几乎不变：名字、称呼、生日、职业' },
  L1: { title: '偏好', hint: '变得慢：喜欢什么、讨厌什么、习惯怎样' },
  L2: { title: '近况', hint: '变得快：最近发生的事、临时安排' }
};
