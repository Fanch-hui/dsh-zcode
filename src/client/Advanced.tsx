import { useEffect, useState, type CSSProperties } from 'react'
import { t } from '../i18n/index.js'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'

interface Draft { platform: string; plan: string; concurrency: string; maxTokens: string; timeoutMs: string; effort: string }
const border = '1px solid var(--dsw-alias-border-default, color-mix(in srgb, currentColor 14%, transparent))'
const control: CSSProperties = { color: 'inherit', background: 'var(--dsw-alias-bg-base, transparent)', border, borderRadius: 6, padding: '7px 10px', font: 'inherit', width: '100%', boxSizing: 'border-box' }

function toDraft(value: Record<string, unknown>): Draft {
  return {
    platform: String(value.platform ?? 'bigmodel'), plan: String(value.plan ?? 'coding-plan'), concurrency: String(value.concurrency ?? 2),
    maxTokens: String(value.maxTokens ?? 32000), timeoutMs: String(value.timeoutMs ?? 300000),
    effort: String(value.effort ?? 'high'),
  }
}

export function Advanced({ form }: { form?: ConfigPageForm }) {
  if (!form || form.state.status === 'loading') return <p role="status">{t('advanced.loading')}</p>
  if (form.state.status !== 'ready' || !form.state.value) return <p role="status">{t('advanced.unavailable')}</p>
  return <AdvancedFields form={form} />
}

function AdvancedFields({ form }: { form: ConfigPageForm }) {
  const [draft, setDraft] = useState(() => toDraft(form.state.value ?? {}))
  const [dirty, setDirty] = useState(false)
  const [revision, setRevision] = useState(form.state.revision)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string>()
  useEffect(() => {
    if (dirty || saving) return
    setDraft(toDraft(form.state.value ?? {}))
    setRevision(form.state.revision)
  }, [form.state.value, form.state.revision, dirty, saving])
  const edit = (name: keyof Draft, value: string) => { setDraft(current => ({ ...current, [name]: value })); setDirty(true); setMessage(undefined) }
  const discard = () => { setDraft(toDraft(form.state.value ?? {})); setRevision(form.state.revision); setDirty(false); setMessage(undefined) }
  const save = async () => {
    const concurrency = Number(draft.concurrency)
    const maxTokens = Number(draft.maxTokens)
    const timeoutMs = Number(draft.timeoutMs)
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 ||
      !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 1800000) {
      setMessage(t('advanced.invalidInput'))
      return
    }
    setSaving(true)
    try {
      const accepted = await form.mutate([
        { op: 'set', path: ['platform'], value: draft.platform },
        { op: 'set', path: ['plan'], value: draft.plan },
        { op: 'set', path: ['concurrency'], value: concurrency },
        { op: 'set', path: ['maxTokens'], value: maxTokens },
        { op: 'set', path: ['timeoutMs'], value: timeoutMs },
        { op: 'set', path: ['effort'], value: draft.effort },
      ], revision)
      if (!accepted) { setMessage(t('advanced.conflict')); return }
      setDirty(false)
      setMessage(t('advanced.saved'))
    } catch { setMessage(t('advanced.saveFailed')) }
    finally { setSaving(false) }
  }
  const disabled = !form.state.writable || saving
  return <form onSubmit={event => { event.preventDefault(); void save() }} aria-label={t('client.advancedTitle')} style={{ maxWidth: 520, display: 'grid', gap: 16, fontSize: 14 }}>
    <Field label={t('advanced.defaultPlatform')}><select style={control} value={draft.platform} disabled={disabled} onChange={event => edit('platform', event.target.value)}><option value="bigmodel">{t('platform.bigmodel')}</option><option value="zai">Z.AI</option></select></Field>
    <Field label={t('advanced.defaultPlan')}><select style={control} value={draft.plan} disabled={disabled} onChange={event => edit('plan', event.target.value)}><option value="coding-plan">Coding Plan</option><option value="start-plan">Start Plan</option></select></Field>
    <Field label={t('advanced.concurrency')}><input style={control} type="number" min="1" max="8" step="1" value={draft.concurrency} disabled={disabled} onChange={event => edit('concurrency', event.target.value)} /></Field>
    <Field label={t('advanced.maxTokens')}><input style={control} type="number" min="1" max="128000" step="1" value={draft.maxTokens} disabled={disabled} onChange={event => edit('maxTokens', event.target.value)} /></Field>
    <Field label={t('advanced.timeout')}><input style={control} type="number" min="10000" max="1800000" step="1000" value={draft.timeoutMs} disabled={disabled} onChange={event => edit('timeoutMs', event.target.value)} /></Field>
    <Field label={t('advanced.effort')}><select style={control} value={draft.effort} disabled={disabled} onChange={event => edit('effort', event.target.value)}><option value="low">{t('effort.low')}</option><option value="high">{t('effort.high')}</option><option value="max">{t('effort.max')}</option></select></Field>
    {!form.state.writable && <span role="status">{t('advanced.readonly')}</span>}
    {message && <span role="status">{message}</span>}
    <div style={{ display: 'flex', gap: 10 }}><Button size="sm" type="submit" disabled={disabled || !dirty}>{saving ? t('advanced.saving') : t('settings.save')}</Button><Button size="sm" type="button" variant="ghost" disabled={saving || !dirty} onClick={discard}>{t('advanced.discard')}</Button></div>
  </form>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'grid', gap: 6 }}>{label}{children}</label>
}
