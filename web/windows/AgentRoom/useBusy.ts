// useBusy —— 异步按钮双击守护 hook。
//
// 典型场景：用户点击「启动房间 / 派生房间 / 删除房间 / 生成纪要」这类会触发
// 服务端写操作的按钮。如果请求耗时 >300ms，用户可能以为卡死而重复点击，
// 导致重复房间 / 重复 fork / 重复任务。
//
// 用法：
//   const { busy, run } = useBusy();
//   <button disabled={busy} onClick={() => run(async () => { await createRoom(...) })}>
//     {busy ? '创建中…' : '启动房间'}
//   </button>
//
// 多按钮共存时用 keyed 变体：
//   const { isBusy, runKeyed } = useBusyKeyed();
//   onClick={() => runKeyed('fork:' + msgId, () => forkRoom(...))}
//   disabled={isBusy('fork:' + msgId)}
import { useCallback, useRef, useState } from 'react';

export function useBusy() {
  const [busy, setBusy] = useState(false);
  // 用 ref 保证并发安全（两次点击间隔 < React 提交时间时 state 还没翻）。
  const lockRef = useRef(false);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (lockRef.current) return undefined;
    lockRef.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, run };
}

export function useBusyKeyed() {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const lockRef = useRef<Set<string>>(new Set());

  const isBusy = useCallback((key: string) => keys.has(key), [keys]);

  const runKeyed = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (lockRef.current.has(key)) return undefined;
    lockRef.current.add(key);
    setKeys(prev => { const n = new Set(prev); n.add(key); return n; });
    try {
      return await fn();
    } finally {
      lockRef.current.delete(key);
      setKeys(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  }, []);

  return { isBusy, runKeyed };
}
