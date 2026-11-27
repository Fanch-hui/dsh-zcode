import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { t } from '../i18n/index.js'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountStatus, Plan, Platform, QuotaSnapshot, TokenUsageTotals, UsageSnapshot } from '../types.js'
import { PROVIDER_DEFINITIONS, providerFor } from '../provider/identity.js'
import type { ZCodeController } from './controller.js'

const secondary = 'var(--dsw-alias-text-secondary)'
const border = '1px solid var(--dsw-alias-border-default, color-mix(in srgb, currentColor 14%, transparent))'
const row: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }
const spread: CSSProperties = { ...row, justifyContent: 'space-between' }
const hint: CSSProperties = { color: secondary, fontSize: 12, lineHeight: 1.6, margin: '6px 0 0' }
const control: CSSProperties = { color: 'inherit', background: 'var(--dsw-alias-bg-base, transparent)', border, borderRadius: 6, padding: '7px 10px', font: 'inherit', maxWidth: '100%' }

export function Settings({ controller }: { controller: ZCodeController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [platform, setPlatform] = useState<Platform>()
  const [plan, setPlan] = useState<Plan>()
  const initialized = useRef(new Map<string, { models: boolean; quota: boolean }>())
  const selected = platform ?? state.status?.settings.platform ?? 'bigmodel'
  const selectedPlan = plan ?? state.status?.settings.plan ?? 'coding-plan'
  const account = state.status?.accounts.find(item => item.platform === selected && (item.plan ?? 'coding-plan') === selectedPlan)
  const quota = state.status?.quotas.find(item => item.platform === selected && (item.plan ?? 'coding-plan') === selectedPlan)
  const models = state.status?.models.filter(item => item.provider === providerFor(selected, selectedPlan)) ?? []
  const connected = account?.state === 'ready' || account?.state === 'quota_exhausted'
  useEffect(() => controller.watch(), [controller])
  useEffect(() => {
    if (account?.state !== 'ready' || state.pending || controller.getSnapshot().pending) return
    const key = `${selected}:${selectedPlan}:${account.generation}`
    const progress = initialized.current.get(key) ?? { models: false, quota: false }
    initialized.current.set(key, progress)
    if (!progress.models) {
      progress.models = true
      void controller.run('refreshModels', selected, selectedPlan)
    } else if (!progress.quota) {
      progress.quota = true
      void controller.run('readQuota', selected, selectedPlan)
    }
  }, [controller, selected, selectedPlan, account?.state, account?.generation, state.pending])
  if (!state.status) return <div role="status">{state.error ?? t('settings.loading')} {state.error && <Button size="sm" onClick={() => { void controller.refresh() }}>{t('settings.retry')}</Button>}</div>
  const busy = Boolean(state.pending)
  return <div aria-label={t('settings.ariaLabel')} aria-busy={busy} style={{ color: 'var(--dsw-alias-text-primary)', maxWidth: 720, minWidth: 0, width: '100%', fontSize: 14, lineHeight: 1.5 }}>
    {state.error && <p role="alert">{state.error}</p>}
    <div style={{ ...row, gap: 20, marginBottom: 20 }}>
      <label style={row}>
        <span>{t('settings.platform')}</span>
        <select value={selected} style={control} disabled={busy} onChange={event => setPlatform(event.target.value === 'zai' ? 'zai' : 'bigmodel')}>
          <option value="bigmodel">{t('platform.bigmodel')}</option><option value="zai">Z.AI</option>
        </select>
      </label>
      <label style={row}>
        <span>{t('settings.plan')}</span>
        <select value={selectedPlan} style={control} disabled={busy} onChange={event => setPlan(event.target.value === 'start-plan' ? 'start-plan' : 'coding-plan')}>
          <option value="coding-plan">Coding Plan</option><option value="start-plan">Start Plan</option>
        </select>
      </label>
    </div>
    <Section title={t('settings.account')}>
      <Account key={`${selected}:${selectedPlan}`} platform={selected} plan={selectedPlan} account={account} controller={controller} pending={state.pending} />
    </Section>
    <Section title={t('settings.models')} action={<Button size="sm" variant="ghost" disabled={busy || account?.state !== 'ready'} onClick={() => { void controller.run('refreshModels', selected, selectedPlan) }}>{t('settings.refresh')}</Button>}>
      {models.length ? <><p style={{ margin: '0 0 8px' }}>{t('settings.modelsHint')}</p><ul style={{ margin: 0, paddingLeft: 20 }}>{models.map(model => <li key={model.id}>{model.name}</li>)}</ul></> : <p style={hint}>{account?.state === 'ready' ? t('settings.modelsEmptyReady') : t('settings.modelsEmptySignedOut')}</p>}
    </Section>
    <Section title={t('settings.usage')} action={<Button size="sm" variant="ghost" disabled={busy || !connected} onClick={() => { void controller.run('refreshQuota', selected, selectedPlan) }}>{t('settings.refresh')}</Button>}>
      {quota?.errorCode && <p role="status" style={hint}>{t('settings.usageError')}</p>}
      {quota?.snapshot ? <Quota snapshot={quota.snapshot} /> : <p style={hint}>{connected ? t('settings.usageEmpty') : t('settings.usageSignedOut')}</p>}
    </Section>
    <Section title={t('settings.tokenStats')} action={<Button size="sm" variant="ghost" disabled={busy} onClick={() => { void controller.refresh() }}>{t('settings.refresh')}</Button>}>
      <Usage usage={state.status?.usage} />
    </Section>
    <p style={hint}>{t('settings.configHint')}</p>
  </div>
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section style={{ padding: '16px 0 20px', borderTop: border }}>
    <div style={{ ...spread, marginBottom: 12 }}><h3 style={{ fontSize: 14, margin: 0 }}>{title}</h3>{action}</div>{children}
  </section>
}

function Account({ platform, plan, account, controller, pending }: { platform: Platform; plan: Plan; account?: AccountStatus; controller: ZCodeController; pending?: string }) {
  const [key, setKey] = useState('')
  const current = account?.state ?? 'signed_out'
  const busy = Boolean(pending)
  const initializing = pending === 'beginLogin'
  const cancelling = pending === 'cancelLogin'
  const authorizing = current === 'authorizing' || initializing || cancelling
  const label: Record<AccountStatus['state'], string> = {
    signed_out: t('state.signed_out'), authorizing: t('state.authorizing'), ready: t('state.ready'),
    reauth_required: t('state.reauth_required'), quota_exhausted: t('state.quota_exhausted'), error: t('state.error'),
  }
  const accountLabel = account?.errorCode === 'ZCODE_START_LOGIN_REQUIRED' ? t('state.startLoginRequired') : label[current]
  const authorizedUrl = safeAuthorizationUrl(account?.login?.authorizeUrl)
  return <>
    <div style={spread}>
      <span role="status">{cancelling ? t('settings.cancelling') : initializing ? t('settings.initializing') : accountLabel}{account?.accountLabel ? ` · ${account.accountLabel}` : ''}</span>
      <div style={row}>
        {authorizing ? <>
          {authorizedUrl && !initializing && !cancelling && <a href={authorizedUrl} target="_blank" rel="noopener noreferrer">{t('settings.openAuthPage')}</a>}
          <Button size="sm" variant="outline" disabled={busy && !initializing} onClick={() => { setKey(''); void controller.run('cancelLogin', platform) }}>{cancelling ? t('settings.cancellingShort') : t('settings.cancel')}</Button>
        </> : <>
          <Button size="sm" disabled={busy} onClick={() => { setKey(''); void controller.run('beginLogin', platform) }}>{current === 'signed_out' ? t('settings.login') : t('settings.relogin')}</Button>
          {current !== 'signed_out' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setKey(''); void controller.run('disconnect', platform) }}>{t('settings.disconnect')}</Button>}
        </>}
      </div>
    </div>
    {current === 'authorizing' && !initializing && !cancelling && <p style={hint}>{t('settings.authorizeHint')}</p>}
    {plan === 'coding-plan' && <details style={{ marginTop: 16 }}>
      <summary style={{ cursor: 'pointer', fontSize: 13 }}>{t('settings.manualKey')}</summary>
      <form style={{ ...row, marginTop: 12 }} onSubmit={event => {
        event.preventDefault()
        if (!key.trim()) return
        void controller.setKey({ platform, key }).then(ok => { if (ok) setKey('') })
      }}>
        <label htmlFor={`zcode-key-${platform}`}>{t('settings.planKey')}</label>
        <input id={`zcode-key-${platform}`} type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} style={{ ...control, flex: '1 1 220px' }} disabled={busy} />
        <Button size="sm" type="submit" disabled={busy || !key.trim()}>{t('settings.save')}</Button>
      </form>
    </details>}
  </>
}

function Quota({ snapshot }: { snapshot: QuotaSnapshot }) {
  if (snapshot.unavailable || !snapshot.windows.length) return <p style={hint}>{t('quota.unavailable')}</p>
  return <>
    <dl style={{ margin: 0, display: 'grid', gap: 10 }}>
      {snapshot.windows.map((window, index) => <div key={`${window.name}:${index}`} style={spread}>
        <dt>{window.name}</dt><dd style={{ margin: 0 }}>
          {window.remaining !== undefined && <>{window.remaining.toLocaleString()}{window.limit !== undefined && ` / ${window.limit.toLocaleString()}`} {window.unit ?? ''}</>}
          {window.remaining === undefined && window.usedPercent !== undefined && <>{t('quota.used', { value: window.usedPercent.toFixed(1) })}</>}
          {window.remaining === undefined && window.usedPercent === undefined && t('quota.notProvided')}
          {window.resetsAt !== undefined && <span style={{ ...hint, marginLeft: 10 }}>{t('quota.resetsAt', { date: new Date(window.resetsAt).toLocaleString() })}</span>}
        </dd>
      </div>)}
    </dl>
    <p style={hint}>{t('quota.updatedAt', { date: new Date(snapshot.updatedAt).toLocaleString() })}</p>
  </>
}

function Usage({ usage }: { usage?: UsageSnapshot }) {
  if (!usage?.models.length) return <p style={hint}>{t('settings.statsEmpty')}</p>
  const labelFor = (provider: string, model: string) =>
    `${PROVIDER_DEFINITIONS.find(item => item.id === provider)?.name.replace('ZCode · ', '') ?? provider} · ${model}`
  const cell: CSSProperties = { padding: '6px 10px 6px 0', whiteSpace: 'nowrap' }
  const numeric: CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
  const columns = [t('settings.colModel'), t('settings.colCalls'), t('settings.colTotal'), t('settings.colInput'), t('settings.colOutput'), t('settings.colCacheRead'), t('settings.colHitRate')]
  const line = (label: string, calls: number, totals: TokenUsageTotals, bold = false) => <tr key={label} style={{ borderTop: border, ...(bold ? { fontWeight: 600 } : {}) }}>
    <td style={cell}>{label}</td>
    <td style={numeric}>{calls.toLocaleString()}</td>
    <td style={numeric}>{totals.total.toLocaleString()}</td>
    <td style={numeric}>{totals.input.toLocaleString()}</td>
    <td style={numeric}>{totals.output.toLocaleString()}</td>
    <td style={numeric}>{totals.cacheRead.toLocaleString()}</td>
    <td style={numeric}>{totals.hitRate.toFixed(1)}%</td>
  </tr>
  return <>
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%', minWidth: 560 }}>
        <thead><tr style={{ color: secondary, fontWeight: 400 }}>
          {columns.map((name, index) => <th key={name} style={{ ...cell, textAlign: index ? 'right' : 'left' }}>{name}</th>)}
        </tr></thead>
        <tbody>
          {usage.models.map(entry => line(labelFor(entry.provider, entry.model), entry.calls, entry.totals))}
          {line(t('settings.statsTotal'), usage.models.reduce((sum, entry) => sum + entry.calls, 0), usage.totals, true)}
        </tbody>
      </table>
    </div>
    <p style={hint}>{t('settings.statsHint')}</p>
  </>
}

function safeAuthorizationUrl(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}
