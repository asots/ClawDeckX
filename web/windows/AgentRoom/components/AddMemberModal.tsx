// 添加成员弹窗 —— 可从角色库选择或自定义角色信息
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { RoleProfile, GatewayAgentInfo } from '../types';
import type { SystemModel, AddMemberParams } from '../service';
import { listRoleProfiles } from '../service';
import CustomSelect from '../../../components/CustomSelect';

interface Props {
  open: boolean;
  onClose: () => void;
  onAdd: (params: AddMemberParams) => Promise<void>;
  systemModels?: SystemModel[];
  gatewayAgents?: GatewayAgentInfo[];
}

const AddMemberModal: React.FC<Props> = ({ open, onClose, onAdd, systemModels, gatewayAgents }) => {
  const [profiles, setProfiles] = useState<RoleProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [role, setRole] = useState('');
  const [emoji, setEmoji] = useState('');
  const [model, setModel] = useState('');
  const [agentId, setAgentId] = useState('');
  const [thinking, setThinking] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [stance, setStance] = useState('');
  const [isModerator, setIsModerator] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    listRoleProfiles().then(setProfiles).catch(() => setProfiles([]));
    // 重置表单
    setSelectedProfileId('');
    setRole('');
    setEmoji('');
    setModel('');
    setAgentId('');
    setThinking('');
    setSystemPrompt('');
    setStance('');
    setIsModerator(false);
  }, [open]);

  // 选择角色库条目时自动填充
  useEffect(() => {
    if (!selectedProfileId) return;
    const p = profiles.find(r => r.id === selectedProfileId);
    if (!p) return;
    setRole(p.role || p.name);
    setEmoji(p.emoji || '');
    setModel(p.model || '');
    setAgentId(p.agentId || '');
    setThinking(p.thinking || '');
    setSystemPrompt(p.systemPrompt || '');
    setStance(p.stance || '');
    setIsModerator(!!p.isModerator);
  }, [selectedProfileId, profiles]);

  const profileOptions = useMemo(() => [
    { value: '', label: '— 自定义 —' },
    ...profiles.map(p => ({ value: p.id, label: `${p.emoji || ''} ${p.role || p.name}`.trim() })),
  ], [profiles]);

  const modelOptions = useMemo(() => [
    { value: '', label: '继承 agent 默认' },
    ...((systemModels || []).map(m => ({ value: m.id, label: m.label || m.id }))),
  ], [systemModels]);

  const agentOptions = useMemo(() => [
    { value: '', label: '默认 agent' },
    ...((gatewayAgents || []).map(a => ({
      value: a.id,
      label: (a.name || a.id) + (a.model ? `  (${a.model})` : ''),
    }))),
  ], [gatewayAgents]);

  const thinkingOptions = [
    { value: '', label: '默认' },
    { value: 'off', label: '关闭' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
  ];

  const stanceOptions = [
    { value: '', label: '无立场' },
    { value: 'pro', label: '正方 (pro)' },
    { value: 'con', label: '反方 (con)' },
    { value: 'neutral', label: '中立 (neutral)' },
  ];

  const canSubmit = role.trim().length > 0 && !saving;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onAdd({
        role: role.trim(),
        emoji: emoji.trim() || undefined,
        model: model || undefined,
        agentId: agentId || undefined,
        thinking: thinking || undefined,
        systemPrompt: systemPrompt.trim() || undefined,
        isModerator: isModerator || undefined,
        stance: stance || undefined,
        roleProfileId: selectedProfileId || undefined,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }, [canSubmit, role, emoji, model, agentId, thinking, systemPrompt, isModerator, stance, selectedProfileId, onAdd, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[420px] max-h-[80vh] rounded-xl bg-surface-raised border border-border shadow-xl overflow-hidden animate-card-enter"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-cyan-500">person_add</span>
            <span className="text-sm font-bold text-text">添加成员</span>
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded-md hover:bg-surface-sunken text-text-muted hover:text-text flex items-center justify-center"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3 overflow-y-auto max-h-[60vh] neon-scrollbar">
          {/* 角色库选择 */}
          {profiles.length > 0 && (
            <Field label="从角色库选择">
              <CustomSelect
                value={selectedProfileId}
                onChange={setSelectedProfileId}
                options={profileOptions}
                placeholder="— 自定义 —"
                className="h-7 text-[12px]"
              />
            </Field>
          )}

          {/* 角色名 */}
          <Field label="角色名 *">
            <input
              value={role}
              onChange={e => setRole(e.target.value)}
              placeholder="例如：产品经理、代码审查专家"
              className="w-full h-7 px-2 rounded-lg bg-surface border border-border sci-input text-[12px]"
              maxLength={80}
              disabled={saving}
            />
          </Field>

          {/* Emoji */}
          <Field label="头像 Emoji">
            <input
              value={emoji}
              onChange={e => setEmoji(e.target.value)}
              placeholder="🤖"
              className="w-20 h-7 px-2 rounded-lg bg-surface border border-border sci-input text-[12px] text-center"
              maxLength={4}
              disabled={saving}
            />
          </Field>

          {/* Agent */}
          <Field label="Agent">
            <CustomSelect
              value={agentId}
              onChange={setAgentId}
              options={agentOptions}
              placeholder="默认 agent"
              className="h-7 text-[12px]"
              disabled={saving}
            />
          </Field>

          {/* 模型 */}
          <Field label="模型">
            <CustomSelect
              value={model}
              onChange={setModel}
              options={modelOptions}
              placeholder="继承 agent 默认"
              className="h-7 text-[12px]"
              disabled={saving}
            />
          </Field>

          {/* Thinking */}
          <Field label="Thinking">
            <CustomSelect
              value={thinking}
              onChange={setThinking}
              options={thinkingOptions}
              placeholder="默认"
              className="h-7 text-[12px]"
              disabled={saving}
            />
          </Field>

          {/* 立场 */}
          <Field label="立场">
            <CustomSelect
              value={stance}
              onChange={setStance}
              options={stanceOptions}
              placeholder="无立场"
              className="h-7 text-[12px]"
              disabled={saving}
            />
          </Field>

          {/* 系统提示词 */}
          <Field label="系统提示词">
            <textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value.slice(0, 2000))}
              rows={3}
              placeholder="留空则使用默认提示词"
              className="w-full px-2 py-1.5 rounded-lg bg-surface border border-border sci-input text-[12px] resize-none"
              disabled={saving}
            />
          </Field>

          {/* 主持人 */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isModerator}
              onChange={e => setIsModerator(e.target.checked)}
              disabled={saving}
              className="accent-cyan-500"
            />
            <span className="text-[12px] text-text-secondary">主持人角色</span>
          </label>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 h-7 rounded-lg text-[12px] font-semibold bg-surface hover:bg-surface-sunken border border-border text-text-secondary disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 h-7 rounded-lg text-[12px] font-semibold bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30 disabled:opacity-40 disabled:pointer-events-none inline-flex items-center gap-1.5"
          >
            {saving && <span className="w-3 h-3 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />}
            添加
          </button>
        </div>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="space-y-1">
    <label className="text-[11px] font-semibold text-text-muted">{label}</label>
    {children}
  </div>
);

export default AddMemberModal;
