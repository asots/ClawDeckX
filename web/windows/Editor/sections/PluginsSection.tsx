import React, { useState, useMemo } from 'react';
import { SectionProps } from '../sectionTypes';
import { ConfigSection, ConfigCard, TextField, SwitchField, NumberField, ArrayField, KeyValueField, AddButton, EmptyState } from '../fields';
import { getTranslation } from '../../../locales';
import { schemaTooltip, schemaDefault } from '../schemaTooltip';

export const PluginsSection: React.FC<SectionProps> = ({ schema, setField, getField, deleteField, language }) => {
  const es = useMemo(() => (getTranslation(language) as any).es || {}, [language]);
  const tip = (key: string) => schemaTooltip(key, language, schema);
  const def = (key: string) => schemaDefault(key, schema);
  const g = (p: string[]) => getField(['plugins', ...p]);
  const s = (p: string[], v: any) => setField(['plugins', ...p], v);
  const entries = g(['entries']) || {};
  const entryKeys = Object.keys(entries);
  const installs = g(['installs']) || {};
  const pluginIds = useMemo(() => {
    const ids = new Set<string>([...Object.keys(installs), ...entryKeys]);
    return Array.from(ids).sort();
  }, [installs, entryKeys]);
  const [newPluginKey, setNewPluginKey] = useState('');

  return (
    <div className="space-y-4">
      <ConfigSection title={es.pluginSettings} icon="power" iconColor="text-rose-500">
        <SwitchField label={es.enablePlugins} tooltip={tip('plugins.enabled')} value={g(['enabled']) !== false} onChange={v => s(['enabled'], v)} />
        <ArrayField label={es.allowList} tooltip={tip('plugins.allow')} value={g(['allow']) || []} onChange={v => s(['allow'], v)} placeholder={es.phPluginName} suggestions={pluginIds} />
        <ArrayField label={es.denyList} tooltip={tip('plugins.deny')} value={g(['deny']) || []} onChange={v => s(['deny'], v)} placeholder={es.phPluginName} suggestions={pluginIds} />
      </ConfigSection>

      <ConfigSection title={es.pluginLoad || 'Plugin Loading'} icon="download" iconColor="text-rose-500" defaultOpen={false}>
        <ArrayField label={es.pluginLoadPaths || 'Extra Plugin Paths'} tooltip={tip('plugins.load.paths')} value={g(['load', 'paths']) || []} onChange={v => s(['load', 'paths'], v)} placeholder="/path/to/plugins" />
      </ConfigSection>

      <ConfigSection title={es.pluginSlots} icon="widgets" iconColor="text-rose-500" defaultOpen={false}>
        <TextField label={es.memoryPlugin} tooltip={tip('plugins.slots.memory')} value={g(['slots', 'memory']) || ''} onChange={v => s(['slots', 'memory'], v)} placeholder={es.phPluginName} />
        <TextField label={es.contextEnginePlugin || 'Context Engine Plugin'} tooltip={tip('plugins.slots.contextEngine')} value={g(['slots', 'contextEngine']) || ''} onChange={v => s(['slots', 'contextEngine'], v)} placeholder={es.phPluginName} />
      </ConfigSection>

      <ConfigSection
        title={es.pluginEntries}
        icon="extension"
        iconColor="text-rose-500"
        desc={`${entryKeys.length} ${es.pluginCount}`}
      >
        {entryKeys.length === 0 ? (
          <EmptyState message={es.noPluginEntries} icon="power_off" />
        ) : (
          entryKeys.map(key => {
            const entry = entries[key] || {};
            return (
              <ConfigCard key={key} title={key} icon="power" onDelete={() => deleteField(['plugins', 'entries', key])}>
                <SwitchField label={es.enabled} value={entry.enabled !== false} onChange={v => s(['entries', key, 'enabled'], v)} />
              </ConfigCard>
            );
          })
        )}
        <div className="flex gap-1.5 mt-2">
          <input
            type="text"
            value={newPluginKey}
            onChange={e => setNewPluginKey(e.target.value)}
            placeholder={es.pluginName}
            className="flex-1 h-8 bg-white dark:bg-black/40 border border-slate-200 dark:border-white/10 rounded-md px-3 text-[11px] font-mono text-slate-800 dark:text-slate-200 outline-none focus:border-primary"
            onKeyDown={e => {
              if (e.key === 'Enter' && newPluginKey.trim()) {
                s(['entries', newPluginKey.trim()], { enabled: true });
                setNewPluginKey('');
              }
            }}
          />
          <button
            onClick={() => { if (newPluginKey.trim()) { s(['entries', newPluginKey.trim()], { enabled: true }); setNewPluginKey(''); } }}
            className="h-8 px-3 bg-primary/10 text-primary text-[10px] font-bold rounded-md hover:bg-primary/20 transition-colors"
          >
            + {es.add}
          </button>
        </div>
      </ConfigSection>
    </div>
  );
};
