import { useEffect, useRef } from 'react'
import { credits, setLabels, setMembers, sets } from './auction'
import { CaptainBadge } from './Board'
import { Portrait } from './components'
import type { AuctionState, Player, SetName } from './types'

function SetTile({ state, player, onPlayer }: { state: AuctionState; player: Player; onPlayer: (id: number) => void }) {
  const team = state.teams.find((t) => t.id === player.team_id)
  const label = player.status === 'sold' ? `Sold to ${team?.name ?? 'team'} for ${credits(player.price ?? 0)} points`
    : player.status === 'current' ? 'On the block now' : player.status === 'unsold' ? 'Unsold' : 'Waiting'
  return <li>
    <button type="button" className={`set-tile is-${player.status}`} onClick={() => onPlayer(player.id)}
      aria-label={`${player.name}, ${player.position}. ${label}. View details`}>
      <Portrait path={player.photo_path} name={player.name} className="set-photo" />
      <span className="set-tile-name">{player.name}</span>
      {player.status === 'sold' ? <span className="set-tile-sold">
        <b>SOLD</b>{team && <Portrait path={team.logo_path} name={team.name} className="set-team-logo" />}
        <span>{team?.name ?? 'Team'} · {credits(player.price ?? 0)}</span>
      </span> : <span className="set-tile-state">{player.status === 'current' ? '● On the block' : player.status === 'unsold' ? 'Unsold' : player.position}</span>}
    </button>
  </li>
}

function SetSection({ state, set, onPlayer }: { state: AuctionState; set: SetName; onPlayer: (id: number) => void }) {
  const members = setMembers(state, set)
  const waiting = members.filter((p) => p.status === 'available' || p.status === 'unsold').length
  const sold = members.filter((p) => p.status === 'sold').length
  const open = state.open_set === set
  return <section className={`set-section ${open ? 'is-open' : ''}`} aria-labelledby={`set-${set}`}>
    <div className="set-heading">
      <h3 id={`set-${set}`}>{setLabels[set]}</h3>
      {open && <span className="tag">Live set</span>}
      <span className="muted">{waiting} waiting{set === 'UNSOLD' ? '' : ` · ${sold} sold`}</span>
    </div>
    {members.length ? <ul className="set-grid">{members.map((p) => <SetTile key={p.id} state={state} player={p} onPlayer={onPlayer} />)}</ul>
      : <p className="empty compact">{set === 'UNSOLD' ? 'No unsold players.' : 'No players in this set.'}</p>}
  </section>
}

/** All sets before a set opens; only the live set once the host opens one. */
export function SetsBoard({ state, onPlayer }: { state: AuctionState; onPlayer: (id: number) => void }) {
  const shown = state.open_set ? [state.open_set]
    : sets.filter((set) => set !== 'UNSOLD' || setMembers(state, 'UNSOLD').length > 0)
  return <section className="panel sets-board" aria-labelledby="sets-title">
    <div className="section-heading"><div><span className="eyebrow">{state.open_set ? 'Now auctioning' : 'The player pool'}</span>
      <h2 id="sets-title">{state.open_set ? setLabels[state.open_set] : 'Auction sets'}</h2></div>
      <span className="muted">Tap a player for details{state.status === 'setup' ? '' : ' and bid history'}</span></div>
    {shown.map((set) => <SetSection key={set} state={state} set={set} onPlayer={onPlayer} />)}
  </section>
}

export function PlayerDialog({ state, playerId, onClose }: { state: AuctionState; playerId: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    const current = dialog.current
    return () => { current?.close(); previous?.focus() }
  }, [])
  const player = state.players.find((p) => p.id === playerId)
  const team = state.teams.find((t) => t.id === player?.team_id)
  const teamOf = (id: number) => state.teams.find((t) => t.id === id)
  return <dialog ref={dialog} className="player-dialog" aria-labelledby="player-dialog-title" onCancel={(event) => { event.preventDefault(); onClose() }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="dialog-content">
      <button type="button" className="dialog-close" onClick={onClose} aria-label="Close player details" autoFocus>✕</button>
      {!player ? <><h2 id="player-dialog-title">Player not found</h2><p className="muted">This player is no longer in the auction.</p></> : <>
        <div className="player-dialog-head">
          <Portrait path={player.photo_path} name={player.name} className="player-dialog-photo" />
          <div>
            <span className="eyebrow">{player.captain ? 'Captain' : setLabels[player.position]}</span>
            <h2 id="player-dialog-title">{player.name}{player.captain && <CaptainBadge />}</h2>
            <p><span className="position">{player.position}</span>{' '}
              {player.status === 'sold' && team && <span className="player-dialog-team"><Portrait path={team.logo_path} name={team.name} className="set-team-logo" />{team.name} · <b>{credits(player.price ?? 0)} points</b></span>}
            </p>
          </div>
        </div>
        <h3 className="player-dialog-subtitle">Bid history</h3>
        {player.captain ? <p className="muted">Chosen as captain of {team?.name ?? 'a team'} before the auction for {credits(player.price ?? 0)} points. Captains are not auctioned, so there were no bids.</p>
          : player.status === 'sold' ? player.bids.length ? <ol className="bid-history">{player.bids.map((bid, index) => {
            const bidder = teamOf(bid.team_id)
            const last = index === player.bids.length - 1
            return <li key={index} className={last ? 'winning' : ''}>
              <span className="bid-step">{index + 1}</span>
              {bidder && <Portrait path={bidder.logo_path} name={bidder.name} className="set-team-logo" />}
              <span className="bid-team">{bidder?.name ?? 'Team'}</span>
              <b>{credits(bid.amount)} <small>points</small></b>
              {last && <span className="tag">Sold</span>}
            </li>
          })}</ol> : <p className="muted">Sold for {credits(player.price ?? 0)} points. No bid history was recorded for this sale.</p>
          : player.status === 'current' ? <p className="muted">Bidding is live right now. The full bid history appears here once the player is sold.</p>
            : player.status === 'unsold' ? <p className="muted">No team bought this player. They wait in the Unsold set for the final round.</p>
              : <p className="muted">Waiting in {setLabels[player.position]}. Bids appear here after the player is sold.</p>}
      </>}
    </div>
  </dialog>
}
