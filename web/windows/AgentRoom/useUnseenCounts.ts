// useUnseenCounts —— 右栏面板"有新产出"未读计数 hook
//
// v0.9：折叠面板看不见内容的问题
//   右栏所有面板默认折叠（见 AgentRoom.tsx 里的 defaultOpen=false 决策），所以当 agent
//   或其它人类用户新增议程/投票/问题/风险/任务时，本地用户完全无感。
//
// 本 hook 订阅 agentroom WS 子域事件，累计"自上次展开以来"的新增条数；
// 配合 CollapsibleSection 的 unseenCount/onOpenChange，展开时归零、折叠时继续累计。
//
// 只跟踪**真的会产生 WS 事件**的面板：
//   · agenda / questions / risks / votes：后端 broker.Emit('room.*.append') 明确存在
//   · outcome：闭会时 broker.Emit('room.closeout.done')
// 没跟踪：
//   · tasks    —— 后端只发 room.update + {tasksChanged:true}，需要额外 diff，延后做
//   · artifacts —— 后端目前没有 artifact.append WS 事件（仅 audit log）
//   · decisions —— 依赖 message.update 里 isDecision 从 false→true 的 diff，容易误报

import { useCallback, useEffect, useReducer } from 'react';
import { roomEvents } from './service';

export type UnseenKey = 'agenda' | 'questions' | 'risks' | 'votes' | 'outcome';

export type UnseenCounts = Record<UnseenKey, number>;

const EMPTY: UnseenCounts = { agenda: 0, questions: 0, risks: 0, votes: 0, outcome: 0 };

// 事件名 → UnseenKey 映射。集中维护便于对照后端 broker.Emit 调用点。
const EVENT_MAP: Array<{ event: string; key: UnseenKey }> = [
  { event: 'room.agenda.append',   key: 'agenda' },
  { event: 'room.question.append', key: 'questions' },
  { event: 'room.risk.append',     key: 'risks' },
  { event: 'room.vote.append',     key: 'votes' },
  { event: 'room.closeout.done',   key: 'outcome' },
];

type Action =
  | { type: 'inc'; key: UnseenKey }
  | { type: 'reset'; key: UnseenKey }
  | { type: 'reset-all' };

function reducer(state: UnseenCounts, action: Action): UnseenCounts {
  switch (action.type) {
    case 'inc':
      return { ...state, [action.key]: state[action.key] + 1 };
    case 'reset':
      if (state[action.key] === 0) return state;
      return { ...state, [action.key]: 0 };
    case 'reset-all':
      return EMPTY;
  }
}

/**
 * 为指定房间维护 unseen 计数。切换房间时（roomId 变化）自动归零。
 * 返回 {counts, markSeen, resetAll}：
 *   · counts[key]：当前未读数，可直接传给 CollapsibleSection.unseenCount
 *   · markSeen(key)：用户展开面板时调用，把该面板计数清零
 *   · resetAll()：切换房间外的极端情况（如关闭房间）用，通常不需要手动调
 */
export function useUnseenCounts(roomId: string | null | undefined) {
  const [counts, dispatch] = useReducer(reducer, EMPTY);

  useEffect(() => {
    // 切换房间：计数归零（不同房间语义不同，不能串）。
    dispatch({ type: 'reset-all' });
    if (!roomId) return;

    const offs = EVENT_MAP.map(({ event, key }) =>
      roomEvents.on(event as never, ((ev: { roomId?: string }) => {
        if (ev?.roomId !== roomId) return;
        dispatch({ type: 'inc', key });
      }) as never)
    );
    return () => { offs.forEach(o => o?.()); };
  }, [roomId]);

  const markSeen = useCallback((key: UnseenKey) => {
    dispatch({ type: 'reset', key });
  }, []);

  const resetAll = useCallback(() => {
    dispatch({ type: 'reset-all' });
  }, []);

  return { counts, markSeen, resetAll };
}
