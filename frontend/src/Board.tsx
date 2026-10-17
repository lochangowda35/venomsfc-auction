import { useEffect, useRef, useState } from 'react'
import { credits, eventDescription, positions, resultsCsv } from './auction'
import { Portrait } from './components'
import type { AuctionState } from './types'

export const CaptainBadge = () => <span className="captain-badge" title="Captain" aria-label="Captain">C</span>

export function Stage({ state }: { state: AuctionState }) {
  const player = state.players.find((p) => p.id === state.current?.player_id)
  const leader = state.teams.find((t) => t.id === state.current?.team_id)
  return <>
    {state.status !== 'setup' && <div className={`event-banner event-${state.last_event?.action ?? 'welcome'}`} role="status" aria-live="polite" aria-atomic="true">
      <span className="eyebrow">Latest from the floor</span><strong>{eventDescription(state)}</strong>
    </div>}
    <section className={`stage ${state.status === 'setup' ? 'stage-setup' : ''} ${state.status === 'paused' ? 'stage-paused' : ''}`} aria-labelledby="stage-title">
      <div className="stage-player">
        {player && <Portrait path={player.photo_path} name={player.name} className="hero-portrait" />}
        <div className="stage-copy">
          <span className="eyebrow">{state.status === 'paused' ? 'Timeout / bidding paused' : state.status === 'completed' ? 'Final whistle' : player ? 'On the block' : 'Venoms FC / Auction day'}</span>
          <h1 id="stage-title">{player ? player.name : state.status === 'setup' ? 'The next chapter starts here.' : state.status === 'completed' ? 'Squads complete.' : 'Who’s up next?'}</h1>
          {player ? <p><span className="position">{player.position}</span><span className="muted"> Player #{player.id}</span></p>
            : <p className="muted">{state.status === 'setup' ? 'The host is preparing the clubs and player pool. This screen updates automatically.' : state.status === 'completed' ? 'Every squad is full. Explore the final rosters and auction results below.' : 'Waiting for the host to bring the next player into the spotlight.'}</p>}
        </div>
      </div>
      {player && <div className="bid-display">
        <span className="eyebrow">{state.current?.bid ? 'Current bid' : 'Opening bid'}</span>
        <div className="bid-number">{credits(state.current?.bid || 10)}<span>points</span></div>
        <div className="leader">
          {leader && <Portrait path={leader.logo_path} name={leader.name} className="leader-logo" />}
          <div className="leader-copy">{leader && <span className="eyebrow">Leading bid</span>}<strong>{leader?.name ?? 'Waiting for the first bid'}</strong></div>
        </div>
        <small className="muted">{state.status === 'paused' ? 'Bidding is locked until the host resumes.' : 'Bids move in increments of 10 points.'}</small>
      </div>}
    </section>
  </>
}

export function TeamBoard({ state, onOpen, compact = false }: { state: AuctionState; onOpen?: (id: number) => void; compact?: boolean }) {
  return <section className={`rosters-section ${compact ? 'squad-compact' : ''}`} aria-labelledby="rosters-title">
    <div className="section-heading"><div><span className="eyebrow">The clubs</span><h2 id="rosters-title">Squad watch</h2></div>
      <span className="muted">{state.squad_size} players / team</span></div>
    {!state.teams.length && <div className="panel empty">Clubs will appear here once the host adds them.</div>}
    <div className="team-grid">{state.teams.map((team) => <article key={team.id} className={`team-card ${state.current?.team_id === team.id ? 'is-leading' : ''} ${onOpen ? 'is-clickable' : ''}`}>
      <div className="team-card-heading"><Portrait path={team.logo_path} name={team.name} className="team-logo" />
        <div><h3>{onOpen
          ? <button type="button" className="team-open" data-team-id={team.id} onClick={() => onOpen(team.id)} aria-label={`View ${team.name} squad and details`}>{team.name}</button>
          : team.name}</h3><span className="muted">{team.remaining_slots === 0 ? '✓ Squad full' : `${team.roster.length} / ${state.squad_size} signed`}</span></div>
        {state.current?.team_id === team.id && <span className="tag">Leading</span>}</div>
      <div className="team-money"><div><span>Remaining</span><strong>{credits(team.budget)} <small>points</small></strong></div>
        <div><span>Max bid</span><strong>{credits(team.max_bid)} <small>points</small></strong><small className="reserve-hint">10 reserved per open slot</small></div></div>
      <div className="squad-meter" aria-label={`${team.roster.length} of ${state.squad_size} places filled`}><span style={{ width: `${Math.min(100, team.roster.length / state.squad_size * 100)}%` }} /></div>
      {compact ? <ul className="roster-chips" aria-label={`${team.name} squad`}>
        {!team.roster.length && <li className="muted empty-chip">No signings yet</li>}
        {team.roster.map((player) => <li key={player.id}>{player.captain && <CaptainBadge />}<span>{player.name}</span><b>{credits(player.price)}</b></li>)}
      </ul> : <>
      <div className="roster-list">
        {!team.roster.length && <p className="empty compact">The first signing is still to come.</p>}
        {team.roster.map((player) => <div key={player.id} className="roster-player">
          <Portrait path={player.photo_path} name={player.name} className="mini-photo" />
          <div><strong>{player.name}{player.captain && <CaptainBadge />}</strong><small className="muted">{player.position}{player.captain ? ' · Captain' : ''}</small></div><b>{credits(player.price)} <small>points</small></b>
        </div>)}
      </div>
      <div className="team-footer">Spent {credits(team.spent)} / {credits(team.budget + team.spent)} points <span>{onOpen ? <span className="team-open-hint" aria-hidden="true">View squad →</span> : `${team.remaining_slots} open slots`}</span></div>
      </>}
    </article>)}</div>
  </section>
}

export function TeamDetail({ state, teamId, onBack, onOpen, onPlayer }: {
  state: AuctionState; teamId: number; onBack: () => void; onOpen: (id: number) => void; onPlayer: (id: number) => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const team = state.teams.find((t) => t.id === teamId)
  useEffect(() => { heading.current?.focus() }, [teamId])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) onBack() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onBack])
  if (!team) return <section className="panel team-detail" aria-labelledby="team-detail-title">
    <button type="button" className="secondary team-back" onClick={onBack}>← All teams</button>
    <h1 id="team-detail-title" ref={heading} tabIndex={-1}>Team not found</h1>
    <p className="muted">This club is not part of the current auction.</p>
  </section>
  const bidding = state.current?.team_id === team.id ? state.players.find((p) => p.id === state.current?.player_id) : undefined
  const counts = positions.map((position) => [position, team.roster.filter((p) => p.position === position).length] as const)
  const openSlots = Array.from({ length: Math.max(0, team.remaining_slots) })
  const total = team.budget + team.spent
  const captain = team.roster.find((p) => p.captain)
  return <section className="team-detail" aria-labelledby="team-detail-title">
    <nav className="team-detail-nav" aria-label="Teams">
      <button type="button" className="secondary team-back" onClick={onBack}>← All teams</button>
      <div className="team-switcher">{state.teams.map((t) => <button type="button" key={t.id} className={t.id === team.id ? 'active' : ''}
        aria-current={t.id === team.id ? 'page' : undefined} onClick={() => onOpen(t.id)} title={t.name}>
        <Portrait path={t.logo_path} name={t.name} className="switch-logo" /><span>{t.name}</span></button>)}</div>
    </nav>
    <div className="panel team-detail-hero">
      <Portrait path={team.logo_path} name={team.name} className="team-detail-logo" />
      <div className="team-detail-title">
        <span className="eyebrow">Internal team · Squad profile</span>
        <h1 id="team-detail-title" ref={heading} tabIndex={-1}>{team.name}</h1>
        <p className="muted">{team.remaining_slots === 0 ? '✓ Squad complete' : `${team.roster.length} of ${state.squad_size} players signed · ${team.remaining_slots} open ${team.remaining_slots === 1 ? 'slot' : 'slots'}`}</p>
        {bidding && <p className="tag team-leading-tag">Leading bid · {credits(state.current?.bid ?? 0)} points for {bidding.name}</p>}
      </div>
      <dl className="team-detail-stats">
        <div><dt>Remaining</dt><dd>{credits(team.budget)} <small>points</small></dd></div>
        <div><dt>Spent</dt><dd>{credits(team.spent)} <small>/ {credits(total)}</small></dd></div>
        <div><dt>Max bid</dt><dd>{credits(team.max_bid)} <small>points</small></dd><small className="reserve-hint">10 reserved per open slot</small></div>
        <div><dt>Squad</dt><dd>{team.roster.length} <small>/ {state.squad_size}</small></dd></div>
      </dl>
      <div className="squad-meter" aria-label={`${team.roster.length} of ${state.squad_size} places filled`}><span style={{ width: `${state.squad_size ? Math.min(100, team.roster.length / state.squad_size * 100) : 0}%` }} /></div>
      <ul className="position-counts" aria-label="Players by position">{counts.map(([position, count]) => <li key={position}><b>{count}</b> {position}</li>)}</ul>
    </div>
    {captain && <p className="team-captain"><CaptainBadge /> Captain <strong>{captain.name}</strong> · {captain.position} · {credits(captain.price)} points</p>}
    <div className="section-heading"><div><span className="eyebrow">The squad</span><h2>Signed players <span className="count">{team.roster.length}</span></h2></div></div>
    <div className="squad-grid">
      {team.roster.map((player) => <button type="button" key={player.id} className={`squad-player ${player.captain ? 'is-captain' : ''}`}
        onClick={() => onPlayer(player.id)} aria-label={`${player.name}: view details${player.captain ? '' : ' and bid history'}`}>
        <Portrait path={player.photo_path} name={player.name} className="squad-photo" />
        <div><span className={`position-pill pos-${player.position.toLowerCase()}`}>{player.position}</span>{player.captain && <CaptainBadge />}<h3>{player.name}</h3>
          <p><b>{credits(player.price)}</b> points{player.captain ? ' · Captain' : ''}</p></div>
      </button>)}
      {openSlots.map((_, index) => <div key={`open-${index}`} className="squad-player open-slot" aria-label="Open squad slot"><span>Open slot</span><small>Still to sign</small></div>)}
    </div>
    {!team.roster.length && <p className="empty">No signings yet. Players bought by {team.name} will appear here live.</p>}
  </section>
}

function download(state: AuctionState) {
  const url = URL.createObjectURL(new Blob([resultsCsv(state.players, state.teams)], { type: 'text/csv;charset=utf-8;' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'venoms-auction-results.csv'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function Results({ state, onPlayer }: { state: AuctionState; onPlayer: (id: number) => void }) {
  const [status, setStatus] = useState('')
  const [position, setPosition] = useState('')
  const [search, setSearch] = useState('')
  const filtered = state.players.filter((p) => (!status || p.status === status) && (!position || p.position === position) && p.name.toLowerCase().includes(search.toLowerCase()))
  return <section className="panel results-section" aria-labelledby="results-title">
    <div className="section-heading"><div><span className="eyebrow">Every player. Every outcome.</span><h2 id="results-title">Auction tracker <span className="count">{state.players.length}</span></h2></div>
      <button className="secondary" disabled={!state.players.length} onClick={() => download(state)}>↓ Download CSV</button></div>
    <div className="filters">
      <label>Search player<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search names…" /></label>
      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>
        {['available', 'current', 'sold', 'unsold'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select></label>
      <label>Position<select value={position} onChange={(event) => setPosition(event.target.value)}><option value="">All positions</option>{positions.map((p) => <option key={p}>{p}</option>)}</select></label>
    </div>
    {!filtered.length ? <p className="empty">{state.players.length ? 'No players match your filters.' : 'The player pool is being prepared. Stay tuned.'}</p>
      : <div className="results-grid">{filtered.map((player) => <button type="button" className="result-card" key={player.id}
        onClick={() => onPlayer(player.id)} aria-label={`${player.name}: view details and bid history`}>
        <Portrait path={player.photo_path} name={player.name} className="result-photo" />
        <div className="result-copy"><span className="position">{player.position}</span>{player.captain && <CaptainBadge />}<h3>{player.name}</h3>
          <p className="muted">{state.teams.find((t) => t.id === player.team_id)?.name ?? (player.status === 'sold' ? 'Team unavailable' : 'Not assigned')}</p></div>
        <div className="result-status"><span className={`status-pill ${player.status}`}>{player.captain ? 'captain' : player.status}</span>
          {player.price !== null && <strong>{credits(player.price)} points</strong>}</div>
      </button>)}</div>}
  </section>
}
