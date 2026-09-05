/**
 * 记忆管线流程图。**「记忆过程看得见」这条第一质量属性，看的就是这张图。**
 *
 * 两条线共用中间的存储：说的话往下走筛选、压缩、合成、写入；问的话往上走检索规划、
 * 三路并行、召回。哪一段走到了哪一段亮，被丢掉的片段从管线上掉出去，回热的事实
 * 从冷存储那一侧流回来。
 *
 * 数据只来自事件（AD-14）。图上每一个字都能追到某条事件的某个字段——没有事件
 * 支撑的信息一律不画，宁可留空。
 */

import { useMemo } from 'react';
import type { MemoryEventEnvelope } from '../api.js';
import {
  derivePipeline,
  INGEST_STAGES,
  PATH_LABEL,
  RECALL_STAGES,
  STAGE_LABEL,
  type SearchPath,
  type StageId,
  type StageStatus
} from '../store/pipeline.js';

const W = 340;
const BOX_H = 44;
const GAP = 14;

/** 一段的竖直位置。写入线在上，召回线在下，中间是存储。 */
function yOf(index: number, base: number): number {
  return base + index * (BOX_H + GAP);
}

const STATUS_CLASS: Record<StageStatus, string> = {
  idle: 'qq-flow__box--idle',
  active: 'qq-flow__box--active',
  done: 'qq-flow__box--done',
  skip: 'qq-flow__box--skip'
};

function Box({
  id,
  y,
  label,
  detail,
  status
}: {
  id: StageId;
  y: number;
  label: string;
  detail: string;
  status: StageStatus;
}): React.JSX.Element {
  return (
    <g
      className={'qq-flow__box ' + STATUS_CLASS[status]}
      data-stage={id}
      data-status={status}
      role="listitem"
      aria-label={`${label}${detail ? '：' + detail : ''}`}
    >
      <rect x={16} y={y} width={W - 32} height={BOX_H} rx={10} />
      <text className="qq-flow__label" x={30} y={y + 19}>
        {label}
      </text>
      <text className="qq-flow__detail" x={30} y={y + 34}>
        {detail || (status === 'skip' ? '这轮跳过' : status === 'idle' ? '等着' : '')}
      </text>
    </g>
  );
}

function Arrow({ from, to }: { from: number; to: number }): React.JSX.Element {
  return (
    <path
      className="qq-flow__arrow"
      d={`M ${W / 2} ${from} L ${W / 2} ${to - 5}`}
      markerEnd="url(#qq-flow-tip)"
    />
  );
}

export interface MemoryFlowProps {
  events: readonly MemoryEventEnvelope[];
}

export function MemoryFlow({ events }: MemoryFlowProps): React.JSX.Element {
  const p = useMemo(() => derivePipeline(events), [events]);
  const lane = p.lane;
  const stageIds = lane === 'recall' ? RECALL_STAGES : INGEST_STAGES;
  const top = 74;
  const height = top + stageIds.length * (BOX_H + GAP) + 8;

  return (
    <div className="qq-flow">
      <div className="qq-flow__head">
        <span className="qq-flow__lane">
          {lane === 'recall' ? '想起来' : lane === 'ingest' ? '记下来' : '待机'}
        </span>
        {p.traceId ? <span className="qq-flow__trace">{p.traceId.slice(0, 10)}</span> : null}
      </div>

      {p.input ? (
        <p className="qq-flow__input" title={p.input}>
          {p.input}
        </p>
      ) : (
        <p className="qq-flow__empty">说点什么，这里会画出它走过的每一步</p>
      )}

      <svg
        className="qq-flow__svg"
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        role="list"
        aria-label="记忆管线"
      >
        <defs>
          <marker
            id="qq-flow-tip"
            viewBox="0 0 8 8"
            refX="4"
            refY="4"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" className="qq-flow__tip" />
          </marker>
        </defs>

        {stageIds.map((id, i) => {
          const y = yOf(i, top);
          const stage = p.stages[id];
          return (
            <g key={id}>
              {i > 0 ? <Arrow from={yOf(i - 1, top) + BOX_H} to={y} /> : null}
              <Box
                id={id}
                y={y}
                label={STAGE_LABEL[id]}
                detail={stage.detail}
                status={stage.status}
              />
            </g>
          );
        })}
      </svg>

      {lane === 'recall' && (p.paths.length > 0 || p.skipped.length > 0) ? (
        <div className="qq-flow__paths">
          {p.paths.map((path) => (
            <span key={path} className="qq-flow__path qq-flow__path--on">
              {PATH_LABEL[path] ?? path}
            </span>
          ))}
          {p.skipped.map((path: SearchPath) => (
            <span key={path} className="qq-flow__path qq-flow__path--off">
              {PATH_LABEL[path] ?? path}
            </span>
          ))}
        </div>
      ) : null}

      {p.facts.length > 0 ? (
        <ul className="qq-flow__facts" aria-label="从你说的话里记下的">
          {p.facts.map((f) => (
            <li key={f.id} className="qq-flow__fact">
              {f.text}
            </li>
          ))}
        </ul>
      ) : null}

      {p.replyFacts.length > 0 ? (
        <ul className="qq-flow__facts" aria-label="从丘丘的回复里记下的">
          {p.replyFacts.map((f) => (
            <li key={f.id} className="qq-flow__fact qq-flow__fact--reply">
              {f.text}
              <span className="qq-flow__path-tag">丘丘说的</span>
            </li>
          ))}
        </ul>
      ) : null}

      {p.hits.length > 0 ? (
        <ul className="qq-flow__facts">
          {p.hits.map((h) => (
            <li key={h.id} className="qq-flow__fact qq-flow__fact--hit">
              {h.text || h.id.slice(0, 8)}
              <span className="qq-flow__path-tag">
                {PATH_LABEL[h.path as SearchPath] ?? h.path}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {p.dropped.length > 0 ? (
        <ul className="qq-flow__dropped" aria-label="被丢掉的片段">
          {p.dropped.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      ) : null}

      {p.invalidated.length > 0 ? (
        <ul className="qq-flow__dropped" aria-label="被取代的旧事实">
          {p.invalidated.map((v) => (
            <li key={v.id}>{v.text || v.id.slice(0, 8)}</li>
          ))}
        </ul>
      ) : null}

      {p.reason && p.decision === 'reject' ? <p className="qq-flow__reason">{p.reason}</p> : null}
    </div>
  );
}
