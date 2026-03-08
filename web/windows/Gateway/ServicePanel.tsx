import React, { useState, useEffect, useCallback, useRef } from 'react';
import { gatewayApi, gwApi } from '../../services/api';
import { subscribeManagerWS } from '../../services/manager-ws';

interface DaemonState {
  platform: string;
  installed: boolean;
  enabled: boolean;
  active: boolean;
  unitFile: string;
  detail: string;
}

interface WsStatus {
  connected: boolean;
  host: string;
  port: number;
  reconnect_count: number;
  backoff_ms: number;
  last_error: string;
  health_enabled: boolean;
  fail_count: number;
  max_fails: number;
  interval_sec: number;
  last_ok: string;
  grace_until: string;
}

interface ServicePanelProps {
  status: any;
  healthCheckEnabled: boolean;
  healthStatus: { fail_count: number; last_ok: string } | null;
  gw: Record<string, any>;
  onCopy: (text: string) => void;
  toast: (type: 'success' | 'error', msg: string) => void;
  remote: boolean;
}

const PLATFORM_LABELS: Record<string, string> = {
  systemd: 'Linux (systemd)',
  launchd: 'macOS (launchd)',
  windows: 'Windows (sc)',
  unsupported: 'Unsupported',
};

const PLATFORM_ICONS: Record<string, string> = {
  systemd: 'deployed_code',
  launchd: 'laptop_mac',
  windows: 'desktop_windows',
  unsupported: 'block',
};

interface LifecycleRecord {
  id: number;
  timestamp: string;
  event_type: string;
  gateway_host: string;
  gateway_port: number;
  profile_name: string;
  is_remote: boolean;
  reason: string;
  error_detail: string;
  uptime_sec: number;
}

const LIFECYCLE_ICON: Record<string, string> = {
  started: 'play_circle',
  recovered: 'restart_alt',
  shutdown: 'stop_circle',
  crashed: 'error',
  unreachable: 'cloud_off',
};

const LIFECYCLE_COLOR: Record<string, string> = {
  started: 'text-mac-green',
  recovered: 'text-mac-green',
  shutdown: 'text-slate-400 dark:text-white/40',
  crashed: 'text-mac-red',
  unreachable: 'text-mac-yellow',
};

const LIFECYCLE_BG: Record<string, string> = {
  started: 'bg-mac-green/10 border-mac-green/20',
  recovered: 'bg-mac-green/10 border-mac-green/20',
  shutdown: 'bg-white/[0.04] border-white/[0.06]',
  crashed: 'bg-mac-red/5 border-mac-red/20',
  unreachable: 'bg-mac-yellow/5 border-mac-yellow/20',
};

function fmtLifecycleUptime(sec: number): string {
  if (sec <= 0) return '';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

const ServicePanel: React.FC<ServicePanelProps> = ({ status, healthCheckEnabled, healthStatus, gw, onCopy, toast, remote }) => {
  const [daemon, setDaemon] = useState<DaemonState | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<'install' | 'uninstall' | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [lifecycleRecords, setLifecycleRecords] = useState<LifecycleRecord[]>([]);
  const [lifecycleExpanded, setLifecycleExpanded] = useState(false);
  const lifecycleLoadedRef = useRef(false);

  const fetchDaemonStatus = useCallback(() => {
    setLoading(true);
    gatewayApi.daemonStatus()
      .then((data: any) => setDaemon(data))
      .catch(() => setDaemon(null))
      .finally(() => setLoading(false));
  }, []);

  const fetchWsStatus = useCallback(() => {
    gwApi.status().then((data: any) => setWsStatus(data)).catch(() => {});
  }, []);

  const fetchLifecycle = useCallback((limit = 20) => {
    gatewayApi.lifecycle({ page_size: limit }).then((data: any) => {
      if (data?.records) setLifecycleRecords(data.records);
      lifecycleLoadedRef.current = true;
    }).catch(() => {});
  }, []);

  useEffect(() => { fetchDaemonStatus(); fetchWsStatus(); fetchLifecycle(); }, [fetchDaemonStatus, fetchWsStatus, fetchLifecycle]);

  useEffect(() => {
    const timer = setInterval(fetchWsStatus, 6000);
    return () => clearInterval(timer);
  }, [fetchWsStatus]);

  // Real-time lifecycle event subscription
  useEffect(() => {
    return subscribeManagerWS((msg: any) => {
      if (msg.type === 'gw_lifecycle') {
        const rec = msg.data as LifecycleRecord;
        if (rec?.event_type) {
          setLifecycleRecords(prev => {
            const updated = [rec, ...prev];
            if (updated.length > 50) updated.length = 50;
            return updated;
          });
        }
      }
    });
  }, []);

  const handleReconnect = useCallback(async () => {
    setReconnecting(true);
    try {
      await gwApi.reconnect();
      toast('success', gw.svcWsReconnecting || 'Reconnecting...');
      setTimeout(fetchWsStatus, 2000);
    } catch (err: any) {
      toast('error', err?.message || gw.svcWsReconnectFailed || 'Reconnect failed');
    } finally {
      setReconnecting(false);
    }
  }, [gw, toast, fetchWsStatus]);

  const handleInstall = useCallback(async () => {
    setActionLoading('install');
    try {
      const result: any = await gatewayApi.daemonInstall();
      setDaemon(result);
      toast('success', gw.daemonInstallOk || 'Service installed');
    } catch (err: any) {
      toast('error', err?.message || gw.daemonInstallFailed || 'Install failed');
    } finally {
      setActionLoading(null);
    }
  }, [gw, toast]);

  const handleUninstall = useCallback(async () => {
    setActionLoading('uninstall');
    try {
      const result: any = await gatewayApi.daemonUninstall();
      setDaemon(result);
      toast('success', gw.daemonUninstallOk || 'Service removed');
    } catch (err: any) {
      toast('error', err?.message || gw.daemonUninstallFailed || 'Uninstall failed');
    } finally {
      setActionLoading(null);
    }
  }, [gw, toast]);

  return (
    <div className="p-4 space-y-4 text-white/80 overflow-y-auto custom-scrollbar h-full">
      {/* Process Info */}
      <div className="space-y-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-white/40 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[14px]">info</span>
          {gw.serviceProcessInfo || 'Process Info'}
        </h4>
        {status?.running ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06]">
              <p className="text-[9px] text-white/30 uppercase tracking-wider">{gw.status || 'Status'}</p>
              <p className="text-[12px] font-bold text-mac-green flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-mac-green animate-pulse" />
                {gw.running || 'Running'}
              </p>
            </div>
            <div className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06]">
              <p className="text-[9px] text-white/30 uppercase tracking-wider">{gw.runtimeMode || 'Mode'}</p>
              <p className="text-[12px] font-bold font-mono text-white/70">{status.runtime ? ((gw as any)[`runtime${status.runtime.charAt(0).toUpperCase()}${status.runtime.slice(1)}`] || status.runtime) : '-'}</p>
            </div>
            <div className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06] col-span-2">
              <p className="text-[9px] text-white/30 uppercase tracking-wider">{gw.serviceDetail || 'Detail'}</p>
              <p className="text-[11px] font-mono text-white/50 break-all">{status.detail || '-'}</p>
            </div>
          </div>
        ) : (
          <div className="px-3 py-4 rounded-lg bg-white/[0.02] border border-white/[0.06] text-center">
            <span className="material-symbols-outlined text-[24px] text-white/15 mb-1">power_off</span>
            <p className="text-[11px] text-white/30">{gw.serviceNotRunning || 'Gateway is not running'}</p>
          </div>
        )}
      </div>

      {/* Daemon Service Status */}
      <div className="space-y-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-white/40 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[14px]">settings_system_daydream</span>
          {gw.serviceTitle || 'System Service'}
        </h4>
        <p className="text-[10px] text-white/30 leading-relaxed">{gw.serviceDesc || 'Run gateway as an OS-level service for auto-start on boot'}</p>

        {remote ? (
          <div className="px-3 py-3 rounded-lg bg-white/[0.02] border border-white/[0.06] flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-white/20">cloud</span>
            <p className="text-[11px] text-white/40">{gw.daemonRemoteHint || 'Remote gateways are already running as services. Daemon management is only available for local gateways.'}</p>
          </div>
        ) : status?.runtime === 'systemd' || status?.runtime === 'docker' ? (
          <div className="px-3 py-3 rounded-lg bg-mac-green/5 border border-mac-green/20 flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-mac-green">check_circle</span>
            <div>
              <p className="text-[11px] font-bold text-mac-green">{gw.daemonAlreadyManaged || 'Already managed by system service'}</p>
              <p className="text-[10px] text-white/40 mt-0.5">{status.runtime === 'systemd' ? 'systemd' : 'Docker'} — {status.detail || ''}</p>
            </div>
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 px-3 py-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <span className="material-symbols-outlined text-[16px] text-white/20 animate-spin">progress_activity</span>
            <span className="text-[11px] text-white/30">{gw.loading || 'Loading...'}</span>
          </div>
        ) : daemon ? (
          <div className="space-y-2">
            {/* Platform & Status card */}
            <div className={`px-3 py-3 rounded-lg border flex items-center gap-3 ${
              daemon.installed
                ? 'bg-mac-green/5 border-mac-green/20'
                : 'bg-white/[0.02] border-white/[0.06]'
            }`}>
              <span className={`material-symbols-outlined text-[22px] ${daemon.installed ? 'text-mac-green' : 'text-white/20'}`}>
                {PLATFORM_ICONS[daemon.platform] || 'dns'}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold text-white/70">
                  {PLATFORM_LABELS[daemon.platform] || daemon.platform}
                </p>
                <p className="text-[10px] text-white/40 mt-0.5">{daemon.detail}</p>
                {daemon.unitFile && (
                  <p className="text-[9px] font-mono text-white/20 mt-0.5 truncate">{daemon.unitFile}</p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                {daemon.installed && (
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${daemon.active ? 'bg-mac-green/20 text-mac-green' : 'bg-mac-yellow/20 text-mac-yellow'}`}>
                    {daemon.active ? (gw.running || 'Running') : (gw.stopped || 'Stopped')}
                  </span>
                )}
                {daemon.enabled && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-primary/15 text-primary/80">
                    Auto-start
                  </span>
                )}
              </div>
            </div>

            {/* Action buttons */}
            {daemon.platform !== 'unsupported' && (
              <div className="flex items-center gap-2">
                {!daemon.installed ? (
                  <button
                    onClick={handleInstall}
                    disabled={!!actionLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-mac-green/15 text-mac-green font-bold text-[10px] transition-all hover:bg-mac-green/25 disabled:opacity-40"
                  >
                    <span className={`material-symbols-outlined text-[14px] ${actionLoading === 'install' ? 'animate-spin' : ''}`}>
                      {actionLoading === 'install' ? 'progress_activity' : 'install_desktop'}
                    </span>
                    {gw.daemonInstall || 'Install Service'}
                  </button>
                ) : (
                  <button
                    onClick={handleUninstall}
                    disabled={!!actionLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-mac-red/15 text-mac-red font-bold text-[10px] transition-all hover:bg-mac-red/25 disabled:opacity-40"
                  >
                    <span className={`material-symbols-outlined text-[14px] ${actionLoading === 'uninstall' ? 'animate-spin' : ''}`}>
                      {actionLoading === 'uninstall' ? 'progress_activity' : 'delete_forever'}
                    </span>
                    {gw.daemonUninstall || 'Remove Service'}
                  </button>
                )}
                <button
                  onClick={fetchDaemonStatus}
                  disabled={loading}
                  className="p-1.5 rounded-lg bg-white/5 text-white/40 hover:text-white hover:bg-white/10 transition-all disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[14px]">refresh</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="px-3 py-3 rounded-lg bg-white/[0.02] border border-white/[0.06] text-center">
            <p className="text-[11px] text-white/30">{gw.daemonStatusFailed || 'Failed to query daemon status'}</p>
            <button onClick={fetchDaemonStatus} className="mt-1 text-[10px] text-primary hover:underline">{gw.retry || 'Retry'}</button>
          </div>
        )}
      </div>

      {/* WebSocket Connection Status */}
      <div className="space-y-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-white/40 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[14px]">cable</span>
          {gw.svcWsTitle || 'WebSocket Connection'}
        </h4>
        {wsStatus ? (
          <div className="space-y-2">
            <div className={`px-3 py-3 rounded-lg border flex items-center gap-3 ${
              wsStatus.connected ? 'bg-mac-green/5 border-mac-green/20' : 'bg-mac-red/5 border-mac-red/20'
            }`}>
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                wsStatus.connected ? 'bg-mac-green/15' : 'bg-mac-red/15'
              }`}>
                <span className={`material-symbols-outlined text-[20px] ${wsStatus.connected ? 'text-mac-green' : 'text-mac-red'}`}>
                  {wsStatus.connected ? 'link' : 'link_off'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-[12px] font-bold ${wsStatus.connected ? 'text-mac-green' : 'text-mac-red'}`}>
                  {wsStatus.connected ? (gw.svcWsConnected || 'Connected') : (gw.svcWsDisconnected || 'Disconnected')}
                </p>
                <p className="text-[10px] text-white/40 font-mono mt-0.5">
                  {wsStatus.host}:{wsStatus.port}
                </p>
              </div>
              <button
                onClick={handleReconnect}
                disabled={reconnecting}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 text-white/50 font-bold text-[10px] transition-all hover:bg-white/10 hover:text-white disabled:opacity-40 shrink-0"
              >
                <span className={`material-symbols-outlined text-[14px] ${reconnecting ? 'animate-spin' : ''}`}>
                  {reconnecting ? 'progress_activity' : 'refresh'}
                </span>
                {gw.svcWsReconnect || 'Reconnect'}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                <p className="text-[9px] text-white/30 uppercase tracking-wider">{gw.svcWsReconnects || 'Reconnects'}</p>
                <p className="text-[12px] font-bold font-mono text-white/70">{wsStatus.reconnect_count}</p>
              </div>
              <div className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                <p className="text-[9px] text-white/30 uppercase tracking-wider">{gw.svcWsBackoff || 'Backoff'}</p>
                <p className="text-[12px] font-bold font-mono text-white/70">
                  {wsStatus.backoff_ms >= 1000 ? `${(wsStatus.backoff_ms / 1000).toFixed(1)}s` : `${wsStatus.backoff_ms}ms`}
                </p>
              </div>
            </div>

            {wsStatus.last_error && (
              <div className="px-3 py-2 rounded-lg bg-mac-red/5 border border-mac-red/20">
                <p className="text-[9px] text-white/30 uppercase tracking-wider mb-0.5">{gw.svcWsLastError || 'Last Error'}</p>
                <p className="text-[10px] font-mono text-mac-red/80 break-all">{wsStatus.last_error}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3 py-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <span className="material-symbols-outlined text-[16px] text-white/20 animate-spin">progress_activity</span>
            <span className="text-[11px] text-white/30">{gw.loading || 'Loading...'}</span>
          </div>
        )}
      </div>

      {/* Watchdog Status */}
      <div className="space-y-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-white/40 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[14px]">pets</span>
          {gw.serviceWatchdog || 'Watchdog'}
        </h4>
        <div className={`px-3 py-2.5 rounded-lg border flex items-center gap-2 ${
          healthCheckEnabled
            ? 'bg-mac-green/5 border-mac-green/20'
            : 'bg-white/[0.02] border-white/[0.06]'
        }`}>
          <span className={`material-symbols-outlined text-[18px] ${healthCheckEnabled ? 'text-mac-green' : 'text-white/20'}`}>
            {healthCheckEnabled ? 'shield' : 'shield_question'}
          </span>
          <div className="flex-1 min-w-0">
            <p className={`text-[11px] font-bold ${healthCheckEnabled ? 'text-mac-green' : 'text-white/40'}`}>
              {healthCheckEnabled
                ? (gw.serviceWatchdogActive || 'Active')
                : (gw.serviceWatchdogInactive || 'Inactive')}
            </p>
            {healthCheckEnabled && healthStatus && (
              <p className="text-[10px] text-white/30 mt-0.5">
                {healthStatus.fail_count > 0
                  ? `${gw.hbUnhealthy || 'Unhealthy'} (${healthStatus.fail_count} fails)`
                  : `${gw.hbHealthy || 'Healthy'} — ${healthStatus.last_ok ? new Date(healthStatus.last_ok).toLocaleTimeString() : '-'}`}
              </p>
            )}
          </div>
        </div>

        {healthCheckEnabled && wsStatus && (
          <div className="grid grid-cols-3 gap-2">
            <div className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06]">
              <p className="text-[9px] text-white/30 uppercase tracking-wider">{gw.wdFailCount || 'Fails'}</p>
              <p className={`text-[12px] font-bold font-mono ${
                wsStatus.fail_count > 0 ? (wsStatus.fail_count >= wsStatus.max_fails ? 'text-mac-red' : 'text-mac-yellow') : 'text-mac-green'
              }`}>
                {wsStatus.fail_count}/{wsStatus.max_fails}
              </p>
            </div>
            <div className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06]">
              <p className="text-[9px] text-white/30 uppercase tracking-wider">{gw.wdInterval || 'Interval'}</p>
              <p className="text-[12px] font-bold font-mono text-white/70">{wsStatus.interval_sec}s</p>
            </div>
            <div className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06]">
              <p className="text-[9px] text-white/30 uppercase tracking-wider">{gw.wdLastOk || 'Last OK'}</p>
              <p className="text-[11px] font-mono text-white/60">
                {wsStatus.last_ok ? new Date(wsStatus.last_ok).toLocaleTimeString() : '-'}
              </p>
            </div>
          </div>
        )}

        {healthCheckEnabled && wsStatus?.grace_until && (
          <div className="px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/20 flex items-center gap-2">
            <span className="material-symbols-outlined text-[14px] text-amber-500">hourglass_top</span>
            <div>
              <p className="text-[10px] font-bold text-amber-400">{gw.wdGracePeriod || 'Grace Period Active'}</p>
              <p className="text-[9px] text-white/30 font-mono mt-0.5">
                {gw.wdGraceUntil || 'Until'}: {new Date(wsStatus.grace_until).toLocaleTimeString()}
              </p>
            </div>
          </div>
        )}

        {healthCheckEnabled && remote && (
          <div className="px-3 py-2 rounded-lg bg-primary/5 border border-primary/20 flex items-center gap-2">
            <span className="material-symbols-outlined text-[14px] text-primary">cloud</span>
            <p className="text-[10px] text-white/40">
              {gw.wdRemoteHint || 'Remote mode: watchdog will only reconnect, never restart the remote gateway.'}
            </p>
          </div>
        )}
      </div>

      {/* Gateway Lifecycle Timeline */}
      <div className="space-y-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-white/40 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[14px]">history</span>
          {gw.lifecycleTitle || 'Gateway History'}
        </h4>

        {lifecycleRecords.length === 0 ? (
          <div className="px-3 py-4 rounded-lg bg-white/[0.02] border border-white/[0.06] text-center">
            <span className="material-symbols-outlined text-[24px] text-white/10 mb-1">timeline</span>
            <p className="text-[11px] text-white/30">{gw.lifecycleEmpty || 'No lifecycle events yet'}</p>
          </div>
        ) : (
          <div className="space-y-0">
            {(lifecycleExpanded ? lifecycleRecords : lifecycleRecords.slice(0, 8)).map((rec, idx) => {
              const eventLabel = (gw as any)[`lifecycle${rec.event_type.charAt(0).toUpperCase()}${rec.event_type.slice(1)}`] || rec.event_type;
              const color = LIFECYCLE_COLOR[rec.event_type] || 'text-white/50';
              const icon = LIFECYCLE_ICON[rec.event_type] || 'radio_button_checked';
              const bg = LIFECYCLE_BG[rec.event_type] || 'bg-white/[0.04] border-white/[0.06]';
              const ts = new Date(rec.timestamp);
              const timeStr = ts.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
              const uptimeStr = fmtLifecycleUptime(rec.uptime_sec);

              return (
                <div key={rec.id || idx} className="flex items-start gap-0 group">
                  {/* Timeline line + dot */}
                  <div className="flex flex-col items-center w-6 shrink-0">
                    <div className={`w-0.5 ${idx === 0 ? 'h-2' : 'h-3'} ${idx === 0 ? 'bg-transparent' : 'bg-white/10'}`} />
                    <span className={`material-symbols-outlined text-[14px] ${color}`}>{icon}</span>
                    <div className={`w-0.5 flex-1 ${idx === (lifecycleExpanded ? lifecycleRecords.length : Math.min(lifecycleRecords.length, 8)) - 1 ? 'bg-transparent' : 'bg-white/10'}`} />
                  </div>

                  {/* Content */}
                  <div className={`flex-1 min-w-0 px-2.5 py-1.5 my-0.5 rounded-lg border transition-all ${bg}`}>
                    <div className="flex items-center justify-between gap-2">
                      <p className={`text-[11px] font-bold ${color}`}>{eventLabel}</p>
                      <span className="text-[9px] text-white/25 font-mono shrink-0">{timeStr}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      {uptimeStr && (
                        <span className="text-[9px] text-white/30">
                          {gw.lifecycleUptime || 'Uptime'}: <span className="font-mono text-white/50">{uptimeStr}</span>
                        </span>
                      )}
                      {rec.reason && (
                        <span className="text-[9px] text-white/30 truncate max-w-[180px]" title={rec.reason}>
                          {rec.reason}
                        </span>
                      )}
                    </div>
                    {rec.error_detail && (
                      <p className="text-[9px] font-mono text-mac-red/70 mt-0.5 break-all leading-relaxed">{rec.error_detail}</p>
                    )}
                  </div>
                </div>
              );
            })}

            {lifecycleRecords.length > 8 && (
              <button
                onClick={() => setLifecycleExpanded(v => !v)}
                className="w-full mt-1 py-1.5 text-[10px] font-bold text-primary/70 hover:text-primary rounded-lg hover:bg-primary/5 transition-all flex items-center justify-center gap-1"
              >
                <span className="material-symbols-outlined text-[12px]">
                  {lifecycleExpanded ? 'expand_less' : 'expand_more'}
                </span>
                {lifecycleExpanded ? '' : (gw.lifecycleShowMore || 'Show more')} ({lifecycleRecords.length})
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ServicePanel;
