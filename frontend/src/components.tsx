import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { mediaPath, portraitPath } from './auction'

export function Portrait({ path, name, className = '' }: { path: string; name: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [path])
  return <div className={`portrait ${className}`}>
    {mediaPath.test(path) && !failed
      ? <img src={portraitPath(path)} alt={name} onError={() => setFailed(true)} loading="lazy" />
      : <div className="portrait-fallback" aria-label={`${name}: image unavailable`}>
        <span>{name.trim().slice(0, 2).toUpperCase() || 'FC'}</span>
        <small>Image unavailable</small>
      </div>}
  </div>
}

export function ImageField({ id, label, existing, file, onChange, disabled }: {
  id: string; label: string; existing: string; file: File | null
  onChange: (file: File | null) => void; disabled: boolean
}) {
  const [preview, setPreview] = useState('')
  const [invalid, setInvalid] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
    if (!file) { setPreview(''); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file, existing])
  const source = preview || (mediaPath.test(existing) ? existing : '')
  return <div className="image-field">
    <label htmlFor={id}>{label} <span className="muted">(JPG, PNG, WebP · max 5 MB)</span></label>
    <div className="upload-row">
      {source && !failed
        ? <img className="upload-preview" src={source} alt={`${label} preview`} onError={() => setFailed(true)} />
        : <div className="upload-placeholder" aria-hidden="true">＋</div>}
      <input id={id} type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled}
        aria-describedby={`${id}-help`} onChange={(event) => {
          const selected = event.target.files?.[0] ?? null
          if (selected && (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type) || selected.size > 5 * 1024 * 1024)) {
            setInvalid('Choose a JPG, PNG, or WebP image no larger than 5 MB.')
            event.target.value = ''
            onChange(null)
          } else { setInvalid(''); onChange(selected) }
        }} />
    </div>
    <small id={`${id}-help`} className={invalid || failed || !source ? 'warning-text' : 'muted'}>
      {invalid || (failed || !source ? 'Upload an image. Missing / old demo images must be re-uploaded.' : file ? `${file.name} · ready to upload when saved` : 'Current image. Select a file to replace it.')}
    </small>
  </div>
}

export function ConfirmDialog({ title, children, confirm, onConfirm, onClose, requireText, danger = false }: {
  title: string; children: ReactNode; confirm: string; onConfirm: () => void; onClose: () => void
  requireText?: string; danger?: boolean
}) {
  const [typed, setTyped] = useState('')
  const locked = requireText !== undefined && typed !== requireText
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = document.getElementById('confirmation-dialog') as HTMLDialogElement
    dialog.showModal()
    return () => {
      dialog.close()
      previous?.focus()
    }
  }, [])
  return <dialog id="confirmation-dialog" aria-labelledby="confirmation-title" onCancel={onClose}
    onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="dialog-content">
      <span className="eyebrow">Please confirm</span>
      <h2 id="confirmation-title">{title}</h2>
      <div>{children}</div>
      {requireText !== undefined && <label className="confirm-type">Type <b>{requireText}</b> to confirm
        <input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} aria-label={`Type ${requireText} to confirm`} /></label>}
      <div className="button-row">
        <button autoFocus className="secondary" onClick={onClose}>Cancel</button>
        <button className={danger ? 'danger-button' : undefined} disabled={locked} onClick={() => { onClose(); onConfirm() }}>{confirm}</button>
      </div>
    </div>
  </dialog>
}

export function Login({ disabled, onSubmit, tv = false }: {
  disabled: boolean; onSubmit: (password: string) => Promise<void>; tv?: boolean
}) {
  const [password, setPassword] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    await onSubmit(password)
    setPassword('')
  }
  return <section className="panel login-panel" aria-labelledby="login-title">
    <img className="login-crest" src="/api/branding/venoms-fc.jpg" alt="Official Venoms FC crest" />
    <span className="eyebrow">Host access</span>
    <h1 id="login-title">{tv ? 'The big screen. Host access only.' : 'Your auction. Your control.'}</h1>
    <p className="muted">Sign in with the host password to access the host desk and private TV display. Visitors can watch the public spectator view without signing in.</p>
    <form onSubmit={(event) => void submit(event)}>
      <label htmlFor="host-password">Host password</label>
      <input id="host-password" type="password" autoComplete="current-password" required value={password}
        onChange={(event) => setPassword(event.target.value)} disabled={disabled} />
      <button disabled={disabled || !password} type="submit">{disabled ? 'Please wait…' : tv ? 'Unlock TV display →' : 'Enter host desk →'}</button>
    </form>
    <a className="back-to-spectator" href="/">Back to spectator view</a>
  </section>
}
