import { useState } from 'react'
import type { FormEvent } from 'react'
import { captainLimit, credits, mediaPath, positions, setupProblems } from './auction'
import { ImageField, Portrait } from './components'
import type { AuctionState, Player, Position, Team } from './types'

export type ProfileInput = { name: string; image: string; file: File | null; position?: Position }
export type SaveProfile = (kind: 'teams' | 'players', id: number | undefined, input: ProfileInput) => Promise<boolean>

function ProfileForm({ kind, entity, disabled, save, close }: {
  kind: 'teams' | 'players'; entity?: Team | Player; disabled: boolean; save: SaveProfile; close: () => void
}) {
  const isPlayer = kind === 'players'
  const [name, setName] = useState(entity?.name ?? '')
  const [position, setPosition] = useState<Position>(entity && 'position' in entity ? entity.position : 'MID')
  const [file, setFile] = useState<File | null>(null)
  const existing = entity ? 'photo_path' in entity ? entity.photo_path : entity.logo_path : ''
  const [validation, setValidation] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) { setValidation('Enter a name.'); return }
    if (!file && !mediaPath.test(existing)) { setValidation('Upload an image before saving.'); return }
    setValidation('')
    if (await save(kind, entity?.id, { name: name.trim(), image: existing, file, position: isPlayer ? position : undefined })) close()
  }
  return <form className="profile-form" onSubmit={(event) => void submit(event)}>
    <h3>{entity ? 'Edit' : 'Add'} {isPlayer ? 'player' : 'team'}</h3>
    <label htmlFor={`${kind}-name`}>{isPlayer ? 'Player' : 'Team'} name</label>
    <input id={`${kind}-name`} required maxLength={100} value={name} disabled={disabled}
      onChange={(event) => setName(event.target.value)} autoComplete="off" />
    {isPlayer && <>
      <label htmlFor="player-position">Position</label>
      <select id="player-position" value={position} disabled={disabled} onChange={(event) => setPosition(event.target.value as Position)}>
        {positions.map((p) => <option key={p} value={p}>{p} · {({ GK: 'Goalkeeper', DEF: 'Defender', MID: 'Midfielder', ST: 'Striker' })[p]}</option>)}
      </select>
    </>}
    <ImageField id={`${kind}-image`} label={isPlayer ? 'Player photo' : 'Team logo'} existing={existing}
      file={file} onChange={setFile} disabled={disabled} />
    {validation && <p role="alert" className="warning-text">{validation}</p>}
    <div className="button-row">
      <button type="submit" disabled={disabled}>{disabled ? 'Please wait…' : entity ? 'Save changes' : `Add ${isPlayer ? 'player' : 'team'}`}</button>
      <button type="button" className="secondary" disabled={disabled} onClick={close}>Cancel</button>
    </div>
  </form>
}

function CaptainRow({ state, team, disabled, setCaptain, removeCaptain }: {
  state: AuctionState; team: Team; disabled: boolean
  setCaptain: (teamId: number, playerId: number, price: number) => Promise<boolean>
  removeCaptain: (teamId: number) => Promise<boolean>
}) {
  const current = team.roster.find((r) => r.captain)
  const [playerId, setPlayerId] = useState(current ? String(current.id) : '')
  const [price, setPrice] = useState(current ? String(current.price) : '10')
  const limit = captainLimit(state.squad_size)
  const value = Number(price)
  const validPrice = Number.isInteger(value) && value >= 10 && value <= limit && value % 10 === 0
  const choices = state.players.filter((p) => !p.captain || p.team_id === team.id)
  const unchanged = current && String(current.id) === playerId && current.price === value
  const id = `captain-${team.id}`
  return <article className="captain-row">
    <div className="captain-team"><Portrait path={team.logo_path} name={team.name} className="team-logo" />
      <div><h3>{team.name}</h3>{current
        ? <p className="captain-current"><span className="captain-badge" aria-label="Captain">C</span>{current.name} · {current.position} · <strong>{credits(current.price)} points</strong></p>
        : <p className="warning-text">No captain yet</p>}</div></div>
    <form className="captain-form" onSubmit={(event) => {
      event.preventDefault()
      if (playerId && validPrice) void setCaptain(team.id, Number(playerId), value)
    }}>
      <label htmlFor={`${id}-player`}>Captain</label>
      <select id={`${id}-player`} value={playerId} disabled={disabled} onChange={(event) => setPlayerId(event.target.value)}>
        <option value="">Choose a player…</option>
        {choices.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.position}</option>)}
      </select>
      <label htmlFor={`${id}-price`}>Price (points)</label>
      <input id={`${id}-price`} type="number" min="10" max={limit} step="10" required value={price}
        disabled={disabled} onChange={(event) => setPrice(event.target.value)} />
      <div className="button-row">
        <button disabled={disabled || !playerId || !validPrice || Boolean(unchanged)}>{current ? 'Update' : 'Save captain'}</button>
        {current && <button type="button" className="text-button danger" disabled={disabled} onClick={() => void removeCaptain(team.id)}>Remove</button>}
      </div>
      {!validPrice && <small className="warning-text">Use a multiple of 10 between 10 and {credits(limit)}.</small>}
    </form>
  </article>
}

export function Setup({ state, disabled, save, remove, configure, start, setCaptain, removeCaptain }: {
  state: AuctionState; disabled: boolean; save: SaveProfile
  remove: (kind: 'teams' | 'players', entity: Team | Player) => void
  configure: (size: number) => Promise<boolean>; start: () => void
  setCaptain: (teamId: number, playerId: number, price: number) => Promise<boolean>
  removeCaptain: (teamId: number) => Promise<boolean>
}) {
  const [teamEditor, setTeamEditor] = useState<number | 'new' | null>(null)
  const [playerEditor, setPlayerEditor] = useState<number | 'new' | null>(null)
  const [squad, setSquad] = useState(String(state.squad_size))
  const [search, setSearch] = useState('')
  const [position, setPosition] = useState('')
  const problems = setupProblems(state)
  const validSize = Number.isInteger(Number(squad)) && Number(squad) >= 1 && Number(squad) <= 100
  const unsavedSize = Number(squad) !== state.squad_size
  const filtered = state.players.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) && (!position || p.position === position))
  return <div className="setup">
    <section className="panel setup-launch">
      <div><span className="eyebrow">01 / Prepare the room</span><h1>Build the matchday.</h1>
        <p className="muted">{state.fixed_teams
          ? 'Five official teams. One player pool. Add your players and prepare the room.'
          : 'Five teams. One player pool. Everything can be corrected here before the auction starts.'}</p></div>
      <form onSubmit={(event) => { event.preventDefault(); if (validSize) void configure(Number(squad)) }}>
        <label htmlFor="squad-size">Players per team</label>
        <div className="button-row">
          <input id="squad-size" type="number" min="1" max="100" step="1" required value={squad}
            disabled={disabled} onChange={(event) => setSquad(event.target.value)} />
          <button className="secondary" disabled={disabled || !validSize || !unsavedSize}>Save size</button>
        </div>
        <small className="muted">Saved: {state.squad_size} per team · minimum {5 * state.squad_size} players · 10 points reserved per empty slot</small>
      </form>
      <div className="readiness">
        {problems.length > 0 ? <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          : <p className="success-text">✓ Teams and player pool ready. The server will validate every uploaded image at start.</p>}
        {unsavedSize && <p className="warning-text">Save your squad-size change before starting.</p>}
        <button disabled={disabled || problems.length > 0 || unsavedSize} onClick={start}>Start auction →</button>
        <small className="muted">Starting locks team and player editing.</small>
      </div>
    </section>
    <section className="panel" aria-labelledby="teams-setup-title">
      <div className="section-heading"><div><span className="eyebrow">The clubs</span><h2 id="teams-setup-title">Teams <span className="count">{state.teams.length} / 5</span></h2></div>
        {state.fixed_teams ? <span className="official-badge">Official lineup · fixed</span>
          : <button className="secondary" disabled={disabled || state.teams.length >= 5 || teamEditor !== null} onClick={() => setTeamEditor('new')}>＋ Add team</button>}</div>
      {state.fixed_teams && <p className="muted">BlackMambas, Cobras, Vipers, Pythons and Anacondas are preset for this auction. Their names and official logos are locked.</p>}
      {!state.fixed_teams && teamEditor !== null && <ProfileForm key={`team-${teamEditor}`} kind="teams" entity={state.teams.find((t) => t.id === teamEditor)}
        disabled={disabled} save={save} close={() => setTeamEditor(null)} />}
      {!state.teams.length && <p className="empty">Add five clubs with a name and uploaded logo. Budgets are assigned by the auction server.</p>}
      <div className="setup-team-grid">{state.teams.map((team) => <article key={team.id} className="setup-team">
        <Portrait path={team.logo_path} name={team.name} className="team-logo" />
        <div><h3>{team.name}</h3><p className="muted">{credits(team.budget)} points</p></div>
        {!state.fixed_teams && <div className="button-row"><button className="text-button" disabled={disabled} onClick={() => setTeamEditor(team.id)}>Edit</button>
          <button className="text-button danger" disabled={disabled} onClick={() => remove('teams', team)}>Delete</button></div>}
      </article>)}</div>
    </section>
    <section className="panel" aria-labelledby="captains-setup-title">
      <div className="section-heading"><div><span className="eyebrow">Before the hammer</span><h2 id="captains-setup-title">Captains <span className="count">{state.players.filter((p) => p.captain).length} / 5</span></h2></div></div>
      <p className="muted">Pick each team’s captain from the player pool and enter the captain price. The price is deducted from that team’s 1000 points and the captain fills one squad slot. Maximum {credits(captainLimit(state.squad_size))} points, so 10 points stay reserved for each other slot. Captains are not auctioned.</p>
      {!state.teams.length && <p className="empty">Add the teams first.</p>}
      <div className="captain-list">{state.teams.map((team) => {
        const captain = team.roster.find((r) => r.captain)
        return <CaptainRow key={`${team.id}-${captain?.id ?? 0}-${captain?.price ?? 0}`} state={state} team={team} disabled={disabled}
          setCaptain={setCaptain} removeCaptain={removeCaptain} />
      })}</div>
    </section>
    <section className="panel" aria-labelledby="players-setup-title">
      <div className="section-heading"><div><span className="eyebrow">The talent</span><h2 id="players-setup-title">Player pool <span className="count">{state.players.length}</span></h2></div>
        <button className="secondary" disabled={disabled || playerEditor !== null} onClick={() => setPlayerEditor('new')}>＋ Add player</button></div>
      {playerEditor !== null && <ProfileForm key={`player-${playerEditor}`} kind="players" entity={state.players.find((p) => p.id === playerEditor)}
        disabled={disabled} save={save} close={() => setPlayerEditor(null)} />}
      <div className="filters">
        <label>Find a player<input type="search" placeholder="Search names…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label>Position<select value={position} onChange={(event) => setPosition(event.target.value)}><option value="">All positions</option>{positions.map((p) => <option key={p}>{p}</option>)}</select></label>
      </div>
      {!state.players.length && <p className="empty">Upload real player photos and choose GK, DEF, MID, or ST. No sample players are added automatically.</p>}
      {state.players.length > 0 && !filtered.length && <p className="empty">No players match your filters.</p>}
      <div className="player-grid">{filtered.map((player) => <article className="player-card" key={player.id}>
        <Portrait path={player.photo_path} name={player.name} />
        <div className="player-card-body"><span className="position">{player.position}</span>{player.captain && <span className="captain-badge" title={`Captain of ${state.teams.find((t) => t.id === player.team_id)?.name ?? 'a team'}`}>C</span>}<h3>{player.name}</h3>
          <div className="button-row"><button className="text-button" disabled={disabled} onClick={() => setPlayerEditor(player.id)}>Edit</button>
            <button className="text-button danger" disabled={disabled} onClick={() => remove('players', player)}>Delete</button></div>
        </div>
      </article>)}</div>
    </section>
  </div>
}
