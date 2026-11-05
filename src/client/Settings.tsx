import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
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
  if (!state.status) return <div role="status">{state.error ?? '正在读取连接状态…'} {state.error && <Button size="sm" onClick={() => { void controller.refresh() }}>重试</Button>}</div>
  const busy = Boolean(state.pending)
  return <div aria-label="ZCode 连接设置" aria-busy={busy} style={{ color: 'var(--dsw-alias-text-primary)', maxWidth: 720, minWidth: 0, width: '100%', fontSize: 14, lineHeight: 1.5 }}>
    {state.error && <p role="alert">{state.error}</p>}
    <div style={{ ...row, gap: 20, marginBottom: 20 }}>
      <label style={row}>
        <span>平台</span>
        <select value={selected} style={control} disabled={busy} onChange={event => setPlatform(event.target.value === 'zai' ? 'zai' : 'bigmodel')}>
          <option value="bigmodel">智谱 BigModel</option><option value="zai">Z.AI</option>
        </select>
      </label>
      <label style={row}>
        <span>套餐</span>
        <select value={selectedPlan} style={control} disabled={busy} onChange={event => setPlan(event.target.value === 'start-plan' ? 'start-plan' : 'coding-plan')}>
          <option value="coding-plan">Coding Plan</option><option value="start-plan">Start Plan</option>
        </select>
      </label>
    </div>
    <Section title="账号">
      <Account key={`${selected}:${selectedPlan}`} platform={selected} plan={selectedPlan} account={account} controller={controller} pending={state.pending} />
    </Section>
    <Section title="模型" action={<Button size="sm" variant="ghost" disabled={busy || account?.state !== 'ready'} onClick={() => { void controller.run('refreshModels', selected, selectedPlan) }}>刷新</Button>}>
      {models.length ? <><p style={{ margin: '0 0 8px' }}>在 DSH 模型选择器中选择：</p><ul style={{ margin: 0, paddingLeft: 20 }}>{models.map(model => <li key={model.id}>{model.name}</li>)}</ul></> : <p style={hint}>{account?.state === 'ready' ? '暂无可用模型，可刷新目录。' : '登录后可查看模型。'}</p>}
    </Section>
    <Section title="用量" action={<Button size="sm" variant="ghost" disabled={busy || !connected} onClick={() => { void controller.run('refreshQuota', selected, selectedPlan) }}>刷新</Button>}>
      {quota?.errorCode && <p role="status" style={hint}>用量读取失败，请刷新重试。</p>}
      {quota?.snapshot ? <Quota snapshot={quota.snapshot} /> : <p style={hint}>{connected ? '暂无用量数据。' : '登录后可查看用量。'}</p>}
    </Section>
    <Section title="Token 统计" action={<Button size="sm" variant="ghost" disabled={busy} onClick={() => { void controller.refresh() }}>刷新</Button>}>
      <Usage usage={state.status?.usage} />
    </Section>
    <p style={hint}>并发数、输出上限和请求超时可在下方插件配置中调整。</p>
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
    signed_out: '未登录', authorizing: '等待浏览器授权', ready: '已连接',
    reauth_required: '登录已失效，请重新登录', quota_exhausted: '套餐额度已用尽', error: '连接遇到问题，请重试',
  }
  const accountLabel = account?.errorCode === 'ZCODE_START_LOGIN_REQUIRED' ? '请使用网页登录 Start Plan' : label[current]
  const authorizedUrl = safeAuthorizationUrl(account?.login?.authorizeUrl)
  return <>
    <div style={spread}>
      <span role="status">{cancelling ? '正在取消登录' : initializing ? '正在准备授权' : accountLabel}{account?.accountLabel ? ` · ${account.accountLabel}` : ''}</span>
      <div style={row}>
        {authorizing ? <>
          {authorizedUrl && !initializing && !cancelling && <a href={authorizedUrl} target="_blank" rel="noopener noreferrer">打开授权页</a>}
          <Button size="sm" variant="outline" disabled={busy && !initializing} onClick={() => { setKey(''); void controller.run('cancelLogin', platform) }}>{cancelling ? '正在取消…' : '取消'}</Button>
        </> : <>
          <Button size="sm" disabled={busy} onClick={() => { setKey(''); void controller.run('beginLogin', platform) }}>{current === 'signed_out' ? '登录' : '重新登录'}</Button>
          {current !== 'signed_out' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setKey(''); void controller.run('disconnect', platform) }}>断开连接</Button>}
        </>}
      </div>
    </div>
    {current === 'authorizing' && !initializing && !cancelling && <p style={hint}>请在浏览器中完成授权，然后返回此页面。</p>}
    {plan === 'coding-plan' && <details style={{ marginTop: 16 }}>
      <summary style={{ cursor: 'pointer', fontSize: 13 }}>使用手工套餐 Key</summary>
      <form style={{ ...row, marginTop: 12 }} onSubmit={event => {
        event.preventDefault()
        if (!key.trim()) return
        void controller.setKey({ platform, key }).then(ok => { if (ok) setKey('') })
      }}>
        <label htmlFor={`zcode-key-${platform}`}>套餐 Key</label>
        <input id={`zcode-key-${platform}`} type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} style={{ ...control, flex: '1 1 220px' }} disabled={busy} />
        <Button size="sm" type="submit" disabled={busy || !key.trim()}>保存</Button>
      </form>
    </details>}
  </>
}

function Quota({ snapshot }: { snapshot: QuotaSnapshot }) {
  if (snapshot.unavailable || !snapshot.windows.length) return <p style={hint}>平台暂未提供用量信息。</p>
  return <>
    <dl style={{ margin: 0, display: 'grid', gap: 10 }}>
      {snapshot.windows.map((window, index) => <div key={`${window.name}:${index}`} style={spread}>
        <dt>{window.name}</dt><dd style={{ margin: 0 }}>
          {window.remaining !== undefined && <>{window.remaining.toLocaleString()}{window.limit !== undefined && ` / ${window.limit.toLocaleString()}`} {window.unit ?? ''}</>}
          {window.remaining === undefined && window.usedPercent !== undefined && <>已用 {window.usedPercent.toFixed(1)}%</>}
          {window.remaining === undefined && window.usedPercent === undefined && '未提供'}
          {window.resetsAt !== undefined && <span style={{ ...hint, marginLeft: 10 }}>重置于 {new Date(window.resetsAt).toLocaleString()}</span>}
        </dd>
      </div>)}
    </dl>
    <p style={hint}>更新于 {new Date(snapshot.updatedAt).toLocaleString()}</p>
  </>
}

function Usage({ usage }: { usage?: UsageSnapshot }) {
  if (!usage?.models.length) return <p style={hint}>暂无统计数据，发起一次模型调用后显示。</p>
  const labelFor = (provider: string, model: string) =>
    `${PROVIDER_DEFINITIONS.find(item => item.id === provider)?.name.replace('ZCode · ', '') ?? provider} · ${model}`
  const cell: CSSProperties = { padding: '6px 10px 6px 0', whiteSpace: 'nowrap' }
  const numeric: CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
  const columns = ['模型', '调用', '总 token', '输入', '输出', '缓存读取', '命中率']
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
          {line('合计', usage.models.reduce((sum, entry) => sum + entry.calls, 0), usage.totals, true)}
        </tbody>
      </table>
    </div>
    <p style={hint}>自插件启动以来累计；每个套餐下的每个模型单独统计。输入含缓存读取与写入，命中率按缓存读取 / 输入计算。</p>
  </>
}

function safeAuthorizationUrl(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}
