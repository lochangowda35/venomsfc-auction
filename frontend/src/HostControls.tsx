import { useEffect, useState } from 'react'
import { bidBlockReason, credits, setLabels, setPool, sets } from './auction'
import { request } from './api'
import { Portrait } from './components'
import type { Action, ActionFields, AuctionEvent, AuctionState } from './types'

export function HostControls({ state, disabled, action, undo, deleteAuction, complete }: {
  state: AuctionState; disabled: boolean
  action: (name: Action, fields?: ActionFields) => Promise<boolean>; undo: () => void; deleteAuction: () => void; complete: () => void
}) {
  const [selection, setSelection] = useState('')
  const [search, setSearch] = useState('')
  const players = state.open_set ? setPool(state, state.open_set) : []
  const visible = players.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
  const running = state.status === 'running'
  const selectable = running && !state.current && !disabled && state.open_set !== null
  return <section className="panel host-controls" aria-labelledby="controls-title">
    <div className="section-heading"><div><span className="eyebrow">Host desk / Live controls</span><h2 id="controls-title">Run the room.</h2></div>
      <div className="button-row">
        {state.status === 'running' && <button className="secondary" disabled={disabled} onClick={() => void action('pause')}>Ⅱ Pause</button>}
        {state.status === 'paused' && <button disabled={disabled} onClick={() => void action('resume')}>▶ Resume</button>}
        {state.status !== 'completed' && <button className="secondary" disabled={disabled} onClick={complete}>Complete auction…</button>}
        <button className="secondary" disabled={disabled || !state.can_undo} onClick={undo}>↶ Undo latest</button>
      </div></div>
    {state.status === 'paused' && <p className="inline-warning">Auction paused. Bidding, selection and sales are locked. Resume or undo the latest action.</p>}
    {state.status === 'completed' && <p className="success-text">Auction completed. Bidding is closed; profiles and manual results can still be corrected below. All history is kept.</p>}
    <div className="set-controls" role="group" aria-labelledby="set-controls-title">
      <div className="set-controls-head"><strong id="set-controls-title">Sets</strong>
        <span className="muted">{state.open_set ? <>Open: <b>{setLabels[state.open_set]}</b></> : 'No set open · TV and spectators see every set'}</span>
        {state.open_set && <button className="text-button" disabled={disabled || !running || !!state.current} onClick={() => void action('close_set')}>Close set</button>}</div>
      <div className="set-buttons">{sets.map((set) => {
        const left = setPool(state, set).length
        const active = state.open_set === set
        return <button key={set} className={`set-button ${active ? 'active' : ''}`} aria-pressed={active}
          disabled={disabled || !running || !!state.current || active} onClick={() => void action('open_set', { set_name: set })}>
          <span>{setLabels[set]}</span><small>{left} waiting</small>
        </button>
      })}</div>
    </div>
    <div className="select-player">
      <div><label htmlFor="select-search">Find the next player</label>
        <input id="select-search" type="search" placeholder={state.open_set ? 'Filter this set…' : 'Open a set first'} value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      <div><label htmlFor="select-player">Player ({visible.length} waiting in set)</label>
        <select id="select-player" value={selection} onChange={(event) => setSelection(event.target.value)} disabled={!selectable}>
          <option value="">{state.open_set ? 'Select a player…' : 'Open a set first…'}</option>{visible.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.position}{p.status === 'unsold' ? ' · Unsold' : ''}</option>)}
        </select></div>
      <button disabled={!selectable || !visible.some((p) => p.id === Number(selection))} onClick={() => void action('select', { player_id: Number(selection) })}>Bring to floor</button>
      <button className="secondary" disabled={!selectable || !players.length} onClick={() => void action('random')}>⤨ Random from set</button>
    </div>
    <p className="muted control-help">{state.current ? 'Resolve the current player as sold or unsold before selecting another or switching sets.'
      : state.open_set ? 'Pick manually or at random from the open set. Unsold players move to the Unsold set, which you can open at the end.'
        : 'Open any set to start. You can switch or close a set whenever no player is on the floor.'}</p>
    <div className="bid-buttons">{state.teams.map((team) => {
      const reason = bidBlockReason(state, team)
      return <button className={`team-bid ${state.current?.team_id === team.id ? 'leading' : ''}`} key={team.id}
        disabled={disabled || !!reason} onClick={() => void action('bid', { team_id: team.id })} title={reason ?? `Bid ${credits((state.current?.bid ?? 0) + 10)} points`}>
        <Portrait path={team.logo_path} name={team.name} className="mini-logo" />
        <strong>{team.name}</strong><span className="bid-increment">{reason ?? `+10 · ${credits((state.current?.bid ?? 0) + 10)} points`}</span>
        <small>Max {credits(team.max_bid)} points · No squad limit</small>
      </button>
    })}</div>
    <div className="sale-actions">
      <button className="sold-button" disabled={disabled || !running || !state.current || state.current.bid < 10 || state.current.team_id === null}
        onClick={() => void action('sold')}>✓ SOLD{state.current && state.current.bid >= 10 ? ` · ${credits(state.current.bid)} points` : ''}</button>
      <button className="secondary" disabled={disabled || !running || !state.current} onClick={() => void action('unsold')}>Mark unsold</button>
    </div>
    {!!state.players.filter((p) => p.status === 'unsold').length && <details className="unsold-pool">
      <summary>Unsold pool · {state.players.filter((p) => p.status === 'unsold').length} players</summary>
      <p className="muted">Open the Unsold set to auction these players again, or return one to its position set.</p>
      {state.players.filter((p) => p.status === 'unsold').map((player) => <div className="unsold-row" key={player.id}>
        <span><strong>{player.name}</strong> <span className="position">{player.position}</span></span>
        <button className="secondary" disabled={disabled || !running || !!state.current} onClick={() => void action('reauction', { player_id: player.id })}>Return to {player.position} set</button>
      </div>)}
    </details>}
    <div className="danger-zone">
      <div><strong>Delete auction</strong><p className="muted">Start over from setup. Players, photos, teams, logos, squad size and captains are kept; sales, bids and history are cleared. A backup is saved first.</p></div>
      <button className="danger-button" disabled={disabled} onClick={deleteAuction}>Delete auction…</button>
    </div>
  </section>
}

export function ManualAssignments({ state, disabled, assign }: {
  state: AuctionState; disabled: boolean
  assign: (playerId: number, teamId: number, price: number, version: number) => void
}) {
  const [playerId, setPlayerId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [price, setPrice] = useState('10')
  const [version, setVersion] = useState(state.version)
  const player = state.players.find((p) => p.id === Number(playerId))
  const team = state.teams.find((t) => t.id === Number(teamId))
  const maximum = (team?.budget ?? 0) + (player?.team_id === team?.id ? player?.price ?? 0 : 0)
  const amount = Number(price)
  const validPrice = Number.isInteger(amount) && amount >= 10 && amount % 10 === 0 && amount <= maximum
  return <section className="panel manual-results" aria-labelledby="manual-results-title">
    <div className="section-heading"><div><span className="eyebrow">Host corrections</span><h2 id="manual-results-title">Record / move a player</h2></div></div>
    <p className="muted">Record a manual sale, move a signed player to another team, or correct their final price. The old team is refunded and the new team is charged. Existing bids stay in history. Captains keep their role and cannot replace another captain.</p>
    {state.current && <p className="inline-warning">Resolve or undo the player currently on the floor before correcting assignments.</p>}
    <form className="filters" onSubmit={(event) => {
      event.preventDefault()
      if (player && team && validPrice) assign(player.id, team.id, amount, version)
    }}>
      <label>Player to assign / move<select required value={playerId} disabled={disabled || !!state.current} onChange={(event) => {
        const next = state.players.find((p) => p.id === Number(event.target.value))
        setPlayerId(event.target.value)
        setTeamId(next?.team_id ? String(next.team_id) : '')
        setPrice(String(next?.price ?? 10))
        setVersion(state.version)
      }}><option value="">Choose a player…</option>
        {state.players.map((p) => <option key={p.id} value={p.id}>{p.name}{p.captain ? ' · Captain' : ''} · {state.teams.find((t) => t.id === p.team_id)?.name ?? p.status}</option>)}
      </select></label>
      <label>Destination team<select required value={teamId} disabled={disabled || !!state.current} onChange={(event) => setTeamId(event.target.value)}>
        <option value="">Choose a team…</option>{state.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select></label>
      <label>Final price (points)<input type="number" min="10" max={maximum || 1000} step="10" required value={price}
        disabled={disabled || !!state.current} onChange={(event) => setPrice(event.target.value)} /></label>
      <button disabled={disabled || !!state.current || !player || !team || !validPrice}>Save assignment…</button>
    </form>
    {player && <p className="muted">Currently: {state.teams.find((t) => t.id === player.team_id)?.name ?? player.status}{player.price !== null ? ` · ${credits(player.price)} points` : ''}.
      {team && <> Destination can spend up to {credits(maximum)} points, including any refund for this player.</>}</p>}
    {team && !validPrice && <p className="warning-text">Enter a multiple of 10 between 10 and {credits(maximum)} points.</p>}
  </section>
}

export function History({ version }: { version: number }) {
  const [events, setEvents] = useState<AuctionEvent[]>([])
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void request<{ events: AuctionEvent[] }>('/api/auction/history', { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) { setEvents(data.events); setError('') }
    }).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Could not load history.')
    })
    return () => controller.abort()
  }, [version, retry])
  return <section className="panel history-section" aria-labelledby="history-title">
    <div className="section-heading"><div><span className="eyebrow">Accountable by design</span><h2 id="history-title">Host audit trail</h2></div>
      <div className="button-row"><span className="muted">Newest first</span>
        <a className="button secondary backup-link" href="/api/auction/backup" download title="Save teams, players, sales, bids and history to this computer">⤓ Download backup</a></div></div>
    <p className="muted">Undo reverses only the latest reversible action. Earlier entries stay visible for the audit. Download a backup before the auction and keep it safe.</p>
    {error && <p role="alert" className="warning-text">History unavailable: {error} <button className="text-button" onClick={() => setRetry((value) => value + 1)}>Retry history</button></p>}
    {!events.length && !error && <p className="empty">Auction actions will appear here.</p>}
    <ol className="history-list">{events.map((event) => <li key={event.id} className={event.undone ? 'undone' : ''}>
      <div><strong>{event.action.replace(/_/g, ' ')}</strong><span className="muted"> #{event.id}{event.undone ? ' · REVERSED' : ''}</span>
        <p>{Object.entries(event.summary).map(([key, value]) => `${key.replace(/_/g, ' ')}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(' · ')}</p></div>
      <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time>
    </li>)}</ol>
  </section>
}
