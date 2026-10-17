import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { credits, portraitPath } from './auction'
import { Portrait } from './components'
import { playSold, playUnsold } from './sound'
import type { AuctionState } from './types'

const SOLD_MS = 15000
const UNSOLD_MS = 5000

/** Average the vivid pixels of a same-origin logo so each team gets its own burst colour. */
function useLogoColour(path: string | undefined) {
  const [colour, setColour] = useState<string | null>(null)
  useEffect(() => {
    setColour(null)
    if (!path) return
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 32
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return
        context.drawImage(image, 0, 0, 32, 32)
        const data = context.getImageData(0, 0, 32, 32).data
        let r = 0, g = 0, b = 0, count = 0
        for (let i = 0; i < data.length; i += 4) {
          const max = Math.max(data[i], data[i + 1], data[i + 2])
          const min = Math.min(data[i], data[i + 1], data[i + 2])
          if (data[i + 3] < 200 || max < 70 || max - min < 45) continue
          r += data[i]; g += data[i + 1]; b += data[i + 2]; count++
        }
        if (count > 12) setColour(`rgb(${Math.round(r / count)} ${Math.round(g / count)} ${Math.round(b / count)})`)
      } catch { /* Fall back to the theme accent. */ }
    }
    image.src = portraitPath(path)
  }, [path])
  return colour
}

type Moment = { key: string; playerId: number; kind: 'sold' | 'unsold' }

function newlyIn(previous: Set<number>, now: Set<number>) {
  return [...now].filter((id) => !previous.has(id))
}

/** Full-screen SOLD (15s) and UNSOLD (5s) moments for the TV and spectator views. Never shown for results already present on first load. */
export function SoldCelebration({ state, sound = false }: { state: AuctionState; sound?: boolean }) {
  const known = useRef<{ sold: Set<number>; unsold: Set<number> } | null>(null)
  const [moment, setMoment] = useState<Moment | null>(null)
  useEffect(() => {
    const sold = new Set(state.players.filter((p) => p.status === 'sold' && !p.captain).map((p) => p.id))
    const unsold = new Set(state.players.filter((p) => p.status === 'unsold').map((p) => p.id))
    const previous = known.current
    known.current = { sold, unsold }
    if (!previous) return
    const lastId = state.last_event?.player_id
    const freshSold = newlyIn(previous.sold, sold)
    if (freshSold.length) {
      const id = lastId && freshSold.includes(lastId) ? lastId : freshSold[freshSold.length - 1]
      setMoment({ key: `sold-${id}-${state.version}`, playerId: id, kind: 'sold' })
      return
    }
    const freshUnsold = newlyIn(previous.unsold, unsold)
    if (freshUnsold.length) {
      const id = lastId && freshUnsold.includes(lastId) ? lastId : freshUnsold[freshUnsold.length - 1]
      setMoment({ key: `unsold-${id}-${state.version}`, playerId: id, kind: 'unsold' })
    }
  }, [state])
  useEffect(() => {
    if (!moment) return
    if (sound) {
      if (moment.kind === 'sold') playSold()
      else playUnsold()
    }
    const timer = window.setTimeout(() => setMoment(null), moment.kind === 'sold' ? SOLD_MS : UNSOLD_MS)
    return () => window.clearTimeout(timer)
    // Sound is read when a new moment starts; toggling it must not replay the moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moment])
  const player = moment ? state.players.find((p) => p.id === moment.playerId) : undefined
  const team = player && moment?.kind === 'sold' ? state.teams.find((t) => t.id === player.team_id) : undefined
  const colour = useLogoColour(team?.logo_path)
  if (!moment || !player || player.status !== moment.kind) return null
  if (moment.kind === 'unsold') {
    const style = { '--team-colour': '#7f93ad', '--show': `${UNSOLD_MS}ms` } as CSSProperties
    return <div key={moment.key} className="sold-celebration is-unsold" style={style} role="status" aria-live="assertive"
      onClick={() => setMoment(null)} title="Click to close">
      <div className="sold-card">
        <Portrait path={player.photo_path} name={player.name} className="sold-photo" />
        <div className="sold-copy">
          <span className="sold-stamp">UNSOLD</span>
          <h2>{player.name}</h2>
          <p className="sold-price">No bids taken · moves to the <b>Unsold</b> set</p>
        </div>
      </div>
    </div>
  }
  if (!team) return null
  const style = { '--team-colour': colour ?? 'var(--accent)', '--show': `${SOLD_MS}ms` } as CSSProperties
  return <div key={moment.key} className="sold-celebration" style={style} role="status" aria-live="assertive"
    onClick={() => setMoment(null)} title="Click to close">
    <div className="sold-burst" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</div>
    <div className="sold-card">
      <Portrait path={player.photo_path} name={player.name} className="sold-photo" />
      <div className="sold-copy">
        <span className="sold-stamp">SOLD</span>
        <h2>{player.name}</h2>
        <div className="sold-team">
          <Portrait path={team.logo_path} name={team.name} className="sold-team-logo" />
          <div><span className="eyebrow">Signs for</span><strong>{team.name}</strong></div>
        </div>
        <p className="sold-price"><b>{credits(player.price ?? 0)}</b> points</p>
      </div>
    </div>
  </div>
}