// useOptimisticField —— 通用"下拉/输入 乐观更新"钩子。
//
// 场景：前端某个字段的值来自 server（props 或 WS 推送），用户在 UI 上改动后要调 HTTP 写回，
// 但 HTTP 往返较慢，纯受控渲染会导致"选中新值 → UI 不动 → 等几秒 → 才跳"。
//
// 设计原则：
//   1. 写入时立即本地乐观显示，同时禁用该字段，防止连点。
//   2. 父回调可返回 Promise：resolve 后若 server 尚未推新值，10s 超时自动回滚；
//      reject 则立即回滚并把错误交给调用方（通常由 withToast 在服务层统一 toast）。
//   3. 当外部传入的 actual 值和乐观值对齐（WS / refetch 推来真值），自动清理乐观值。
//   4. 多字段共用同一 hook 实例：用户可同时改 agent / model / thinking，互不影响。
//
// 使用样例：
//   const optimistic = useOptimisticField();
//   const value = optimistic.value(key, m.agentId);
//   const pending = optimistic.pending(key);
//   <CustomSelect value={value} disabled={pending}
//     onChange={v => optimistic.commit(key, v, () => updateMemberAgent(m.id, v))} />
//   useEffect(() => { optimistic.syncActual(key, m.agentId); }, [m.agentId]);
//
// 或者 key 生成器的便捷写法：`${memberId}:agent`。

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface UseOptimisticFieldApi {
  /** 当前应渲染的值：pending 时返回乐观值，否则返回传入的实际值。 */
  value(key: string, actual: string): string;
  /** 是否在 pending（UI 应禁用 + 显示 spinner）。 */
  pending(key: string): boolean;
  /**
   * 提交新值：立即设乐观值、禁用；执行 fire（HTTP 请求）；
   *   - fire 返回 Promise.reject → 立即回滚。
   *   - fire 成功 → 等待外部 actual 推来（通过 syncActual）。
   *   - 10s 仍未对齐 → 自动回滚。
   * 返回的 Promise 会 reject 同 fire 的错误，调用方可自选择 toast / 忽略。
   */
  commit(key: string, value: string, fire: () => Promise<unknown> | void): Promise<void>;
  /** 外部真值变更后通知；当 actual === 乐观值 时自动清理。 */
  syncActual(key: string, actual: string): void;
  /** 强制回滚指定 key 的乐观值（极少用，例如外部取消）。 */
  rollback(key: string): void;
}

export interface UseOptimisticFieldOptions {
  /** 单次乐观值的超时兜底（毫秒），默认 10s。 */
  timeoutMs?: number;
}

export function useOptimisticField(opts: UseOptimisticFieldOptions = {}): UseOptimisticFieldApi {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [optimistic, setOptimistic] = useState<Record<string, string>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // 组件卸载清理所有 timer
  useEffect(() => {
    const snapshot = timers.current;
    return () => {
      Object.values(snapshot).forEach(clearTimeout);
    };
  }, []);

  const clearTimer = useCallback((key: string) => {
    if (timers.current[key]) {
      clearTimeout(timers.current[key]);
      delete timers.current[key];
    }
  }, []);

  const removeKey = useCallback((key: string) => {
    clearTimer(key);
    setOptimistic(prev => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  }, [clearTimer]);

  const commit = useCallback(async (key: string, value: string, fire: () => Promise<unknown> | void): Promise<void> => {
    setOptimistic(prev => ({ ...prev, [key]: value }));
    clearTimer(key);
    // 超时兜底：如果 fire 成功但 server 一直没推真值，10s 后自动回滚 —— 提醒用户操作可能没生效。
    timers.current[key] = setTimeout(() => removeKey(key), timeout);
    try {
      const ret = fire();
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        await ret;
      }
    } catch (err) {
      // 立即回滚，把错误往上抛；服务层通常已 toast，这里不重复。
      removeKey(key);
      throw err;
    }
  }, [clearTimer, removeKey, timeout]);

  const value = useCallback((key: string, actual: string) => {
    return key in optimistic ? optimistic[key] : actual;
  }, [optimistic]);

  const pending = useCallback((key: string) => key in optimistic, [optimistic]);

  const syncActual = useCallback((key: string, actual: string) => {
    setOptimistic(prev => {
      if (!(key in prev)) return prev;
      if (prev[key] !== actual) return prev;
      // 真值追上了乐观值 —— 清理
      clearTimer(key);
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  }, [clearTimer]);

  const rollback = useCallback((key: string) => {
    removeKey(key);
  }, [removeKey]);

  return { value, pending, commit, syncActual, rollback };
}
