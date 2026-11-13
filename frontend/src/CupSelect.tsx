import { useEffect, useId, useRef, useState } from 'react'
import type { SelectHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'

type Choice = { value: string; label: string; disabled: boolean }
type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'multiple'> & {
  onChange: (change: { target: { value: string } }) => void
}

export function CupSelect({ children, onChange, disabled, ...props }: SelectProps) {
  const select = useRef<HTMLSelectElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const [popup, setPopup] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [choices, setChoices] = useState<Choice[]>([])
  const [highlighted, setHighlighted] = useState(0)
  const search = useRef({ text: '', at: 0 })

  function open() {
    const element = select.current
    if (!element || element.matches(':disabled')) return
    const rows = Array.from(element.options, (option) => ({
      value: option.value, label: option.label, disabled: option.disabled,
    }))
    if (!rows.length) return
    const rect = element.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - 12
    const height = Math.min(280, Math.max(below, rect.top - 12))
    setChoices(rows)
    setHighlighted(Math.max(0, rows.findIndex((row) => row.value === element.value)))
    setPopup({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
      top: below >= height ? rect.bottom + 4 : Math.max(8, rect.top - height - 4),
      width: Math.min(rect.width, window.innerWidth - 16), height,
    })
    element.focus()
  }

  function choose(index: number) {
    const row = choices[index]
    if (!row || row.disabled || select.current?.matches(':disabled')) return
    setPopup(null)
    onChange({ target: { value: row.value } })
    select.current?.focus()
  }

  useEffect(() => {
    if (!popup) return
    function dismiss(event: Event) {
      if (event.target instanceof Node && (menu.current?.contains(event.target) || event.target === select.current)) return
      setPopup(null)
    }
    const resize = () => setPopup(null)
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', resize)
    }
  }, [popup])

  useEffect(() => {
    if (popup) document.getElementById(`${id}-${highlighted}`)?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, id, popup])

  return <>
    <select {...props} ref={select} disabled={disabled}
      aria-expanded={Boolean(popup && !disabled)} aria-controls={popup ? id : undefined}
      aria-activedescendant={popup ? `${id}-${highlighted}` : undefined}
      onChange={(event) => { setPopup(null); onChange(event) }}
      onPointerDown={(event) => {
        event.preventDefault()
        if (popup) setPopup(null)
        else open()
      }}
      onClick={(event) => {
        event.preventDefault()
        if (event.detail === 0) open()
      }}
      onBlur={() => setPopup(null)}
      onKeyDown={(event) => {
        if (!popup) {
          if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault()
            open()
          }
          return
        }
        if (['Escape', 'Tab'].includes(event.key)) {
          setPopup(null)
          if (event.key === 'Escape') event.preventDefault()
        } else if (['Enter', ' '].includes(event.key)) {
          event.preventDefault()
          choose(highlighted)
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const enabled = choices.flatMap((row, index) => row.disabled ? [] : [index])
          const current = enabled.indexOf(highlighted)
          const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1)
            : enabled[(current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]
          if (next !== undefined) setHighlighted(next)
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault()
          const text = `${Date.now() - search.current.at < 700 ? search.current.text : ''}${event.key}`.toLocaleLowerCase()
          search.current = { text, at: Date.now() }
          const next = choices.findIndex((row) => !row.disabled && row.label.toLocaleLowerCase().startsWith(text))
          if (next >= 0) setHighlighted(next)
        }
      }}>
      {children}
    </select>
    {popup && !disabled && createPortal(<div ref={menu} id={id} role="listbox"
      aria-label={props['aria-label'] ?? (Array.from(select.current?.labels?.[0]?.childNodes ?? [])
        .filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim() || 'Choices')}
      className="cup-select-menu"
      style={{ left: popup.left, top: popup.top, width: popup.width, maxHeight: popup.height }}
      onPointerDown={(event) => event.preventDefault()}>
      {choices.map((row, index) => <div key={`${row.value}:${index}`} id={`${id}-${index}`}
        role="option" aria-selected={String(props.value) === row.value} aria-disabled={row.disabled || undefined}
        data-highlighted={index === highlighted} onPointerMove={(event) => {
          if (event.pointerType === 'mouse') setHighlighted(index)
        }}
        onClick={() => choose(index)}>
        <span>{row.label}</span>{String(props.value) === row.value && <span aria-hidden="true">✓</span>}
      </div>)}
    </div>, document.body)}
  </>
}

export function CupDateTime({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [date = '', time = '00:00'] = value.split('T')
  const [hour, minute] = time.split(':').map(Number)
  const update = (day: string, hours: number, minutes: number) =>
    onChange(day ? `${day}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` : '')
  return <fieldset className="cup-datetime"><legend>{label}</legend>
    <label>Date<input type="date" aria-label={`${label} date`} value={date}
      onChange={(event) => update(event.target.value, hour, minute)} /></label>
    <label>Hour<CupSelect aria-label={`${label} hour`} value={hour % 12 || 12}
      onChange={(event) => update(date, Number(event.target.value) % 12 + (hour >= 12 ? 12 : 0), minute)}>
      {Array.from({ length: 12 }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
    </CupSelect></label>
    <label>Minute<CupSelect aria-label={`${label} minute`} value={minute}
      onChange={(event) => update(date, hour, Number(event.target.value))}>
      {Array.from({ length: 60 }, (_, index) => <option key={index} value={index}>{String(index).padStart(2, '0')}</option>)}
    </CupSelect></label>
    <label>AM/PM<CupSelect aria-label={`${label} AM/PM`} value={hour >= 12 ? 'PM' : 'AM'}
      onChange={(event) => update(date, hour % 12 + (event.target.value === 'PM' ? 12 : 0), minute)}>
      <option value="AM">AM</option><option value="PM">PM</option>
    </CupSelect></label>
  </fieldset>
}
