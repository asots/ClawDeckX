import React, { useMemo } from 'react';
import { SectionProps } from '../sectionTypes';
import { ConfigSection, TextField, PasswordField, NumberField, SelectField, SwitchField, ArrayField, KeyValueField } from '../fields';
import { getTranslation } from '../../../locales';
import { schemaTooltip } from '../schemaTooltip';

// Options moved inside component

export const CommandsSection: React.FC<SectionProps> = ({ schema, setField, getField, language }) => {
  const es = useMemo(() => (getTranslation(language) as any).es || {}, [language]);
  const tip = (key: string) => schemaTooltip(key, language, schema);
  const g = (p: string[]) => getField(['commands', ...p]);
  const s = (p: string[], v: any) => setField(['commands', ...p], v);

  const TRISTATE = useMemo(() => [{ value: 'auto', label: es.optAuto }, { value: 'true', label: es.optTrue }, { value: 'false', label: es.optFalse }], [es]);

  return (
    <div className="space-y-4">
      <ConfigSection title={es.commandToggles} icon="toggle_on" iconColor="text-amber-500">
        <SelectField label={es.nativeCommands} desc={es.nativeCommandsDesc} tooltip={tip('commands.native')} value={String(g(['native']) ?? 'auto')} onChange={v => s(['native'], v)} options={TRISTATE} />
        <SelectField label={es.nativeSkills} tooltip={tip('commands.nativeSkills')} value={String(g(['nativeSkills']) ?? 'auto')} onChange={v => s(['nativeSkills'], v)} options={TRISTATE} />
        <SwitchField label={es.textCommands} tooltip={tip('commands.text')} value={g(['text']) !== false} onChange={v => s(['text'], v)} />
        <SwitchField label={es.bashCommands} tooltip={tip('commands.bash')} value={g(['bash']) !== false} onChange={v => s(['bash'], v)} />
        <SwitchField label={es.configCommands} tooltip={tip('commands.config')} value={g(['config']) !== false} onChange={v => s(['config'], v)} />
        <SwitchField label={es.debugCommands} tooltip={tip('commands.debug')} value={g(['debug']) === true} onChange={v => s(['debug'], v)} />
        <SwitchField label={es.restartCommand} tooltip={tip('commands.restart')} value={g(['restart']) !== false} onChange={v => s(['restart'], v)} />
      </ConfigSection>

      <ConfigSection title={es.bashConfig} icon="terminal" iconColor="text-green-500" defaultOpen={false}>
        <NumberField label={es.foregroundMs} desc="0-30000ms" tooltip={tip('commands.bashForegroundMs')} value={g(['bashForegroundMs'])} onChange={v => s(['bashForegroundMs'], v)} min={0} max={30000} step={500} />
      </ConfigSection>

      <ConfigSection title={es.accessControl} icon="admin_panel_settings" iconColor="text-red-500" defaultOpen={false}>
        <SwitchField label={es.useAccessGroups} tooltip={tip('commands.useAccessGroups')} value={g(['useAccessGroups']) === true} onChange={v => s(['useAccessGroups'], v)} />
        <ArrayField label={es.ownerAllowFrom} desc={es.ownerAllowFromDesc} tooltip={tip('commands.ownerAllowFrom')} value={(g(['ownerAllowFrom']) || []).map(String)} onChange={v => s(['ownerAllowFrom'], v)} placeholder={es.phUserId} />
        <SwitchField label={es.cmdMcp || 'Allow /mcp'} tooltip={tip('commands.mcp')} value={g(['mcp']) !== false} onChange={v => s(['mcp'], v)} />
        <SwitchField label={es.cmdPlugins || 'Allow /plugins'} tooltip={tip('commands.plugins')} value={g(['plugins']) !== false} onChange={v => s(['plugins'], v)} />
        <TextField label={es.cmdOwnerDisplay || 'Owner ID Display'} tooltip={tip('commands.ownerDisplay')} value={g(['ownerDisplay']) || ''} onChange={v => s(['ownerDisplay'], v)} />
        <PasswordField label={es.cmdOwnerDisplaySecret || 'Owner ID Hash Secret'} tooltip={tip('commands.ownerDisplaySecret')} value={g(['ownerDisplaySecret']) || ''} onChange={v => s(['ownerDisplaySecret'], v)} />
        <KeyValueField label={es.cmdAllowFrom || 'Elevated Access Rules'} tooltip={tip('commands.allowFrom')} value={g(['allowFrom']) || {}} onChange={v => s(['allowFrom'], v)} />
      </ConfigSection>
    </div>
  );
};
