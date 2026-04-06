import React, { useMemo } from 'react';
import { SectionProps } from '../sectionTypes';
import { ConfigSection, ConfigCard, TextField, NumberField, SelectField, SwitchField, ArrayField, KeyValueField, AddButton, EmptyState } from '../fields';
import { getTranslation } from '../../../locales';
import { schemaTooltip } from '../schemaTooltip';

// Options moved inside component

export const AgentsSection: React.FC<SectionProps> = ({ config, schema, setField, getField, deleteField, language }) => {
  const es = useMemo(() => (getTranslation(language) as any).es || {}, [language]);
  const tip = (key: string) => schemaTooltip(key, language, schema);
  const d = (p: string[]) => getField(['agents', 'defaults', ...p]);
  const sd = (p: string[], v: any) => setField(['agents', 'defaults', ...p], v);

  const THINKING_OPTIONS = useMemo(() => [
    { value: 'off', label: es.optOff }, { value: 'adaptive', label: es.optAdaptive }, { value: 'minimal', label: es.optMinimal }, { value: 'low', label: es.optLow },
    { value: 'medium', label: es.optMedium }, { value: 'high', label: es.optHigh }, { value: 'xhigh', label: es.optXHigh },
  ], [es]);
  const VERBOSE_OPTIONS = useMemo(() => [{ value: 'off', label: es.optOff }, { value: 'on', label: es.optOn }, { value: 'full', label: es.optFull }], [es]);
  const ELEVATED_OPTIONS = useMemo(() => [{ value: 'off', label: es.optOff }, { value: 'on', label: es.optOn }, { value: 'ask', label: es.optAsk }, { value: 'full', label: es.optFull }], [es]);
  const TYPING_OPTIONS = useMemo(() => [{ value: 'never', label: es.optNever }, { value: 'instant', label: es.optInstant }, { value: 'thinking', label: es.optThinking }, { value: 'message', label: es.optMessage }], [es]);
  const COMPACTION_OPTIONS = useMemo(() => [{ value: 'default', label: es.default }, { value: 'safeguard', label: es.optSafeguard }, { value: 'aggressive', label: es.optAggressive }, { value: 'off', label: es.optOff }], [es]);
  const HUMAN_DELAY_OPTIONS = useMemo(() => [{ value: 'off', label: es.optOff }, { value: 'natural', label: es.optNatural }, { value: 'fixed', label: es.optFixed }], [es]);
  const SANDBOX_MODE_OPTIONS = useMemo(() => [{ value: 'off', label: es.optOff }, { value: 'non-main', label: es.optNonMain || 'Non-main' }, { value: 'all', label: es.optAll || 'All' }], [es]);
  const SANDBOX_BACKEND_OPTIONS = useMemo(() => [{ value: 'docker', label: 'Docker' }, { value: 'openshell', label: 'OpenShell' }, { value: 'ssh', label: 'SSH' }], [es]);
  const SANDBOX_ACCESS_OPTIONS = useMemo(() => [{ value: 'none', label: es.optNone || 'None' }, { value: 'ro', label: es.optReadOnly || 'Read Only' }, { value: 'rw', label: es.optReadWrite || 'Read/Write' }], [es]);
  const SANDBOX_SCOPE_OPTIONS = useMemo(() => [{ value: 'session', label: es.optSession || 'Session' }, { value: 'agent', label: es.optAgent || 'Agent' }, { value: 'shared', label: es.optShared || 'Shared' }], [es]);
  const CTX_PRUNING_MODE_OPTIONS = useMemo(() => [{ value: 'off', label: es.optOff }, { value: 'cache-ttl', label: es.optCacheTtl || 'Cache TTL' }], [es]);
  const CTX_INJECTION_OPTIONS = useMemo(() => [{ value: '', label: es.default }, { value: 'continuation-skip', label: es.optContinuationSkip || 'Continuation Skip' }], [es]);

  const rawAgentList = getField(['agents', 'list']);
  const agentList: any[] = Array.isArray(rawAgentList) ? rawAgentList : [];
  const rawBindings = getField(['bindings']);
  const bindings: any[] = Array.isArray(rawBindings) ? rawBindings : [];
  return (
    <div className="space-y-4">
      <ConfigSection title={es.defaults} icon="tune" iconColor="text-purple-500">
        <NumberField label={es.maxConcurrent} desc={es.maxConcurrentDesc} tooltip={tip('agents.defaults.maxConcurrent')} value={d(['maxConcurrent'])} onChange={v => sd(['maxConcurrent'], v)} min={1} max={64} />
        <NumberField label={es.subagentConcurrent} tooltip={tip('agents.defaults.subagents.maxConcurrent')} value={d(['subagents', 'maxConcurrent'])} onChange={v => sd(['subagents', 'maxConcurrent'], v)} min={1} max={32} />
        <NumberField label={es.subagentMaxSpawnDepth || 'Max Spawn Depth'} tooltip={tip('agents.defaults.subagents.maxSpawnDepth')} value={d(['subagents', 'maxSpawnDepth'])} onChange={v => sd(['subagents', 'maxSpawnDepth'], v)} min={1} max={10} />
        <NumberField label={es.subagentMaxChildren || 'Max Children/Agent'} tooltip={tip('agents.defaults.subagents.maxChildrenPerAgent')} value={d(['subagents', 'maxChildrenPerAgent'])} onChange={v => sd(['subagents', 'maxChildrenPerAgent'], v)} min={1} max={50} />
        <NumberField label={es.subagentArchiveMin || 'Archive After (min)'} tooltip={tip('agents.defaults.subagents.archiveAfterMinutes')} value={d(['subagents', 'archiveAfterMinutes'])} onChange={v => sd(['subagents', 'archiveAfterMinutes'], v)} min={0} />
        <TextField label={es.workspace} tooltip={tip('agents.defaults.workspace')} value={d(['workspace']) || ''} onChange={v => sd(['workspace'], v)} placeholder={es.phWorkspacePath} />
        <TextField label={es.imageGenerationModel || 'Image Generation Model'} tooltip={tip('agents.defaults.imageGenerationModel')} value={typeof d(['imageGenerationModel']) === 'string' ? d(['imageGenerationModel']) : d(['imageGenerationModel'])?.primary || ''} onChange={v => sd(['imageGenerationModel'], v)} placeholder={es.phProviderModelId} />
        <TextField label={es.videoGenerationModel || 'Video Generation Model'} tooltip={tip('agents.defaults.videoGenerationModel.primary')} value={typeof d(['videoGenerationModel']) === 'string' ? d(['videoGenerationModel']) : d(['videoGenerationModel'])?.primary || ''} onChange={v => sd(['videoGenerationModel', 'primary'], v)} placeholder={es.phProviderModelId} />
        <TextField label={es.musicGenerationModel || 'Music Generation Model'} tooltip={tip('agents.defaults.musicGenerationModel')} value={typeof d(['musicGenerationModel']) === 'string' ? d(['musicGenerationModel']) : d(['musicGenerationModel'])?.primary || ''} onChange={v => sd(['musicGenerationModel'], v)} placeholder={es.phProviderModelId} />
        <TextField label={es.pdfModel || 'PDF Model'} tooltip={tip('agents.defaults.pdfModel')} value={typeof d(['pdfModel']) === 'string' ? d(['pdfModel']) : d(['pdfModel'])?.primary || ''} onChange={v => sd(['pdfModel'], v)} placeholder={es.phProviderModelId} />
        <NumberField label={es.pdfMaxBytesMb || 'PDF Max Size (MB)'} tooltip={tip('agents.defaults.pdfMaxBytesMb')} value={d(['pdfMaxBytesMb'])} onChange={v => sd(['pdfMaxBytesMb'], v)} min={1} />
        <NumberField label={es.pdfMaxPages || 'PDF Max Pages'} tooltip={tip('agents.defaults.pdfMaxPages')} value={d(['pdfMaxPages'])} onChange={v => sd(['pdfMaxPages'], v)} min={1} />
        <NumberField label={es.timeoutS} tooltip={tip('agents.defaults.timeoutSeconds')} value={d(['timeoutSeconds'])} onChange={v => sd(['timeoutSeconds'], v)} min={0} />
        <NumberField label={es.mediaMaxMb} tooltip={tip('agents.defaults.mediaMaxMb')} value={d(['mediaMaxMb'])} onChange={v => sd(['mediaMaxMb'], v)} min={0} />
        <ArrayField label={es.skills || 'Skills'} tooltip={tip('agents.defaults.skills')} value={d(['skills']) || []} onChange={v => sd(['skills'], v)} placeholder={es.phSkillName || 'skill-name'} />
      </ConfigSection>

      <ConfigSection
        title={es.behavior}
        icon="psychology"
        iconColor="text-indigo-500"
        desc={`${es.thinkingDefault}: ${d(['thinkingDefault']) || 'off'} | ${es.typingMode}: ${d(['typingMode']) || 'never'}`}
      >
        <SelectField label={es.thinkingDefault} tooltip={tip('agents.defaults.thinkingDefault')} value={d(['thinkingDefault']) || 'off'} onChange={v => sd(['thinkingDefault'], v)} options={THINKING_OPTIONS} />
        <SelectField label={es.subagentThinking} tooltip={tip('agents.defaults.subagents.thinking')} value={d(['subagents', 'thinking']) || 'off'} onChange={v => sd(['subagents', 'thinking'], v)} options={THINKING_OPTIONS} />
        <SelectField label={es.verboseDefault} tooltip={tip('agents.defaults.verboseDefault')} value={d(['verboseDefault']) || 'off'} onChange={v => sd(['verboseDefault'], v)} options={VERBOSE_OPTIONS} />
        <SelectField label={es.elevatedDefault} tooltip={tip('agents.defaults.elevatedDefault')} value={d(['elevatedDefault']) || 'off'} onChange={v => sd(['elevatedDefault'], v)} options={ELEVATED_OPTIONS} />
        <SelectField label={es.typingMode} tooltip={tip('agents.defaults.typingMode')} value={d(['typingMode']) || 'never'} onChange={v => sd(['typingMode'], v)} options={TYPING_OPTIONS} />
        <SelectField label={es.compactionMode} tooltip={tip('agents.defaults.compaction.mode')} value={d(['compaction', 'mode']) || 'default'} onChange={v => sd(['compaction', 'mode'], v)} options={COMPACTION_OPTIONS} />
        <TextField label={es.compactionModel || 'Compaction Model'} tooltip={tip('agents.defaults.compaction.model')} value={d(['compaction', 'model']) || ''} onChange={v => sd(['compaction', 'model'], v)} placeholder={es.phProviderModelId} />
        <SwitchField label={es.truncateAfterCompaction || 'Truncate After Compaction'} tooltip={tip('agents.defaults.compaction.truncateAfterCompaction')} value={d(['compaction', 'truncateAfterCompaction']) === true} onChange={v => sd(['compaction', 'truncateAfterCompaction'], v)} />
        <SwitchField label={es.compactionNotifyUser || 'Notify User on Compaction'} tooltip={tip('agents.defaults.compaction.notifyUser')} value={d(['compaction', 'notifyUser']) === true} onChange={v => sd(['compaction', 'notifyUser'], v)} />
        <SwitchField label={es.bootstrapTruncationWarning || 'Bootstrap Truncation Warning'} tooltip={tip('agents.defaults.bootstrapTruncationWarning')} value={d(['bootstrapTruncationWarning']) !== false} onChange={v => sd(['bootstrapTruncationWarning'], v)} />
        <SelectField label={es.contextInjection || 'Context Injection'} tooltip={tip('agents.defaults.contextInjection')} value={d(['contextInjection']) || ''} onChange={v => sd(['contextInjection'], v)} options={CTX_INJECTION_OPTIONS} />
        <KeyValueField label={es.agentParams || 'Default Params'} tooltip={tip('agents.defaults.params')} value={d(['params']) || {}} onChange={v => sd(['params'], v)} />
      </ConfigSection>

      <ConfigSection title={es.humanDelay} icon="timer" iconColor="text-teal-500" defaultOpen={false}>
        <SelectField label={es.mode} tooltip={tip('agents.defaults.humanDelay.mode')} value={d(['humanDelay', 'mode']) || 'off'} onChange={v => sd(['humanDelay', 'mode'], v)} options={HUMAN_DELAY_OPTIONS} />
        {d(['humanDelay', 'mode']) !== 'off' && (
          <>
            <NumberField label={es.lblMinMs} tooltip={tip('agents.defaults.humanDelay.minMs')} value={d(['humanDelay', 'minMs'])} onChange={v => sd(['humanDelay', 'minMs'], v)} min={0} />
            <NumberField label={es.lblMaxMs} tooltip={tip('agents.defaults.humanDelay.maxMs')} value={d(['humanDelay', 'maxMs'])} onChange={v => sd(['humanDelay', 'maxMs'], v)} min={0} />
          </>
        )}
      </ConfigSection>

      <ConfigSection title={es.heartbeat} icon="favorite" iconColor="text-red-500" defaultOpen={false}>
        <SwitchField label={es.enabled} tooltip={tip('agents.defaults.heartbeat.enabled')} value={d(['heartbeat', 'enabled']) !== false} onChange={v => sd(['heartbeat', 'enabled'], v)} />
        <NumberField label={es.intervalS} tooltip={tip('agents.defaults.heartbeat.intervalSeconds')} value={d(['heartbeat', 'intervalSeconds'])} onChange={v => sd(['heartbeat', 'intervalSeconds'], v)} min={10} />
        <TextField label={es.message} tooltip={tip('agents.defaults.heartbeat.message')} value={d(['heartbeat', 'message']) || ''} onChange={v => sd(['heartbeat', 'message'], v)} mono={false} />
      </ConfigSection>

      <ConfigSection title={es.contextPruning} icon="content_cut" iconColor="text-orange-500" defaultOpen={false}>
        <SelectField label={es.mode} tooltip={tip('agents.defaults.contextPruning.mode')} value={d(['contextPruning', 'mode']) || 'off'} onChange={v => sd(['contextPruning', 'mode'], v)} options={CTX_PRUNING_MODE_OPTIONS} />
        <TextField label={es.ctxPruningTtl || 'Cache TTL'} tooltip={tip('agents.defaults.contextPruning.ttl')} value={d(['contextPruning', 'ttl']) || ''} onChange={v => sd(['contextPruning', 'ttl'], v)} placeholder="30m" />
      </ConfigSection>

      <ConfigSection title={es.memorySearch} icon="search" iconColor="text-sky-500" defaultOpen={false}>
        <SwitchField label={es.enabled} tooltip={tip('agents.defaults.memorySearch.enabled')} value={d(['memorySearch', 'enabled']) !== false} onChange={v => sd(['memorySearch', 'enabled'], v)} />
        <NumberField label={es.maxResults} tooltip={tip('agents.defaults.memorySearch.maxResults')} value={d(['memorySearch', 'maxResults'])} onChange={v => sd(['memorySearch', 'maxResults'], v)} min={1} />
      </ConfigSection>

      <ConfigSection title={es.sandbox} icon="shield" iconColor="text-emerald-500" defaultOpen={false}>
        <SelectField label={es.sandboxMode || 'Sandbox Mode'} tooltip={tip('agents.defaults.sandbox.mode')} value={d(['sandbox', 'mode']) || 'off'} onChange={v => sd(['sandbox', 'mode'], v)} options={SANDBOX_MODE_OPTIONS} />
        <SelectField label={es.sandboxBackend || 'Sandbox Backend'} tooltip={tip('agents.defaults.sandbox.backend')} value={d(['sandbox', 'backend']) || 'docker'} onChange={v => sd(['sandbox', 'backend'], v)} options={SANDBOX_BACKEND_OPTIONS} />
        <SelectField label={es.sandboxAccess || 'Workspace Access'} tooltip={tip('agents.defaults.sandbox.workspaceAccess')} value={d(['sandbox', 'workspaceAccess']) || 'none'} onChange={v => sd(['sandbox', 'workspaceAccess'], v)} options={SANDBOX_ACCESS_OPTIONS} />
        <SelectField label={es.sandboxScope || 'Scope'} tooltip={tip('agents.defaults.sandbox.scope')} value={d(['sandbox', 'scope']) || 'session'} onChange={v => sd(['sandbox', 'scope'], v)} options={SANDBOX_SCOPE_OPTIONS} />
        <SwitchField label={es.dockerEnabled} tooltip={tip('agents.defaults.sandbox.docker.enabled')} value={d(['sandbox', 'docker', 'enabled']) === true} onChange={v => sd(['sandbox', 'docker', 'enabled'], v)} />
        <TextField label={es.image} tooltip={tip('agents.defaults.sandbox.docker.image')} value={d(['sandbox', 'docker', 'image']) || ''} onChange={v => sd(['sandbox', 'docker', 'image'], v)} placeholder={es.phDockerImage} />
        <TextField label={es.network} tooltip={tip('agents.defaults.sandbox.docker.network')} value={d(['sandbox', 'docker', 'network']) || ''} onChange={v => sd(['sandbox', 'docker', 'network'], v)} placeholder={es.phHost} />
        <TextField label={es.sshTarget || 'SSH Target'} tooltip={tip('agents.defaults.sandbox.ssh.target')} value={d(['sandbox', 'ssh', 'target']) || ''} onChange={v => sd(['sandbox', 'ssh', 'target'], v)} placeholder="user@host:22" />
      </ConfigSection>

      <ConfigSection
        title={es.agentList}
        icon="groups"
        iconColor="text-purple-500"
        desc={`${agentList.length} ${es.agentDefaultName}`}
        defaultOpen={false}
      >
        {agentList.map((agent: any, i: number) => (
          <ConfigCard key={i} title={agent.name || agent.id || `${es.agentDefaultName} ${i + 1}`} icon="smart_toy" onDelete={() => {
            const newList = agentList.filter((_: any, j: number) => j !== i);
            setField(['agents', 'list'], newList);
          }}>
            <TextField label={es.id} value={agent.id || ''} onChange={v => setField(['agents', 'list', String(i), 'id'], v)} />
            <TextField label={es.name} value={agent.name || ''} onChange={v => setField(['agents', 'list', String(i), 'name'], v)} mono={false} />
            <TextField label={es.avatar} tooltip={tip('agents.list.avatar')} value={agent.avatar || ''} onChange={v => setField(['agents', 'list', String(i), 'avatar'], v)} mono={false} placeholder={es.phHttpUrl} />
            <TextField label={es.systemPrompt} value={agent.systemPrompt || ''} onChange={v => setField(['agents', 'list', String(i), 'systemPrompt'], v)} mono={false} multiline />
            <TextField label={es.model} value={agent.model?.primary || ''} onChange={v => setField(['agents', 'list', String(i), 'model', 'primary'], v)} placeholder={es.phProviderModelId} />

            {/* Overrides */}
            <SelectField label={es.thinkingDefault} tooltip={tip('agents.list.thinking')} value={agent.thinking || ''} onChange={v => setField(['agents', 'list', String(i), 'thinking'], v)} options={[{ value: '', label: es.default }, ...THINKING_OPTIONS]} />
            <SelectField label={es.verboseDefault} tooltip={tip('agents.list.verbose')} value={agent.verbose || ''} onChange={v => setField(['agents', 'list', String(i), 'verbose'], v)} options={[{ value: '', label: es.default }, ...VERBOSE_OPTIONS]} />
            <SwitchField label={es.fastMode || 'Fast Mode'} tooltip={tip('agents.list.fastMode')} value={agent.fastMode === true} onChange={v => setField(['agents', 'list', String(i), 'fastMode'], v || undefined)} />
            <TextField label={es.subagentModel} tooltip={tip('agents.list.subagentModel')} value={agent.subagents?.model || ''} onChange={v => setField(['agents', 'list', String(i), 'subagents', 'model'], v)} placeholder={es.phUseDefault} />
          </ConfigCard>
        ))}
        <AddButton label={es.addAgent} onClick={() => {
          setField(['agents', 'list'], [...agentList, { id: `agent-${agentList.length + 1}` }]);
        }} />
      </ConfigSection>

      <ConfigSection
        title={es.bindings}
        icon="link"
        iconColor="text-indigo-500"
        desc={`${bindings.length} ${es.bindingCount}`}
        defaultOpen={false}
      >
        {bindings.length === 0 ? (
          <EmptyState message={es.noBindings} icon="link_off" />
        ) : (
          bindings.map((b: any, i: number) => (
            <ConfigCard key={i} title={b.agentId || `${es.bindingN} ${i + 1}`} icon="link" onDelete={() => {
              const next = bindings.filter((_: any, j: number) => j !== i);
              setField(['bindings'], next);
            }}>
              <TextField label={es.agentId} value={b.agentId || ''} onChange={v => {
                const next = [...bindings]; next[i] = { ...next[i], agentId: v }; setField(['bindings'], next);
              }} />
              <TextField label={es.channel} value={b.match?.channel || ''} onChange={v => {
                const next = [...bindings]; next[i] = { ...next[i], match: { ...(next[i].match || {}), channel: v } }; setField(['bindings'], next);
              }} placeholder={es.phTelegramChannel} />
              <TextField label={es.peer} value={b.match?.peer || ''} onChange={v => {
                const next = [...bindings]; next[i] = { ...next[i], match: { ...(next[i].match || {}), peer: v } }; setField(['bindings'], next);
              }} placeholder={es.phUserId} />
            </ConfigCard>
          ))
        )}
        <AddButton label={es.addBinding} onClick={() => {
          setField(['bindings'], [...bindings, { agentId: '', match: {} }]);
        }} />
      </ConfigSection>
    </div>
  );
};
