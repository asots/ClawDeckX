import React, { useMemo, useState, useCallback } from 'react';
import { SectionProps } from '../sectionTypes';
import { ConfigSection, TextField, SelectField, SwitchField, KeyValueField, NumberField, ArrayField } from '../fields';
import { getTranslation } from '../../../locales';
import { schemaTooltip, schemaDefault } from '../schemaTooltip';
import SchemaRemainder from '../SchemaRemainder';

// Options moved inside component

export const MiscSection: React.FC<SectionProps> = ({ config, schema, setField, getField, deleteField, language }) => {
  const es = useMemo(() => (getTranslation(language) as any).es || {}, [language]);
  const tip = (key: string) => schemaTooltip(key, language, schema);
  const def = (key: string) => schemaDefault(key, schema);
  const gg = (p: string[]) => getField(['gateway', ...p]);
  const gs = (p: string[], v: any) => setField(['gateway', ...p], v);

  const mcpVal = getField(['mcpServers']) || {};
  const [mcpDraft, setMcpDraft] = useState(() => JSON.stringify(mcpVal, null, 2));
  const [mcpError, setMcpError] = useState('');
  const applyMcp = useCallback(() => {
    try {
      const parsed = JSON.parse(mcpDraft);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setMcpError(es.mcpMustBeObject || 'Must be a JSON object');
        return;
      }
      setField(['mcpServers'], parsed);
      setMcpError('');
    } catch (e: any) {
      setMcpError(e.message || 'Invalid JSON');
    }
  }, [mcpDraft, setField, es]);

  const UPDATE_CHANNEL_OPTIONS = useMemo(() => [
    { value: 'stable', label: es.optStable }, { value: 'beta', label: es.optBeta }, { value: 'dev', label: es.optDev },
  ], [es]);
  const TAGLINE_MODE_OPTIONS = useMemo(() => [
    { value: 'random', label: es.taglineRandom || 'Random' }, { value: 'default', label: es.taglineDefault || 'Default' }, { value: 'off', label: es.taglineOff || 'Off' },
  ], [es]);

  return (
    <div className="space-y-4">
      {/* CLI */}
      <ConfigSection title={es.cliConfig || 'CLI'} icon="terminal" iconColor="text-emerald-500" defaultOpen={false}>
        <SelectField label={es.cliTaglineMode} tooltip={tip('cli.banner.taglineMode')} value={getField(['cli', 'banner', 'taglineMode']) || 'random'} onChange={v => setField(['cli', 'banner', 'taglineMode'], v)} options={TAGLINE_MODE_OPTIONS} />
      </ConfigSection>

      {/* Update */}
      <ConfigSection title={es.updateConfig} icon="system_update" iconColor="text-blue-500">
        <SelectField label={es.updateChannel} tooltip={tip('update.channel')} value={getField(['update', 'channel']) || 'stable'} onChange={v => setField(['update', 'channel'], v)} options={UPDATE_CHANNEL_OPTIONS} />
        <SwitchField label={es.checkOnStart} tooltip={tip('update.checkOnStart')} value={getField(['update', 'checkOnStart']) !== false} onChange={v => setField(['update', 'checkOnStart'], v)} />
        <SwitchField label={es.autoUpdateEnabled} tooltip={tip('update.auto.enabled')} value={getField(['update', 'auto', 'enabled']) === true} onChange={v => setField(['update', 'auto', 'enabled'], v)} />
        <NumberField label={es.autoStableDelayH} tooltip={tip('update.auto.stableDelayHours')} value={getField(['update', 'auto', 'stableDelayHours'])} onChange={v => setField(['update', 'auto', 'stableDelayHours'], v)} min={0} max={168} placeholder={def('update.auto.stableDelayHours')} />
        <NumberField label={es.autoStableJitterH} tooltip={tip('update.auto.stableJitterHours')} value={getField(['update', 'auto', 'stableJitterHours'])} onChange={v => setField(['update', 'auto', 'stableJitterHours'], v)} min={0} max={168} placeholder={def('update.auto.stableJitterHours')} />
        <NumberField label={es.autoBetaCheckH} tooltip={tip('update.auto.betaCheckIntervalHours')} value={getField(['update', 'auto', 'betaCheckIntervalHours'])} onChange={v => setField(['update', 'auto', 'betaCheckIntervalHours'], v)} min={1} max={24} placeholder={def('update.auto.betaCheckIntervalHours')} />
      </ConfigSection>

      {/* UI */}
      <ConfigSection title={es.uiConfig} icon="palette" iconColor="text-pink-500" defaultOpen={false}>
        <TextField label={es.seamColor} tooltip={tip('ui.seamColor')} value={getField(['ui', 'seamColor']) || ''} onChange={v => setField(['ui', 'seamColor'], v)} placeholder={es.phColorHex} />
        <TextField label={es.assistantName} tooltip={tip('ui.assistant.name')} value={getField(['ui', 'assistant', 'name']) || ''} onChange={v => setField(['ui', 'assistant', 'name'], v)} mono={false} placeholder={es.phAssistantName} />
        <TextField label={es.assistantAvatar} tooltip={tip('ui.assistant.avatar')} value={getField(['ui', 'assistant', 'avatar']) || ''} onChange={v => setField(['ui', 'assistant', 'avatar'], v)} placeholder={es.phHttps} />
      </ConfigSection>

      <ConfigSection title={es.controlUi} icon="dashboard" iconColor="text-indigo-500" defaultOpen={false}>
        <SwitchField label={es.enabled} tooltip={tip('gateway.controlUi.enabled')} value={gg(['controlUi', 'enabled']) !== false} onChange={v => gs(['controlUi', 'enabled'], v)} />
        <TextField label={es.basePath} tooltip={tip('gateway.controlUi.basePath')} value={gg(['controlUi', 'basePath']) || ''} onChange={v => gs(['controlUi', 'basePath'], v)} placeholder={es.phRootPath} />
        <TextField label={es.cuiRoot} tooltip={tip('gateway.controlUi.root')} value={gg(['controlUi', 'root']) || ''} onChange={v => gs(['controlUi', 'root'], v)} />
        <ArrayField label={es.allowedOrigins} tooltip={tip('gateway.controlUi.allowedOrigins')} value={gg(['controlUi', 'allowedOrigins']) || []} onChange={v => gs(['controlUi', 'allowedOrigins'], v)} placeholder={es.phHttps} />
        <SwitchField label={es.cuiAllowInsecureAuth} tooltip={tip('gateway.controlUi.allowInsecureAuth')} value={gg(['controlUi', 'allowInsecureAuth']) === true} onChange={v => gs(['controlUi', 'allowInsecureAuth'], v)} />
      </ConfigSection>

      {/* MCP Servers */}
      <ConfigSection title={es.mcpServers || 'MCP Servers'} icon="hub" iconColor="text-violet-500" defaultOpen={false}>
        <div className="space-y-2">
          <p className="text-[10px] text-slate-500 dark:text-white/40">{es.mcpServersDesc || 'Named MCP server definitions. Each key is a server name with command, args, and env fields.'}</p>
          <textarea
            value={mcpDraft}
            onChange={e => { setMcpDraft(e.target.value); setMcpError(''); }}
            rows={8}
            spellCheck={false}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/20 text-[11px] font-mono text-slate-800 dark:text-white/80 outline-none focus:border-primary/50 resize-y"
          />
          {mcpError && <p className="text-[10px] text-red-500">{mcpError}</p>}
          <button onClick={applyMcp} className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
            {es.apply || 'Apply'}
          </button>
        </div>
      </ConfigSection>

      {/* Node Host */}
      <ConfigSection title={es.nodeHostBrowserProxy || 'Node Browser Proxy'} icon="devices" iconColor="text-violet-500" defaultOpen={false}>
        <SwitchField label={es.nhBpEnabled || 'Enabled'} tooltip={tip('nodeHost.browserProxy.enabled')} value={getField(['nodeHost', 'browserProxy', 'enabled']) === true} onChange={v => setField(['nodeHost', 'browserProxy', 'enabled'], v)} />
        <ArrayField label={es.nhBpAllowProfiles || 'Allowed Profiles'} tooltip={tip('nodeHost.browserProxy.allowProfiles')} value={getField(['nodeHost', 'browserProxy', 'allowProfiles']) || []} onChange={v => setField(['nodeHost', 'browserProxy', 'allowProfiles'], v)} placeholder="profile-name" />
      </ConfigSection>

      {/* Env */}
      <ConfigSection title={es.envVars} icon="settings_system_daydream" iconColor="text-slate-500" defaultOpen={false}>
        <SwitchField label={es.shellEnvEnabled} tooltip={tip('env.shellEnv.enabled')} value={getField(['env', 'shellEnv', 'enabled']) === true} onChange={v => setField(['env', 'shellEnv', 'enabled'], v)} />
        <NumberField label={es.shellEnvTimeoutMs} tooltip={tip('env.shellEnv.timeoutMs')} value={getField(['env', 'shellEnv', 'timeoutMs'])} onChange={v => setField(['env', 'shellEnv', 'timeoutMs'], v)} min={0} step={1000} placeholder={def('env.shellEnv.timeoutMs')} />
        <KeyValueField label={es.variables} tooltip={tip('env.vars')} value={getField(['env', 'vars']) || {}} onChange={v => setField(['env', 'vars'], v)} />
      </ConfigSection>

      <SchemaRemainder
        sectionPath="update"
        handledKeys={['channel', 'checkOnStart', 'auto']}
        config={config}
        setField={setField}
        language={language}
        schema={schema}
        title={es.schemaAdditional || 'Additional Update Fields'}
      />
    </div>
  );
};
