// 右栏·房间资料（RAG Room Memory · 文档级）
// 支持 .md / .markdown / .txt 上传；列出已上传的文档，可删除。
// 删除会级联清理 chunks（后端事务 + FTS5 触发器）。
import React, { useEffect, useState } from 'react';
import { listRoomDocs, uploadRoomDoc, deleteRoomDoc, type RoomDoc } from '../service';
import { useConfirm } from '../../../components/ConfirmDialog';

interface Props {
  roomId: string;
}

function fmtSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

const DocsPanel: React.FC<Props> = ({ roomId }) => {
  const { confirm } = useConfirm();
  const [docs, setDocs] = useState<RoomDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await listRoomDocs(roomId);
      setDocs(r);
    } catch {
      // 错误 toast 已由 service 层处理
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [roomId]);

  const handleFile = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (!/(\.md|\.markdown|\.txt)$/.test(lower)) {
      alert('仅支持 .md / .markdown / .txt 文件');
      return;
    }
    if (file.size > 1024 * 1024) {
      alert('文件超过 1 MB 上限');
      return;
    }
    setUploading(true);
    try {
      await uploadRoomDoc(roomId, file);
      await refresh();
    } catch {
      // toast 已报错
    } finally {
      setUploading(false);
    }
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = ''; // 允许重复选同名
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const confirmDelete = async (doc: RoomDoc) => {
    const ok = await confirm({
      title: '删除文档',
      message: `确认删除「${doc.title}」？相关 chunks 也会一并删除。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    await deleteRoomDoc(roomId, doc.id);
    await refresh();
  };

  return (
    <div>
      <label
        className={`block mx-2 mb-2 rounded-lg border-2 border-dashed cursor-pointer transition-all ${dragOver ? 'border-cyan-400/80 bg-cyan-500/5' : 'border-border hover:border-cyan-400/40 hover:bg-surface-sunken'}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <input
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          onChange={onPick}
          className="hidden"
          disabled={uploading}
        />
        <div className="px-3 py-3 text-center">
          {uploading ? (
            <>
              <span className="material-symbols-outlined text-[18px] text-cyan-500 animate-spin-slow">sync</span>
              <div className="text-[11px] text-text-secondary mt-1">正在上传并切分...</div>
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-[18px] text-cyan-500">upload_file</span>
              <div className="text-[11px] text-text-secondary mt-1">拖拽或点击上传 <span className="font-mono">.md / .txt</span></div>
              <div className="text-[10px] text-text-muted mt-0.5">最大 1 MB · 自动切分为 ≤ 200 段</div>
            </>
          )}
        </div>
      </label>

      {loading && docs.length === 0 && (
        <div className="px-3 py-2 text-[11px] text-text-muted">加载中...</div>
      )}

      {!loading && docs.length === 0 && (
        <div className="px-3 py-2 text-center">
          <p className="text-[11px] text-text-muted">暂无资料</p>
          <p className="text-[10px] text-text-disabled mt-1 leading-relaxed">上传后房间里所有 Agent<br/>都会在回复时引用它们</p>
        </div>
      )}

      <ul className="divide-y divide-border">
        {docs.map(d => (
          <li key={d.id} className="group px-3 py-2 hover:bg-surface-sunken flex items-start gap-2">
            <span className="material-symbols-outlined text-[14px] text-text-muted mt-0.5">
              {d.mime === 'text/markdown' ? 'article' : 'description'}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-text font-medium truncate" title={d.title}>{d.title}</div>
              <div className="text-[10px] text-text-muted mt-0.5">
                {fmtSize(d.sizeBytes)} · {d.chunkCount} 段
              </div>
            </div>
            <button
              onClick={() => confirmDelete(d)}
              title="删除"
              className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-md hover:bg-red-500/10 hover:text-red-500 flex items-center justify-center text-text-muted transition-opacity"
            >
              <span className="material-symbols-outlined text-[14px]">delete</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default DocsPanel;
