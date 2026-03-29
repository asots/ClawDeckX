import React, { useState, useEffect, useCallback } from 'react';
import { mirrorConfigApi, MirrorConfig, SystemMirrorStatus, MirrorApplyResult } from '../../services/api';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';

interface MirrorSettingsProps {
  s: Record<string, any>;
  m: Record<string, any>; // mirror i18n keys
}

// ── Preset definitions ────────────────────────────────────────────────────────

const PRESET_CN: Omit<MirrorConfig, 'preset'> = {
  npmRegistry:  'https://registry.npmmirror.com',
  githubProxy:  'https://ghproxy.com',
  dockerMirror: 'https://mirror.ccs.tencentyun.com',
  pipIndex:     'https://pypi.tuna.tsinghua.edu.cn/simple',
  goProxy:      'https://goproxy.cn,direct',
};

const PRESET_GLOBAL: Omit<MirrorConfig, 'preset'> = {
  npmRegistry:  'https://registry.npmjs.org',
  githubProxy:  '',
  dockerMirror: '',
  pipIndex:     'https://pypi.org/simple',
  goProxy:      'https://proxy.golang.org,direct',
};

// ── Preset options per tool ───────────────────────────────────────────────────

const NPM_PRESETS = [
  { label: '官方', value: 'https://registry.npmjs.org' },
  { label: '淘宝 (npmmirror)', value: 'https://registry.npmmirror.com' },
  { label: '腾讯', value: 'https://mirrors.cloud.tencent.com/npm/' },
  { label: '华为', value: 'https://repo.huaweicloud.com/repository/npm/' },
];

const GITHUB_PRESETS = [
  { label: '关闭', value: '' },
  { label: 'ghproxy.com', value: 'https://ghproxy.com' },
  { label: 'kkgithub.com', value: 'https://kkgithub.com' },
  { label: 'mirror.ghproxy.com', value: 'https://mirror.ghproxy.com' },
];

const DOCKER_PRESETS = [
  { label: '关闭', value: '' },
  { label: '腾讯云', value: 'https://mirror.ccs.tencentyun.com' },
  { label: '阿里云 (需登录)', value: 'https://<your-id>.mirror.aliyuncs.com' },
  { label: '网易', value: 'https://hub-mirror.c.163.com' },
  { label: 'DaoCloud', value: 'https://f1361db2.m.daocloud.io' },
];

const PIP_PRESETS = [
  { label: '官方 PyPI', value: 'https://pypi.org/simple' },
  { label: '清华 TUNA', value: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { label: '阿里云', value: 'https://mirrors.aliyun.com/pypi/simple/' },
  { label: '中科大', value: 'https://pypi.mirrors.ustc.edu.cn/simple/' },
  { label: '华为云', value: 'https://repo.huaweicloud.com/repository/pypi/simple' },
];

const GO_PRESETS = [
  { label: '官方', value: 'https://proxy.golang.org,direct' },
  { label: 'GOPROXY.cn', value: 'https://goproxy.cn,direct' },
  { label: '七牛云', value: 'https://goproxy.io,direct' },
  { label: '阿里云', value: 'https://mirrors.aliyun.com/goproxy/,direct' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const defaultConfig = (): MirrorConfig => ({
  preset: 'custom',
  npmRegistry: '',
  githubProxy: '',
  dockerMirror: '',
  pipIndex: '',
  goProxy: '',
});

// ── Sub-components ────────────────────────────────────────────────────────────

interface ToolRowProps {
  icon: string;
  iconColor: string;
  label: string;
  description: string;
  value: string;
  presets: { label: string; value: string }[];
  systemValue?: string;
  applying?: boolean;
  applyResult?: MirrorApplyResult;
  onValueChange: (v: string) => void;
  onApply: () => void;
}

const ToolRow: React.FC<ToolRowProps> = ({
  icon, iconColor, label, description, value, presets, systemValue,
  applying, applyResult, onValueChange, onApply,
}) => {
  const [customMode, setCustomMode] = useState(false);
  const matchedPreset = presets.find(p => p.value === value);

  useEffect(() => {
    if (!matchedPreset && value) setCustomMode(true);
    else setCustomMode(false);
  }, [value, matchedPreset]);

  return (
    <div className="rounded-xl border border-slate-200 dark:border-white/8 bg-slate-50 dark:bg-white/3 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-white dark:bg-white/5">
        <span className={`material-symbols-outlined text-[18px] ${iconColor}`}>{icon}</span>
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-bold text-slate-700 dark:text-white/80">{label}</p>
          <p className="text-[10px] text-slate-400 dark:text-white/30 truncate">{description}</p>
        </div>
        {/* System detected badge */}
        {systemValue && (
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/8 max-w-[200px]">
            <span className="material-symbols-outlined text-[10px] text-slate-400 shrink-0">monitor</span>
            <span className="text-[9px] font-mono text-slate-400 dark:text-white/30 truncate" title={systemValue}>{systemValue}</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="px-4 py-3 space-y-2">
        {/* Preset chips */}
        <div className="flex flex-wrap gap-1.5">
          {presets.map(p => (
            <button
              key={p.value}
              onClick={() => { onValueChange(p.value); setCustomMode(false); }}
              className={`h-6 px-2.5 rounded-full text-[10px] font-bold transition-all border ${
                !customMode && value === p.value
                  ? 'bg-primary/10 text-primary border-primary/30'
                  : 'bg-white dark:bg-white/5 text-slate-500 dark:text-white/40 border-slate-200 dark:border-white/10 hover:border-primary/30 hover:text-primary'
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setCustomMode(true)}
            className={`h-6 px-2.5 rounded-full text-[10px] font-bold transition-all border ${
              customMode
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-400/30'
                : 'bg-white dark:bg-white/5 text-slate-500 dark:text-white/40 border-slate-200 dark:border-white/10 hover:border-amber-400/30 hover:text-amber-500'
            }`}
          >
            自定义
          </button>
        </div>

        {/* Custom input */}
        {customMode && (
          <input
            value={value}
            onChange={e => onValueChange(e.target.value)}
            placeholder="输入完整 URL..."
            className="w-full h-8 px-3 rounded-lg text-[11px] font-mono bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 outline-none focus:border-primary sci-input"
          />
        )}

        {/* Apply row */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onApply}
            disabled={applying || !value}
            className="h-7 px-3 rounded-lg text-[10px] font-bold bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 flex items-center gap-1.5 transition-colors"
          >
            {applying
              ? <><span className="material-symbols-outlined text-[12px] animate-spin">progress_activity</span>应用中...</>
              : <><span className="material-symbols-outlined text-[12px]">check_circle</span>应用到系统</>
            }
          </button>
          {applyResult && (
            <div className={`flex items-center gap-1 text-[10px] ${applyResult.ok ? 'text-green-600 dark:text-green-400' : 'text-mac-red'}`}>
              <span className="material-symbols-outlined text-[12px]">{applyResult.ok ? 'check_circle' : 'error'}</span>
              <span className="truncate max-w-[300px]" title={applyResult.message}>{applyResult.message}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Main Component ─────────────────────────────────────────────────────────────

const MirrorSettings: React.FC<MirrorSettingsProps> = ({ s, m }) => {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [cfg, setCfg] = useState<MirrorConfig>(defaultConfig());
  const [systemStatus, setSystemStatus] = useState<SystemMirrorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [applyingTool, setApplyingTool] = useState<string | null>(null);
  const [applyResults, setApplyResults] = useState<Record<string, MirrorApplyResult>>({});
  const [collapsed, setCollapsed] = useState(true);

  // Load saved config on mount
  useEffect(() => {
    mirrorConfigApi.get()
      .then(data => setCfg(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const detectSystem = useCallback(async () => {
    setDetecting(true);
    try {
      const status = await mirrorConfigApi.detect();
      setSystemStatus(status);
    } catch {
      toast('error', m.detectFailed || '检测失败');
    } finally {
      setDetecting(false);
    }
  }, [toast, m]);

  const applyPreset = useCallback(async (preset: 'cn' | 'global') => {
    const isCn = preset === 'cn';
    const ok = await confirm({
      title: isCn ? (m.presetCn || '国内加速') : (m.presetGlobal || '国际网络'),
      message: isCn
        ? (m.presetCnConfirm || '将所有镜像源切换为国内加速配置（淘宝 npm、ghproxy、goproxy.cn 等），是否继续？')
        : (m.presetGlobalConfirm || '将所有镜像源切换为官方国际源，在国内环境可能较慢，是否继续？'),
    });
    if (!ok) return;
    const values = isCn ? PRESET_CN : PRESET_GLOBAL;
    const next: MirrorConfig = { ...values, preset };
    setCfg(next);
    mirrorConfigApi.set(next).catch(() => {});
    toast('success', isCn
      ? (m.presetCnApplied || '已切换为国内加速配置')
      : (m.presetGlobalApplied || '已切换为国际网络配置')
    );
  }, [confirm, toast, m]);

  const updateField = useCallback(<K extends keyof MirrorConfig>(key: K, value: MirrorConfig[K]) => {
    setCfg(prev => ({ ...prev, [key]: value, preset: 'custom' }));
  }, []);

  const applyTool = useCallback(async (tool: string) => {
    setApplyingTool(tool);
    try {
      await mirrorConfigApi.set(cfg);
      const res = await mirrorConfigApi.apply([tool], cfg);
      const result = res.results?.[0];
      if (result) {
        setApplyResults(prev => ({ ...prev, [tool]: result }));
        toast(result.ok ? 'success' : 'error', result.message);
      }
    } catch (err: any) {
      toast('error', err?.message || m.applyFailed || '应用失败');
    } finally {
      setApplyingTool(null);
    }
  }, [cfg, toast, m]);

  const applyAll = useCallback(async () => {
    setApplyingTool('all');
    const tools = ['npm', 'go', 'pip', 'git', 'docker'].filter(t => {
      if (t === 'npm') return !!cfg.npmRegistry;
      if (t === 'go') return !!cfg.goProxy;
      if (t === 'pip') return !!cfg.pipIndex;
      if (t === 'git') return !!cfg.githubProxy;
      if (t === 'docker') return !!cfg.dockerMirror;
      return false;
    });
    try {
      await mirrorConfigApi.set(cfg);
      const res = await mirrorConfigApi.apply(tools, cfg);
      const newResults: Record<string, MirrorApplyResult> = {};
      const toolMap: Record<string, string> = { npm: 'npm', go: 'go', pip: 'pip', git: 'git', docker: 'docker' };
      for (const r of (res.results ?? [])) {
        newResults[toolMap[r.tool] ?? r.tool] = r;
      }
      setApplyResults(newResults);
      const allOk = res.results?.every(r => r.ok);
      toast(allOk ? 'success' : 'warning', allOk
        ? (m.applyAllOk || '所有配置已应用到系统')
        : (m.applyAllPartial || '部分配置应用成功，请查看详情')
      );
    } catch (err: any) {
      toast('error', err?.message || m.applyFailed || '应用失败');
    } finally {
      setApplyingTool(null);
    }
  }, [cfg, toast, m]);

  if (loading) return null;

  const rowCls = "rounded-2xl border border-slate-200 dark:border-white/8 bg-white dark:bg-white/3 overflow-hidden";

  return (
    <div className={rowCls}>
      {/* Section header */}
      <button
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-white/3 transition-colors"
        onClick={() => setCollapsed(v => !v)}
      >
        <span className="material-symbols-outlined text-[18px] text-cyan-500">language</span>
        <div className="flex-1 text-start">
          <p className="text-[13px] font-semibold text-slate-700 dark:text-white/80">
            {m.title || '镜像加速 & 网络环境'}
          </p>
          <p className="text-[11px] text-slate-400 dark:text-white/30">
            {m.desc || '配置 npm、GitHub、Docker、pip、Go 等工具的国内加速镜像'}
          </p>
        </div>
        <span className={`material-symbols-outlined text-[16px] text-slate-400 transition-transform duration-200 ${collapsed ? '' : 'rotate-180'}`}>
          expand_more
        </span>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 space-y-4">

          {/* ── Preset bar ── */}
          <div className="flex items-center gap-3 p-3 rounded-xl bg-gradient-to-r from-cyan-500/5 to-blue-500/5 border border-cyan-500/15">
            <span className="material-symbols-outlined text-[16px] text-cyan-500 shrink-0">bolt</span>
            <p className="text-[11px] text-slate-600 dark:text-white/50 flex-1">{m.presetHint || '一键切换网络环境预设'}</p>
            <div className="flex gap-2">
              <button
                onClick={() => applyPreset('cn')}
                className={`h-8 px-4 rounded-lg text-[11px] font-bold border transition-all flex items-center gap-1.5 ${
                  cfg.preset === 'cn'
                    ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-400/30'
                    : 'bg-white dark:bg-white/5 text-slate-600 dark:text-white/50 border-slate-200 dark:border-white/10 hover:border-red-400/30 hover:text-red-500'
                }`}
              >
                🇨🇳 {m.presetCn || '国内加速'}
              </button>
              <button
                onClick={() => applyPreset('global')}
                className={`h-8 px-4 rounded-lg text-[11px] font-bold border transition-all flex items-center gap-1.5 ${
                  cfg.preset === 'global'
                    ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-400/30'
                    : 'bg-white dark:bg-white/5 text-slate-600 dark:text-white/50 border-slate-200 dark:border-white/10 hover:border-blue-400/30 hover:text-blue-500'
                }`}
              >
                🌐 {m.presetGlobal || '国际网络'}
              </button>
            </div>
          </div>

          {/* ── System detection bar ── */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/3 border border-slate-200 dark:border-white/8">
            <span className="material-symbols-outlined text-[14px] text-slate-400">monitor</span>
            <span className="text-[11px] text-slate-500 dark:text-white/40 flex-1">{m.detectHint || '检测当前系统已配置的镜像源'}</span>
            <button
              onClick={detectSystem}
              disabled={detecting}
              className="h-7 px-3 rounded-lg text-[10px] font-bold bg-white dark:bg-white/8 border border-slate-200 dark:border-white/10 text-slate-600 dark:text-white/50 hover:border-primary/30 hover:text-primary disabled:opacity-40 flex items-center gap-1.5 transition-colors"
            >
              {detecting
                ? <><span className="material-symbols-outlined text-[12px] animate-spin">progress_activity</span>{m.detecting || '检测中...'}</>
                : <><span className="material-symbols-outlined text-[12px]">search</span>{m.detectBtn || '检测系统配置'}</>
              }
            </button>
          </div>

          {/* ── Tool rows ── */}
          <ToolRow
            icon="package_2"
            iconColor="text-red-500"
            label="npm Registry"
            description="Node.js 包管理器镜像源"
            value={cfg.npmRegistry}
            presets={NPM_PRESETS}
            systemValue={systemStatus?.npmRegistry}
            applying={applyingTool === 'npm'}
            applyResult={applyResults['npm']}
            onValueChange={v => updateField('npmRegistry', v)}
            onApply={() => applyTool('npm')}
          />

          <ToolRow
            icon="code"
            iconColor="text-slate-500"
            label="GitHub 代理"
            description="GitHub 文件下载加速前缀（ghproxy 等）"
            value={cfg.githubProxy}
            presets={GITHUB_PRESETS}
            systemValue={systemStatus?.githubProxy}
            applying={applyingTool === 'git'}
            applyResult={applyResults['git']}
            onValueChange={v => updateField('githubProxy', v)}
            onApply={() => applyTool('git')}
          />

          <ToolRow
            icon="deployed_code"
            iconColor="text-blue-500"
            label="Docker Registry Mirror"
            description="Docker Hub 镜像加速地址"
            value={cfg.dockerMirror}
            presets={DOCKER_PRESETS}
            systemValue={systemStatus?.dockerMirror}
            applying={applyingTool === 'docker'}
            applyResult={applyResults['docker']}
            onValueChange={v => updateField('dockerMirror', v)}
            onApply={() => applyTool('docker')}
          />

          <ToolRow
            icon="terminal"
            iconColor="text-yellow-500"
            label="pip 镜像源"
            description="Python 包管理器 index-url"
            value={cfg.pipIndex}
            presets={PIP_PRESETS}
            systemValue={systemStatus?.pipIndex}
            applying={applyingTool === 'pip'}
            applyResult={applyResults['pip']}
            onValueChange={v => updateField('pipIndex', v)}
            onApply={() => applyTool('pip')}
          />

          <ToolRow
            icon="conversion_path"
            iconColor="text-cyan-500"
            label="Go Module Proxy (GOPROXY)"
            description="Go 模块代理服务器"
            value={cfg.goProxy}
            presets={GO_PRESETS}
            systemValue={systemStatus?.goProxy}
            applying={applyingTool === 'go'}
            applyResult={applyResults['go']}
            onValueChange={v => updateField('goProxy', v)}
            onApply={() => applyTool('go')}
          />

          {/* ── Docker notice ── */}
          {cfg.dockerMirror && applyResults['docker']?.ok && (
            <div className="flex gap-2 items-start p-3 rounded-xl bg-amber-500/8 border border-amber-400/20">
              <span className="material-symbols-outlined text-[14px] text-amber-500 shrink-0 mt-0.5">info</span>
              <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-relaxed">
                {m.dockerRestartHint || 'Docker 镜像加速需要重启 Docker Daemon 后生效。请在终端执行 `sudo systemctl restart docker` 或从 Docker Desktop 重启。'}
              </p>
            </div>
          )}

          {/* ── Bottom action bar ── */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={applyAll}
              disabled={!!applyingTool}
              className="h-8 px-4 rounded-lg text-[11px] font-bold bg-primary text-white hover:bg-primary/90 disabled:opacity-40 flex items-center gap-1.5 transition-colors"
            >
              {applyingTool === 'all'
                ? <><span className="material-symbols-outlined text-[13px] animate-spin">progress_activity</span>{m.applyingAll || '应用中...'}</>
                : <><span className="material-symbols-outlined text-[13px]">rocket_launch</span>{m.applyAll || '一键应用全部到系统'}</>
              }
            </button>
            <div className="flex-1" />
            <p className="text-[10px] text-slate-400 dark:text-white/25">
              {m.scopeHint || '应用到系统 = 修改 ~/.npmrc · go env · ~/.pip/pip.conf · ~/.gitconfig · daemon.json'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default MirrorSettings;
