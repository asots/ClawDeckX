import React, { useMemo } from 'react';
import { SectionProps } from '../sectionTypes';
import { ConfigSection, TextField, PasswordField, NumberField, SwitchField, SelectField, ArrayField } from '../fields';
import { getTranslation } from '../../../locales';
import { schemaTooltip, schemaDefault } from '../schemaTooltip';
import SchemaRemainder from '../SchemaRemainder';

export const CronSection: React.FC<SectionProps> = ({ config, schema, setField, getField, language }) => {
  const es = useMemo(() => (getTranslation(language) as any).es || {}, [language]);
  const tip = (key: string) => schemaTooltip(key, language, schema);
  const def = (key: string) => schemaDefault(key, schema);
  const g = (p: string[]) => getField(['cron', ...p]);
  const s = (p: string[], v: any) => setField(['cron', ...p], v);

  const WAKE_OPTIONS = useMemo(() => [
    { value: 'now', label: es.optNow },
    { value: 'next-heartbeat', label: es.optNextHeartbeat }
  ], [es]);

  return (
    <div className="space-y-4">
      <ConfigSection title={es.cronJobs} icon="schedule" iconColor="text-lime-500">
        <SwitchField label={es.enabled} tooltip={tip('cron.enabled')} value={g(['enabled']) !== false} onChange={v => s(['enabled'], v)} />
        <TextField label={es.cronStorePath} tooltip={tip('cron.store')} value={g(['store']) || ''} onChange={v => s(['store'], v)} placeholder={es.phCronStorePath} />
        <NumberField label={es.maxConcurrent} tooltip={tip('cron.maxConcurrentRuns')} value={g(['maxConcurrentRuns'])} onChange={v => s(['maxConcurrentRuns'], v)} min={1} placeholder={def('cron.maxConcurrentRuns')} />
        <SelectField label={es.cronWakeMode} tooltip={tip('cron.wakeMode')} value={g(['wakeMode']) || 'now'} onChange={v => s(['wakeMode'], v)} options={WAKE_OPTIONS} />
        <SwitchField label={es.cronLightContext || 'Light Context'} tooltip={tip('cron.lightContext')} value={g(['lightContext']) === true} onChange={v => s(['lightContext'], v)} />
        <TextField label={es.cronSessionRetention || 'Session Retention'} tooltip={tip('cron.sessionRetention')} value={String(g(['sessionRetention']) ?? '')} onChange={v => s(['sessionRetention'], v)} placeholder="7d" />
        <PasswordField label={es.cronWebhookToken || 'Webhook Token'} tooltip={tip('cron.webhookToken')} value={g(['webhookToken']) || ''} onChange={v => s(['webhookToken'], v)} />
      </ConfigSection>

      <ConfigSection title={es.cronRetry || 'Retry Policy'} icon="replay" iconColor="text-orange-500" defaultOpen={false}>
        <NumberField label={es.cronRetryMaxAttempts || 'Max Attempts'} tooltip={tip('cron.retry.maxAttempts')} value={g(['retry', 'maxAttempts'])} onChange={v => s(['retry', 'maxAttempts'], v)} min={0} placeholder={def('cron.retry.maxAttempts')} />
        <NumberField label={es.cronRetryBackoffMs || 'Backoff (ms)'} tooltip={tip('cron.retry.backoffMs')} value={g(['retry', 'backoffMs'])} onChange={v => s(['retry', 'backoffMs'], v)} min={0} step={100} placeholder={def('cron.retry.backoffMs')} />
        <ArrayField label={es.cronRetryOn || 'Retry On Error Types'} tooltip={tip('cron.retry.retryOn')} value={g(['retry', 'retryOn']) || []} onChange={v => s(['retry', 'retryOn'], v)} placeholder="timeout" />
      </ConfigSection>

      <ConfigSection title={es.cronRunLog || 'Run Log Pruning'} icon="description" iconColor="text-slate-500" defaultOpen={false}>
        <NumberField label={es.cronRunLogMaxBytes || 'Max Bytes'} tooltip={tip('cron.runLog.maxBytes')} value={g(['runLog', 'maxBytes'])} onChange={v => s(['runLog', 'maxBytes'], v)} min={0} placeholder={def('cron.runLog.maxBytes')} />
        <NumberField label={es.cronRunLogKeepLines || 'Keep Lines'} tooltip={tip('cron.runLog.keepLines')} value={g(['runLog', 'keepLines'])} onChange={v => s(['runLog', 'keepLines'], v)} min={0} placeholder={def('cron.runLog.keepLines')} />
      </ConfigSection>

      <SchemaRemainder
        sectionPath="cron"
        handledKeys={[
          'enabled', 'store', 'maxConcurrentRuns', 'wakeMode',
          'lightContext', 'sessionRetention', 'webhookToken',
          'retry', 'runLog',
        ]}
        config={config}
        setField={setField}
        language={language}
        schema={schema}
        title={es.schemaAdditional || 'Additional Cron Fields'}
      />
    </div>
  );
};
