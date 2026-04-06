import React, { useMemo } from 'react';
import { SectionProps } from '../sectionTypes';
import { ConfigSection, TextField, NumberField, SelectField, SwitchField } from '../fields';
import { getTranslation } from '../../../locales';
import { schemaTooltip } from '../schemaTooltip';
import SchemaRemainder from '../SchemaRemainder';

// Options moved inside component

export const MemorySection: React.FC<SectionProps> = ({ config, schema, setField, getField, language }) => {
  const es = useMemo(() => (getTranslation(language) as any).es || {}, [language]);
  const tip = (key: string) => schemaTooltip(key, language, schema);
  const g = (p: string[]) => getField(['memory', ...p]);
  const s = (p: string[], v: any) => setField(['memory', ...p], v);

  const BACKEND_OPTIONS = useMemo(() => [{ value: 'builtin', label: es.optBuiltin }, { value: 'qmd', label: es.optQmd }], [es]);
  const CITATIONS_OPTIONS = useMemo(() => [{ value: 'auto', label: es.optAuto }, { value: 'on', label: es.optOn }, { value: 'off', label: es.optOff }], [es]);

  return (
    <div className="space-y-4">
      <ConfigSection title={es.memoryConfig} icon="neurology" iconColor="text-sky-500">
        <SelectField label={es.memoryProvider} tooltip={tip('memory.backend')} value={g(['backend']) || 'builtin'} onChange={v => s(['backend'], v)} options={BACKEND_OPTIONS} />
        <SelectField label={es.citations} tooltip={tip('memory.citations')} value={g(['citations']) || 'auto'} onChange={v => s(['citations'], v)} options={CITATIONS_OPTIONS} />
        <TextField label={es.memSearchProvider || 'Search Provider'} tooltip={tip('memory.search.provider')} value={g(['search', 'provider']) || ''} onChange={v => s(['search', 'provider'], v)} placeholder="openai/text-embedding-3-small" />
        <TextField label={es.memSearchFallback || 'Search Fallback'} tooltip={tip('memory.search.fallback')} value={g(['search', 'fallback']) || ''} onChange={v => s(['search', 'fallback'], v)} placeholder="builtin" />
      </ConfigSection>

      <ConfigSection title={es.dreaming || 'Dreaming'} icon="bedtime" iconColor="text-indigo-500" defaultOpen={false}>
        <SwitchField label={es.dreamingEnabled || 'Enabled'} tooltip={tip('memory.dreaming.enabled')} value={g(['dreaming', 'enabled']) === true} onChange={v => s(['dreaming', 'enabled'], v)} />
        <TextField label={es.dreamingFrequency || 'Frequency'} tooltip={tip('memory.dreaming.frequency')} value={g(['dreaming', 'frequency']) || ''} onChange={v => s(['dreaming', 'frequency'], v)} placeholder="daily" />
        <NumberField label={es.dreamingRecencyHalfLife || 'Recency Half-Life (days)'} tooltip={tip('memory.dreaming.recencyHalfLifeDays')} value={g(['dreaming', 'recencyHalfLifeDays'])} onChange={v => s(['dreaming', 'recencyHalfLifeDays'], v)} min={0} />
        <NumberField label={es.dreamingMaxAge || 'Max Age (days)'} tooltip={tip('memory.dreaming.maxAgeDays')} value={g(['dreaming', 'maxAgeDays'])} onChange={v => s(['dreaming', 'maxAgeDays'], v)} min={0} />
      </ConfigSection>

      {g(['backend']) === 'qmd' && (
        <ConfigSection title={es.optQmd} icon="database" iconColor="text-sky-500" defaultOpen={false}>
          <TextField label={es.qmdCommand} tooltip={tip('memory.qmd.command')} value={g(['qmd', 'command']) || ''} onChange={v => s(['qmd', 'command'], v)} placeholder={es.phQmdCommand} />
          <TextField label={es.qmdDataPath} tooltip={tip('memory.qmd.paths.data')} value={g(['qmd', 'paths', 'data']) || ''} onChange={v => s(['qmd', 'paths', 'data'], v)} />
          <NumberField label={es.maxMemories} tooltip={tip('memory.qmd.limits.maxEntries')} value={g(['qmd', 'limits', 'maxEntries'])} onChange={v => s(['qmd', 'limits', 'maxEntries'], v)} min={1} />
          <TextField label={es.scope} tooltip={tip('memory.qmd.scope')} value={g(['qmd', 'scope']) || ''} onChange={v => s(['qmd', 'scope'], v)} placeholder={es.phMemoryScope} />
          <TextField label={es.qmdSearchMode || 'Search Mode'} tooltip={tip('memory.qmd.searchMode')} value={g(['qmd', 'searchMode']) || ''} onChange={v => s(['qmd', 'searchMode'], v)} placeholder="hybrid" />
          <TextField label={es.qmdSearchTool || 'Search Tool'} tooltip={tip('memory.qmd.searchTool')} value={g(['qmd', 'searchTool']) || ''} onChange={v => s(['qmd', 'searchTool'], v)} placeholder="auto" />
          <SwitchField label={es.qmdIncludeDefaultMemory || 'Include Default Memory'} tooltip={tip('memory.qmd.includeDefaultMemory')} value={g(['qmd', 'includeDefaultMemory']) !== false} onChange={v => s(['qmd', 'includeDefaultMemory'], v)} />
        </ConfigSection>
      )}

      <SchemaRemainder
        sectionPath="memory"
        handledKeys={[
          'backend', 'citations', 'search', 'dreaming', 'qmd',
        ]}
        config={config}
        setField={setField}
        language={language}
        schema={schema}
        title={es.schemaAdditional || 'Additional Memory Fields'}
      />
    </div>
  );
};
