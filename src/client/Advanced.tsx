import { useEffect, useState, type CSSProperties } from 'react'
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
  if (!form || form.state.status === 'loading') return <p role="status">正在读取配置…</p>
  if (form.state.status !== 'ready' || !form.state.value) return <p role="status">当前配置不可用。</p>
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
      setMessage('请输入有效的并发数、输出上限和超时时间。')
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
      if (!accepted) { setMessage('配置未保存。请检查其他位置的更改，放弃当前修改后重试。'); return }
      setDirty(false)
      setMessage('配置已保存。')
    } catch { setMessage('保存失败，请检查连接后重试。') }
    finally { setSaving(false) }
  }
  const disabled = !form.state.writable || saving
  return <form onSubmit={event => { event.preventDefault(); void save() }} aria-label="ZCode 高级设置" style={{ maxWidth: 520, display: 'grid', gap: 16, fontSize: 14 }}>
    <Field label="默认平台"><select style={control} value={draft.platform} disabled={disabled} onChange={event => edit('platform', event.target.value)}><option value="bigmodel">智谱 BigModel</option><option value="zai">Z.AI</option></select></Field>
    <Field label="默认套餐"><select style={control} value={draft.plan} disabled={disabled} onChange={event => edit('plan', event.target.value)}><option value="coding-plan">Coding Plan</option><option value="start-plan">Start Plan</option></select></Field>
    <Field label="并发请求数"><input style={control} type="number" min="1" max="8" step="1" value={draft.concurrency} disabled={disabled} onChange={event => edit('concurrency', event.target.value)} /></Field>
    <Field label="单次输出上限"><input style={control} type="number" min="1" max="128000" step="1" value={draft.maxTokens} disabled={disabled} onChange={event => edit('maxTokens', event.target.value)} /></Field>
    <Field label="请求超时（毫秒）"><input style={control} type="number" min="10000" max="1800000" step="1000" value={draft.timeoutMs} disabled={disabled} onChange={event => edit('timeoutMs', event.target.value)} /></Field>
    <Field label="思考强度"><select style={control} value={draft.effort} disabled={disabled} onChange={event => edit('effort', event.target.value)}><option value="low">低</option><option value="high">高</option><option value="max">最高</option></select></Field>
    {!form.state.writable && <span role="status">当前配置为只读。</span>}
    {message && <span role="status">{message}</span>}
    <div style={{ display: 'flex', gap: 10 }}><Button size="sm" type="submit" disabled={disabled || !dirty}>{saving ? '保存中…' : '保存'}</Button><Button size="sm" type="button" variant="ghost" disabled={saving || !dirty} onClick={discard}>放弃修改</Button></div>
  </form>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'grid', gap: 6 }}>{label}{children}</label>
}
