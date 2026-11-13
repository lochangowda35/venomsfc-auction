import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ApiError, request } from './api'
import { Portrait } from './components'
import { CupDateTime, CupSelect } from './CupSelect'
import type { Session } from './types'
import venomsLogo from './assets/venoms-fc.png'
import './Website.css'

type Player = {
  id: number
  name: string
  photo_path: string
  position: string
  teams?: Team[]
  statistics?: Record<string, number>
  matches?: Match[]
}

type Team = {
  id: number
  name: string
  logo_path: string
  captain_player_id?: number | null
  players?: Player[]
  matches?: Match[]
}

type CupEvent = {
  id: number
  event_type: string
  minute: number
  period: string
  team_id: number
  player_id: number
  assist_player_id: number | null
  goalkeeper_id: number | null
  outcome: string | null
  voided?: boolean
  payload?: Record<string, unknown>
  player: Player | null
  assist: Player | null
  goalkeeper: Player | null
}

type Match = {
  id: number
  tournament_id: number
  stage: string
  home_team: Team | null
  away_team: Team | null
  home_team_id: number | null
  away_team_id: number | null
  match_order: number
  scheduled_at: string | null
  finalized_at?: string | null
  state: string
  version: number
  clock: {
    period?: string
    elapsed_seconds?: number
    anchor?: string | null
    paused?: boolean
    break_started_at?: string | null
    break_elapsed_seconds?: number
  }
  settings?: Record<string, number | string | unknown>
  home_goals: number
  away_goals: number
  shootout: { home: number; away: number }
  shootout_winner_team_id?: number | null
  shootout_finish?: { winner_team_id: number; host_decided: boolean } | null
  penalty_eligible_player_ids?: Record<string, number[]>
  events: CupEvent[]
  participations: { player: Player | null; team_id: number; status: string; goalkeeper: boolean }[]
}

type Standing = {
  id: number
  name: string
  logo_path: string
  played: number
  won: number
  drawn: number
  lost: number
  goals_for: number
  goals_against: number
  goal_difference: number
  points: number
  rank: number
}

type Leader = { rank: number; player: Player; team: Team | null; total: number; appearances: number }
type Tournament = {
  id: number
  name: string
  edition: string
  lifecycle: string
  timezone: string
  version: number
  settings: Record<string, number | string | unknown>
  teams: Team[]
  standings: Standing[]
  unresolved_tie: string | null
  qualification?: Qualification | null
  leaderboards: Record<string, Leader[]>
  matches: Match[]
  updated_at: string
}

type TournamentSummary = Pick<Tournament, 'id' | 'name' | 'edition' | 'lifecycle' | 'version'>

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

function SiteHeader({ active }: { active: string }) {
  const [navigationError, setNavigationError] = useState('')
  const navigating = useRef(false)
  return <header className="cup-header">
    <a className="cup-brand" href="/" aria-label="Venoms FC home">
      <img src={venomsLogo} alt="" />
      <span>VENOMS <b>FC</b><small>INTERNAL CUP</small></span>
    </a>
    <nav aria-label="Main navigation">
      <a href="/" aria-current={active === 'home' ? 'page' : undefined}>Home</a>
      <a href="/tournaments" aria-current={active === 'tournaments' ? 'page' : undefined}
        onClick={async (event) => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
          event.preventDefault()
          if (navigating.current) return
          navigating.current = true
          setNavigationError('')
          try {
            const result = await request<{ tournaments: TournamentSummary[] }>('/api/cup?summary=1')
            const current = result.tournaments.find((row) => ['running', 'paused'].includes(row.lifecycle))
            window.location.assign(current ? `/tournaments/${current.id}` : '/tournaments')
          } catch (caught) {
            setNavigationError(`Could not find the current tournament. ${messageOf(caught)}`)
          } finally {
            navigating.current = false
          }
        }}>Tournament</a>
      <a href="/players" aria-current={active === 'players' ? 'page' : undefined}>Players</a>
      <a href="/auction" aria-current={active === 'auction' ? 'page' : undefined}>Auction</a>
      <a className="cup-host-link" href="/tournament-host">Tournament host ↗</a>
    </nav>
    {navigationError && <p className="cup-alert" role="alert">{navigationError} <a href="/tournaments">Browse tournaments</a></p>}
  </header>
}

function SiteFooter() {
  return <footer className="cup-footer"><span>VENOMS FC · ONE CLUB, FIVE RIVALS</span>
    <span><a href="/tournaments">Internal Cup</a><a href="/auction">Auction archive</a></span></footer>
}

function CupLayout({ active, children }: { active: string; children: ReactNode }) {
  return <div className="cup-site">
    <SiteHeader active={active} />
    <main className="cup-main">{children}</main>
    <SiteFooter />
  </div>
}

function SectionTitle({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return <div className="cup-section-title"><div><span className="cup-eyebrow">{eyebrow}</span>
    <h2>{title}</h2></div>{detail && <span className="cup-section-detail">{detail}</span>}</div>
}

function StatusPill({ value }: { value: string }) {
  return <span className={`cup-status cup-status-${value.replace(/_/g, '-')}`}>{value.replace(/_/g, ' ')}</span>
}

function displayStandings(rows: Standing[]) {
  const sizes = new Map<number, number>()
  rows.forEach((row) => sizes.set(row.rank, (sizes.get(row.rank) ?? 0) + 1))
  return [...rows].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map((row, index) => ({ ...row, position: index + 1, tied: (sizes.get(row.rank) ?? 1) > 1, groupEnd: row.rank + (sizes.get(row.rank) ?? 1) - 1 }))
}

function Table({ tournament, tieDecisionNeeded }: { tournament: Tournament; tieDecisionNeeded: boolean }) {
  const rows = displayStandings(tournament.standings)
  const tiedOnTable = rows.some((row) => row.tied && row.played > 0)
  return <section className="cup-card" aria-labelledby="team-table-title">
    <SectionTitle eyebrow="League phase" title="Team table" detail="3 points for a win · 1 for a draw" />
    {tieDecisionNeeded && tournament.unresolved_tie && <p className="cup-inline-warning" role="status">{tournament.unresolved_tie}. Teams level on points, goal difference and goals scored are listed alphabetically until the host settles the order.</p>}
    <div className="cup-table-wrap"><table className="cup-table">
      <caption className="sr-only">Internal Cup league standings</caption>
      <thead><tr><th scope="col">#</th><th scope="col">Team</th><th scope="col">P</th><th scope="col">W</th>
        <th scope="col">D</th><th scope="col">L</th><th scope="col">GF</th><th scope="col">GA</th><th scope="col">GD</th><th scope="col">Pts</th></tr></thead>
      <tbody>{rows.length ? rows.map((row) => <tr key={row.id}>
        <td className={row.groupEnd <= 2 && row.played > 0 ? 'cup-qualify' : undefined}>{row.position}
          {row.tied && row.played > 0 && <small className="cup-tie-mark" title="Level on points, goal difference and goals scored" aria-label="level with another team">=</small>}</td>
        <th scope="row"><a className="cup-team-name" href={`/teams/${row.id}`}>
          <Portrait path={row.logo_path} name={row.name} className="cup-table-logo" />{row.name}</a></th>
        <td>{row.played}</td><td>{row.won}</td><td>{row.drawn}</td><td>{row.lost}</td>
        <td>{row.goals_for}</td><td>{row.goals_against}</td><td>{row.goal_difference > 0 ? `+${row.goal_difference}` : row.goal_difference}</td>
        <td className="cup-points">{row.points}</td></tr>) : <tr><td colSpan={10} className="cup-empty-cell">Cup squads and fixtures will appear here once the host sets up the edition.</td></tr>}</tbody>
    </table></div>
    {tiedOnTable && <p className="cup-table-note"><b>=</b> Level on points, goal difference and goals scored. These teams are listed alphabetically for now; the host settles the official order before playoff places are decided.</p>}
  </section>
}

type QualificationStatus = 'secured' | 'possible' | 'tiebreak' | 'eliminated'
type QualificationSlot = { status: QualificationStatus; secure_points: number | null; outright_min_points: number | null; alive_min_points: number | null }
type QualificationTeam = {
  team_id: number; name: string; points: number; games_left: number; max_points: number
  best_position: number; worst_position: number; final: QualificationSlot; playoff: QualificationSlot
}
type Qualification = { minimum_played: number; remaining_matches: { id: number; home_team_id: number; away_team_id: number }[]; teams: QualificationTeam[] }

const ordinal = (value: number) => `${value}${value === 1 ? 'st' : value === 2 ? 'nd' : value === 3 ? 'rd' : 'th'}`

function resultsFor(points: number, games: number) {
  if (points <= 0) return 'any results'
  for (let wins = 0; wins <= games; wins += 1) {
    const draws = Math.max(0, points - 3 * wins)
    if (wins + draws <= games) {
      const parts = [wins && `${wins} win${wins > 1 ? 's' : ''}`, draws && `${draws} draw${draws > 1 ? 's' : ''}`].filter(Boolean)
      return `${points} point${points === 1 ? '' : 's'} (e.g. ${parts.join(' + ')})`
    }
  }
  return `${points} points`
}

function slotText(slot: QualificationSlot, games: number, target: string) {
  if (slot.status === 'secured') return `Secured on points — will finish ${target} whatever happens.`
  if (slot.status === 'eliminated') return `Can no longer finish ${target}.`
  if (slot.status === 'tiebreak') return `Only by finishing level on points with a rival; goal difference, goals scored or the host tie decision would then decide.`
  const parts = []
  if (slot.secure_points !== null) parts.push(`${resultsFor(slot.secure_points, games)} from the remaining ${games} guarantees it.`)
  else parts.push('Cannot guarantee it alone — other results matter even after winning every game.')
  if (slot.outright_min_points !== null && slot.outright_min_points > 0) parts.push(`Needs at least ${resultsFor(slot.outright_min_points, games)} to get there without a tie.`)
  else if (slot.alive_min_points !== null && slot.alive_min_points > 0) parts.push(`Needs at least ${resultsFor(slot.alive_min_points, games)} to stay in contention.`)
  return parts.join(' ')
}

const statusLabel: Record<QualificationStatus, string> = { secured: 'Secured', possible: 'In contention', tiebreak: 'Tie-dependent', eliminated: 'Out' }

function QualificationOutlook({ tournament }: { tournament: Tournament }) {
  const outlook = tournament.qualification
  if (!outlook) return null
  const teamName = (id: number) => outlook.teams.find((team) => team.team_id === id)?.name
    ?? tournament.standings.find((team) => team.id === id)?.name ?? 'TBC'
  return <section className="cup-card cup-outlook" aria-labelledby="cup-outlook-title">
    <div className="cup-section-title"><div><span className="cup-eyebrow">Run-in</span><h2 id="cup-outlook-title">Qualification scenarios</h2></div>
      <span className="cup-section-detail">Qualification scenarios, not a forecast</span></div>
    <p className="cup-outlook-intro">Every possible win, draw and loss in the {outlook.remaining_matches.length} remaining league {outlook.remaining_matches.length === 1 ? 'match' : 'matches'} is checked on points only. Top 2 play the final; 3rd and 4th play the third-place match. A draw settled on penalties counts like a win (3 points to the winner, 0 to the loser). Scores are unknown, so finishing level on points is shown as tie-dependent — never decided by name.</p>
    <div className="cup-outlook-grid">{outlook.teams.map((team) => {
      const fixtures = outlook.remaining_matches.filter((row) => row.home_team_id === team.team_id || row.away_team_id === team.team_id)
        .map((row) => teamName(row.home_team_id === team.team_id ? row.away_team_id : row.home_team_id))
      return <article key={team.team_id} className="cup-outlook-team" aria-label={`${team.name} qualification scenarios`}>
        <header><strong>{team.name}</strong><span>{team.points} pts · max {team.max_points}</span></header>
        <p className="cup-outlook-range">Can finish {team.best_position === team.worst_position ? ordinal(team.best_position) : `${ordinal(team.best_position)}–${ordinal(team.worst_position)}`}
          {team.games_left ? ` · ${team.games_left} left: vs ${fixtures.join(', vs ')}` : ' · league games complete'}</p>
        <dl>
          <div data-status={team.final.status}><dt>Final <small>top 2</small></dt><dd><b>{statusLabel[team.final.status]}</b>{slotText(team.final, team.games_left, 'in the top 2')}</dd></div>
          <div data-status={team.playoff.status}><dt>Playoffs <small>top 4 · final or 3rd-place match</small></dt><dd><b>{statusLabel[team.playoff.status]}</b>{slotText(team.playoff, team.games_left, 'in the top 4')}</dd></div>
        </dl>
      </article>
    })}</div>
  </section>
}

function Leaderboard({ title, metric, rows }: { title: string; metric: string; rows: Leader[] }) {
  return <section className="cup-card cup-leaderboard">
    <SectionTitle eyebrow="Tournament leaders" title={title} detail={metric} />
    {rows.length ? <ol>{rows.map((row) => <li key={`${row.player.id}-${row.rank}`}>
      <span className="cup-rank">{row.rank}</span>
      <a className="cup-leader-player" href={`/players/${row.player.id}`}>
        <span className="cup-leader-photo" aria-hidden="true"><Portrait path={row.player.photo_path} name={row.player.name} /></span>
        <span className="cup-leader-name"><b>{row.player.name}</b>
          <small>{row.team ? `${row.team.name} · ` : ''}{row.appearances} apps · {row.player.position}</small></span>
      </a>
      <strong>{row.total}</strong>
    </li>)}</ol> : <p className="cup-empty-text">No {title.toLowerCase()} recorded yet.</p>}
  </section>
}

function eventIcon(event: CupEvent) {
  if (event.event_type === 'shot') return event.outcome === 'goal' ? '⚽' : event.outcome === 'saved' ? '🧤' : '↗'
  if (event.event_type === 'yellow_card') return event.payload?.second_yellow_dismissal === true ? '🟨🟥' : '🟨'
  if (event.event_type === 'red_card') return '🟥'
  if (event.event_type === 'own_goal') return 'OG'
  if (event.event_type === 'shootout') return 'PK'
  return '⇄'
}

function eventLabel(event: CupEvent) {
  if (event.event_type === 'shot') return event.outcome === 'goal' ? 'Goal' : `Shot · ${event.outcome?.replace(/_/g, ' ') ?? ''}`
  if (event.event_type === 'yellow_card' && event.payload?.second_yellow_dismissal === true) return 'Second yellow · sent off'
  if (event.event_type === 'shootout') return event.payload?.scored === true ? 'Penalty scored' : 'Penalty missed'
  return event.event_type.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function periodName(period: string) {
  return ({ first_half: 'first half', second_half: 'second half', extra_time_1: 'extra time 1', extra_time_2: 'extra time 2' } as Record<string, string>)[period]
    ?? (period.replace(/_/g, ' ') || 'period')
}

type TeamHighlight = { id: number; minute: number; kind: 'goal' | 'own_goal' | 'yellow' | 'second_yellow' | 'red'; name: string }

// Goals are grouped under the team credited with the goal; an own goal lists the opposing player who scored it.
function teamHighlights(match: Match, teamId: number | null): TeamHighlight[] {
  if (teamId === null || !match.events) return []
  return match.events.flatMap((event): TeamHighlight[] => {
    if (event.voided) return []
    const name = event.player?.name ?? 'Player'
    if (event.event_type === 'shot' && event.outcome === 'goal' && event.team_id === teamId)
      return [{ id: event.id, minute: event.minute, kind: 'goal', name }]
    if (event.event_type === 'own_goal' && event.team_id !== teamId
      && (event.team_id === match.home_team_id || event.team_id === match.away_team_id))
      return [{ id: event.id, minute: event.minute, kind: 'own_goal', name }]
    if (event.team_id !== teamId) return []
    if (event.event_type === 'yellow_card')
      return [{ id: event.id, minute: event.minute, kind: event.payload?.second_yellow_dismissal === true ? 'second_yellow' : 'yellow', name }]
    if (event.event_type === 'red_card') return [{ id: event.id, minute: event.minute, kind: 'red', name }]
    return []
  }).sort((a, b) => a.minute - b.minute || a.id - b.id)
}

const highlightText: Record<TeamHighlight['kind'], string> = {
  goal: 'Goal', own_goal: 'Own goal', yellow: 'Yellow card', second_yellow: 'Second yellow, sent off', red: 'Red card',
}

function TeamHighlights({ match, teamId, side }: { match: Match; teamId: number | null; side: 'home' | 'away' }) {
  const rows = teamHighlights(match, teamId)
  if (!rows.length) return null
  return <span className={`cup-team-highlights cup-team-highlights-${side}`} role="list"
    aria-label={`${side === 'home' ? match.home_team?.name ?? 'Home' : match.away_team?.name ?? 'Away'} goals and cards`}>
    {rows.map((row) => <span role="listitem" key={row.id} className={`cup-highlight cup-highlight-${row.kind}`}>
      <i aria-hidden="true">{row.kind === 'goal' ? '⚽' : row.kind === 'own_goal' ? '⚽' : ''}</i>
      <span className="sr-only">{highlightText[row.kind]}: </span>
      <b>{row.name}</b>{row.kind === 'own_goal' && <small aria-hidden="true"> (OG)</small>}
      <small>{row.minute}′</small>
    </span>)}
  </span>
}

function kickoffLabel(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  return {
    day: date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
    time: date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase(),
  }
}

function MatchCard({ match, showHighlights = false }: { match: Match; showHighlights?: boolean }) {
  const kickoff = kickoffLabel(match.scheduled_at)
  const scoreAvailable = ['live', 'paused', 'review', 'finalized'].includes(match.state)
  const highlights = showHighlights && scoreAvailable
  const pens = scoreAvailable && (match.clock.period === 'shootout' || Boolean(match.shootout_winner_team_id))
  const penaltyWinner = [match.home_team, match.away_team]
    .find((team) => team?.id === match.shootout_winner_team_id)
  const status = match.state === 'finalized' ? 'Full time' : match.state === 'live' ? 'Live' : match.state === 'paused' ? 'Paused'
    : match.state === 'review' ? 'Result in review' : 'Upcoming'
  return <a className={`cup-match-card is-${match.state}${match.state === 'live' || match.state === 'paused' ? ' is-live' : ''}`}
    href={`/matches/${match.id}`}>
    <span className="cup-match-meta"><span>{match.stage.replace(/_/g, ' ')}</span><b className="cup-match-status">{status}</b></span>
    <span className="cup-match-side">{match.home_team && <><Portrait path={match.home_team.logo_path} name={match.home_team.name} className="cup-match-logo" /><span>{match.home_team.name}</span></>}
      {!match.home_team && <span>Qualified team</span>}</span>
    <span className="cup-match-center">
      <strong className="cup-match-score">{!scoreAvailable ? 'vs' : <>{match.home_team ? match.home_goals : '—'} <i>:</i> {match.away_team ? match.away_goals : '—'}</>}</strong>
      {pens && <span className="cup-match-pens">Pens {match.shootout.home}–{match.shootout.away}</span>}
      {pens && penaltyWinner && <span className="cup-match-decision">{penaltyWinner.name} win on penalties</span>}
      {kickoff ? <time className="cup-match-when" dateTime={match.scheduled_at ?? undefined}><span>{kickoff.day}</span><b>{kickoff.time}</b></time>
        : !scoreAvailable && <span className="cup-match-when"><span>Kickoff</span><b>TBC</b></span>}
    </span>
    <span className="cup-match-side cup-away-side">{match.away_team && <><span>{match.away_team.name}</span><Portrait path={match.away_team.logo_path} name={match.away_team.name} className="cup-match-logo" /></>}
      {!match.away_team && <span>Qualified team</span>}</span>
    {highlights && <span className="cup-match-highlights">
      <TeamHighlights match={match} teamId={match.home_team_id} side="home" />
      <TeamHighlights match={match} teamId={match.away_team_id} side="away" />
    </span>}
    <span className="cup-match-arrow" aria-hidden="true">↗</span>
  </a>
}

type PitchPlayer = { kit: 'blue' | 'orange'; keeper?: boolean; number: number; path: [number, number][]; speed: number; delay: number }

const pitchPlayers: PitchPlayer[] = [
  { kit: 'blue', keeper: true, number: 1, path: [[7, 44], [7, 56], [8, 50]], speed: 5.5, delay: 0 },
  { kit: 'blue', number: 4, path: [[28, 30], [40, 24], [33, 38]], speed: 6, delay: -1 },
  { kit: 'blue', number: 7, path: [[36, 66], [48, 72], [42, 58]], speed: 6.5, delay: -2.5 },
  { kit: 'blue', number: 9, path: [[56, 44], [70, 40], [64, 54]], speed: 6, delay: -0.5 },
  { kit: 'orange', keeper: true, number: 1, path: [[92, 56], [92, 44], [91, 50]], speed: 5, delay: -1.2 },
  { kit: 'orange', number: 5, path: [[72, 32], [62, 28], [68, 42]], speed: 6.2, delay: -3 },
  { kit: 'orange', number: 8, path: [[64, 70], [54, 64], [74, 62]], speed: 5.8, delay: -1.8 },
  { kit: 'orange', number: 10, path: [[46, 52], [38, 46], [52, 40]], speed: 6.4, delay: -4 },
]

function PitchScene() {
  return <div className="cup-pitch-scene" role="img" aria-label="Animated 3D illustration of a 4 vs 4 football match">
    <span className="cup-floodlight cup-floodlight-left" aria-hidden="true" />
    <span className="cup-floodlight cup-floodlight-right" aria-hidden="true" />
    <div className="cup-pitch-rig" aria-hidden="true">
      <div className="cup-pitch">
        <i className="pitch-line pitch-halfway" /><i className="pitch-circle" /><i className="pitch-spot" />
        <i className="pitch-box pitch-box-left" /><i className="pitch-box pitch-box-right" />
        <i className="pitch-goal pitch-goal-left" /><i className="pitch-goal pitch-goal-right" />
        {pitchPlayers.map((player, index) => <span key={index}
          className={`pitch-player kit-${player.kit}${player.keeper ? ' is-keeper' : ''}`}
          style={{
            '--x1': `${player.path[0][0]}%`, '--y1': `${player.path[0][1]}%`,
            '--x2': `${player.path[1][0]}%`, '--y2': `${player.path[1][1]}%`,
            '--x3': `${player.path[2][0]}%`, '--y3': `${player.path[2][1]}%`,
            animationDuration: `${player.speed}s`, animationDelay: `${player.delay}s`,
          } as CSSProperties}>
          <i className="pitch-shadow" />
          <span className="pitch-figure"><i className="pp-head" /><i className="pp-shirt"><b>{player.number}</b></i>
            <i className="pp-shorts" /><i className="pp-leg pp-leg-l" /><i className="pp-leg pp-leg-r" /></span>
        </span>)}
        <span className="pitch-ball"><i className="pitch-shadow" /><span className="pitch-ball-body">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="48" fill="#f7fafc" stroke="#1b2530" strokeWidth="3" />
            <path d="M50 30 66 42 60 61 40 61 34 42Z M50 30 48 10 34 4 22 17 26 34 34 42 M66 42 75 29 92 32 97 48 88 61 70 60 60 61 M40 61 29 75 34 92 50 97 65 91 70 75 60 61 M26 34 10 31 3 47 10 63 29 75 M70 75 88 61 95 68 85 85 65 91" fill="none" stroke="#28313b" strokeWidth="3" strokeLinejoin="round" />
            <path d="M50 30 66 42 60 61 40 61 34 42Z M34 4 48 10 50 0 37 2Z M3 47 10 31 26 34 22 17 9 23Z M75 29 92 32 85 15 73 9 69 20Z M10 63 29 75 34 92 17 86 5 69Z M70 75 88 61 95 68 85 85 65 91Z" fill="#202830" />
          </svg>
        </span></span>
        <span className="cup-pitch-light" />
      </div>
    </div>
    <span className="cup-scene-hud" aria-hidden="true"><i />4 V 4 · INTERNAL CUP</span>
    <span className="cup-scene-caption">THE GAME IS OURS</span>
  </div>
}

function captainFirst(team: Team) {
  const players = team.players ?? []
  const captain = players.find((player) => player.id === team.captain_player_id)
  return captain ? [captain, ...players.filter((player) => player.id !== captain.id)] : players
}

function Squads({ teams }: { teams: Team[] }) {
  return <section className="cup-card">
    <SectionTitle eyebrow="All teams" title="Squads" detail="Captain tags reflect the recorded auction captain while they remain in that squad." />
    {teams.length ? <div className="cup-roster-board">{teams.map((team) => <article className="cup-roster-team" key={team.id}>
      <a className="cup-roster-head" href={`/teams/${team.id}`}>
        <Portrait path={team.logo_path} name={team.name} className="cup-roster-logo" />
        <span><strong>{team.name}</strong><small>{team.players?.length ?? 0} players</small></span><b>→</b>
      </a>
      <ul>{team.players?.length ? captainFirst(team).map((player) => <li key={player.id}>
        <a href={`/players/${player.id}`}>
          <Portrait path={player.photo_path} name={player.name} className="cup-roster-photo" />
          <span><strong>{player.name}</strong><small>{player.position}</small>
            {team.captain_player_id === player.id && <b className="cup-captain">Captain</b>}</span>
        </a></li>) : <li className="cup-empty-text">No players yet.</li>}</ul>
    </article>)}</div> : <p className="cup-empty-text">Squads appear once the host adds teams and players.</p>}
  </section>
}

function finalizedOutcome(match: Match | undefined) {
  if (!match || match.state !== 'finalized' || !match.home_team || !match.away_team) return null
  const winner = match.home_goals > match.away_goals ? match.home_team
    : match.away_goals > match.home_goals ? match.away_team
      : [match.home_team, match.away_team].find((team) => team.id === match.shootout_winner_team_id)
  return winner ? { winner, loser: winner.id === match.home_team.id ? match.away_team : match.home_team } : null
}

function ChampionBanner({ tournament }: { tournament: Tournament }) {
  const final = tournament.matches.find((match) => match.stage === 'final')
  const result = finalizedOutcome(final)
  if (!final || !result) return null
  return <section className="cup-champions-banner" aria-label="Cup champions">
      <svg className="cup-champions-trophy" viewBox="0 0 100 110" fill="none" aria-hidden="true">
        <path d="M25 14h50v24c0 21-12 34-25 34S25 59 25 38V14Z" fill="currentColor" fillOpacity=".15" stroke="currentColor" strokeWidth="4" />
        <path d="M25 23H10v14c0 14 9 23 23 23M75 23h15v14c0 14-9 23-23 23M50 72v20M32 98h36M38 92h24" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        <path d="m50 27 4 9 10 1-8 7 2 10-8-5-8 5 2-10-8-7 10-1 4-9Z" fill="currentColor" />
      </svg>
      <div className="cup-champions-copy">
        <span className="cup-eyebrow">{tournament.edition} · INTERNAL CUP CHAMPIONS</span>
        <a className="cup-champions-team" href={`/teams/${result.winner.id}`}>
          <Portrait path={result.winner.logo_path} name={result.winner.name} className="cup-champions-crest" />
          <h2>{result.winner.name}</h2>
        </a>
        <p>Winners of the final · {final.home_team?.name} {final.home_goals}–{final.away_goals} {final.away_team?.name}
          {final.home_goals === final.away_goals && <> · penalties {final.shootout.home}–{final.shootout.away}</>}</p>
        <a className="cup-champions-replay" href={`/matches/${final.id}`}>Relive the final ↗</a>
      </div>
    </section>
}

function TournamentHighlights({ tournament }: { tournament: Tournament }) {
  const metrics = [
    { key: 'goals', title: 'Most goals', unit: 'goals' },
    { key: 'assists', title: 'Most assists', unit: 'assists' },
  ].map((metric) => {
    const rows = [...(tournament.leaderboards[metric.key] ?? [])].filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total || a.player.name.localeCompare(b.player.name) || a.player.id - b.player.id)
    return { ...metric, leaders: rows.slice(0, 3), shared: rows.filter((row) => row.total === rows[0]?.total).length }
  })
  if (!metrics.some((metric) => metric.leaders.length) && !finalizedOutcome(tournament.matches.find((match) => match.stage === 'final'))) return null
  const resultsComplete = tournament.matches.length === 12
    && tournament.matches.every((match) => match.state === 'finalized')
  return <section className="cup-spotlight" aria-label="Goal and assist leaders">
      <SectionTitle eyebrow={resultsComplete ? 'Tournament leaders' : 'Current tournament leaders'}
        title="Leading the cup" detail={resultsComplete ? 'All fixtures finalized' : 'Live totals · provisional'} />
      <div className="cup-spotlight-grid">{metrics.map((metric) => <article className="cup-spotlight-card" key={metric.key}
        aria-label={metric.title}>
        <header><h3>{metric.title}</h3><span>Top 3</span></header>
        {metric.leaders.length ? <>
          {metric.shared > 1 && <p className="cup-spotlight-shared">Shared lead · {metric.shared} players</p>}
          <ul>{metric.leaders.map((row) => <li key={row.player.id}>
            <a className="cup-leader-player" href={`/players/${row.player.id}`}>
              <span className="cup-leader-photo" aria-hidden="true"><Portrait path={row.player.photo_path} name={row.player.name} /></span>
              <span className="cup-spotlight-name"><b>{row.player.name}</b><small>{row.team?.name ?? row.player.position}</small></span>
              <strong className="cup-spotlight-total">{row.total} <small>{row.total === 1 ? metric.unit.slice(0, -1) : metric.unit}</small></strong>
            </a>
          </li>)}</ul>
        </> : <p className="cup-empty-text">No {metric.unit} recorded yet.</p>}
      </article>)}</div>
      <p className="cup-spotlight-note">Top three players per category; shared places and all players appear in <a href={`/tournaments/${tournament.id}?section=leaders`}>full Stats →</a>.
        {' '}Shootout kicks are excluded. Totals update with corrected or undone events.</p>
    </section>
}

function PlayoffAnnouncement({ tournament }: { tournament: Tournament }) {
  const league = tournament.matches.filter((match) => match.stage === 'league')
  if (league.length !== 10 || !league.every((match) => match.state === 'finalized')) return null
  const final = tournament.matches.find((match) => match.stage === 'final')
  const thirdPlace = tournament.matches.find((match) => match.stage === 'third_place')
  const finalResult = finalizedOutcome(final)
  const thirdResult = finalizedOutcome(thirdPlace)
  if (finalResult || thirdResult) return <section className="cup-playoff-announcement" role="status" aria-label="Playoff results">
    <span className="cup-eyebrow">CONFIRMED PLAYOFF RESULTS</span>
    <h3>{finalResult && thirdResult ? 'Your Internal Cup podium' : 'The podium is taking shape'}</h3>
    <div>
      {finalResult ? <>
        <p><b>Winners</b><a className="cup-podium-team" href={`/teams/${finalResult.winner.id}`}>{finalResult.winner.name}</a>
          <a href={`/matches/${final?.id}`}>Final match centre →</a></p>
        <p><b>Runners-up</b><a className="cup-podium-team" href={`/teams/${finalResult.loser.id}`}>{finalResult.loser.name}</a></p>
      </> : <p><b>Final</b><span>{final?.home_team?.name} <em>vs</em> {final?.away_team?.name}</span>
        <small>Winners and runners-up await a confirmed final result.</small></p>}
      <p><b>Third place</b>{thirdResult
        ? <><a className="cup-podium-team" href={`/teams/${thirdResult.winner.id}`}>{thirdResult.winner.name}</a>
          <a href={`/matches/${thirdPlace?.id}`}>Third-place match centre →</a></>
        : <small>Awaiting a confirmed third-place result.</small>}</p>
    </div>
  </section>
  const waiting = Boolean(tournament.unresolved_tie) || tournament.standings.length !== 5
  return <section className="cup-playoff-announcement" role="status" aria-label="Playoff qualification">
    <span className="cup-eyebrow">LEAGUE COMPLETE</span>
    <h3>{waiting ? 'Playoff places awaiting a tie decision' : 'Your playoff line-up is set'}</h3>
    {waiting ? <p>The host must resolve the exact sporting tie before the final and third-place participants are confirmed. Alphabetical display order does not decide qualification.</p>
      : <div>{(['final', 'third_place'] as const).map((stage) => {
        const fixture = tournament.matches.find((match) => match.stage === stage)
        const offset = stage === 'final' ? 0 : 2
        const sides = fixture ? [fixture.home_team, fixture.away_team] : tournament.standings.slice(offset, offset + 2)
        return <p key={stage}><b>{stage === 'final' ? 'Final' : 'Third-place match'}</b>
          <span>{sides[0]?.name} <em>vs</em> {sides[1]?.name}</span>
          {fixture && <a href={`/matches/${fixture.id}`}>Match centre →</a>}
        </p>
      })}</div>}
    {!waiting && tournament.matches.length === 10 && <small>Qualified from the official table. Fixtures appear once the host adds the final and third-place match.</small>}
  </section>
}

function HomePage({ tournaments, error, loading }: { tournaments: Tournament[]; error: string; loading: boolean }) {
  const featured = tournaments[0]
  const matches = featured?.matches ?? []
  const started = Boolean(featured && ['running', 'paused', 'completed'].includes(featured.lifecycle))
  const live = matches.filter((match) => ['live', 'paused', 'review'].includes(match.state))
  const upcoming = matches.filter((match) => match.state === 'scheduled')
    .sort((a, b) => (a.scheduled_at ? Date.parse(a.scheduled_at) : Infinity)
      - (b.scheduled_at ? Date.parse(b.scheduled_at) : Infinity) || a.match_order - b.match_order)
  const completed = matches.filter((match) => match.state === 'finalized')
    .sort((a, b) => (b.finalized_at ?? '').localeCompare(a.finalized_at ?? '') || b.match_order - a.match_order)
  const announced = Boolean(featured && ['published', 'running', 'paused', 'completed'].includes(featured.lifecycle))
  return <CupLayout active="home">
    {featured && !error && <ChampionBanner tournament={featured} />}
    {featured && !error && <PlayoffAnnouncement tournament={featured} />}
    {!loading && !error && started && <section className="cup-home-matches cup-home-matches-live" aria-label="Matchday">
      <div className="cup-home-match-group cup-home-live">
        <SectionTitle eyebrow="Matchday" title="Live now" />
        <div className="cup-fixtures">{live.length ? live.map((match) => <MatchCard key={match.id} match={match} showHighlights />)
          : <p className="cup-empty-text">No match is live right now.</p>}</div>
        {completed[0] && <div className="cup-home-latest">
          <h3>Latest result</h3>
          <MatchCard match={completed[0]} />
        </div>}
      </div>
    </section>}
    <section className="cup-home-hero">
      <div className="cup-hero-copy">
        <span className="cup-eyebrow">VENOMS FC · CLUB COMPETITION</span>
        <h1>One club.<br /><em>Five rivals.</em><br />One cup<span className="cup-orange-dot">.</span></h1>
        <p>Every goal, save and moment matters. Follow the Venoms Internal Cup as it unfolds.</p>
        <div className="cup-hero-actions"><a className="cup-primary-button" href={featured ? `/tournaments/${featured.id}` : '/tournaments'}>Explore the cup <span>→</span></a>
          <a className="cup-secondary-link" href="/players">Meet the players</a></div>
      </div>
      <PitchScene />
    </section>
    {error && <div className="cup-alert" role="alert">{error}</div>}
    {loading && <p className="cup-loading" role="status">Loading the club competition…</p>}
    {featured && announced && (upcoming.length > 0 || completed.length > 0 || live.length > 0) &&
      <section className="cup-card cup-home-fixtures" aria-labelledby="cup-home-fixtures-title">
        <div className="cup-section-title"><div><span className="cup-eyebrow">On the schedule</span>
          <h2 id="cup-home-fixtures-title">Fixtures & results</h2></div>
          <a className="cup-section-detail" href={`/tournaments/${featured.id}?section=fixtures`}>All fixtures →</a></div>
        <div className="cup-home-fixture-groups">
          {live.length > 0 && <div className="cup-home-fixture-group">
            <h3>On the pitch</h3>
            <div className="cup-fixtures">{live.map((match) => <MatchCard key={match.id} match={match} />)}</div>
          </div>}
          {upcoming.length > 0 && <div className="cup-home-fixture-group">
            <h3>Up next <small>{upcoming.length} to play</small></h3>
            <div className="cup-fixtures">{upcoming.map((match) => <MatchCard key={match.id} match={match} />)}</div>
          </div>}
          {completed.length > 0 && <div className="cup-home-fixture-group">
            <h3>Results <small>{completed.length} completed</small></h3>
            <div className="cup-fixtures">{completed.map((match) => <MatchCard key={match.id} match={match} />)}</div>
          </div>}
        </div>
      </section>}
    {featured && !error && <TournamentHighlights tournament={featured} />}
    {featured && announced && <a className="cup-featured-banner" href={`/tournaments/${featured.id}`}>
      <span className="cup-eyebrow">VENOMS INTERNAL CUP · {featured.edition}</span>
      <strong>{featured.name}</strong>
      <span className="cup-featured-banner-meta"><StatusPill value={featured.lifecycle} />{featured.teams.length} teams · {featured.matches.length} matches</span>
      <b>Table, stats & squads →</b>
    </a>}
    {featured && !announced && <section className="cup-featured">
      <div><span className="cup-eyebrow">VENOMS INTERNAL CUP · {featured.edition}</span>
        <h2>{featured.name}</h2><p>Live fixtures, standings and player statistics for the Internal Cup.</p>
        <a className="cup-primary-button" href={`/tournaments/${featured.id}`}>Open tournament <span>→</span></a></div>
      <div className="cup-feature-meta"><StatusPill value={featured.lifecycle} /><span>{featured.teams.length} teams</span>
        <span>{featured.matches.length || '—'} matches in the edition</span></div>
    </section>}
    {!featured && !loading && !error && <section className="cup-empty-feature">
      <span className="cup-eyebrow">THE FIRST WHISTLE IS CLOSE</span><h2>Internal Cup, coming soon.</h2>
      <p>The host will publish the tournament here. The completed auction stays available in its own section.</p>
      <a className="cup-secondary-link" href="/auction">Visit the auction archive →</a>
    </section>}
    {featured && <Squads teams={featured.teams} />}
    <section className="cup-home-grid">
      <a className="cup-home-tile" href={featured ? `/tournaments/${featured.id}` : '/tournaments'}><span>01 / COMPETITION</span><strong>Follow every fixture</strong><small>League table · live match centre · finals</small></a>
      <a className="cup-home-tile" href="/players"><span>02 / PLAYER DIRECTORY</span><strong>Know the squad</strong><small>Shared player identities and cup stats</small></a>
      <a className="cup-home-tile" href="/auction"><span>03 / AUCTION ARCHIVE</span><strong>Where teams began</strong><small>Original auction experience and history</small></a>
    </section>
  </CupLayout>
}

function TournamentsPage({ tournaments, error, loading }: { tournaments: Tournament[]; error: string; loading: boolean }) {
  return <CupLayout active="tournaments">
    <div className="cup-page-intro"><span className="cup-eyebrow">THE COMPETITION</span><h1>Venoms Internal Cup</h1>
      <p>One round robin. Four league games per team. The top two meet in the final; third and fourth play for bronze.</p></div>
    {error && <div className="cup-alert" role="alert">{error}</div>}
    {loading && <p className="cup-loading" role="status">Loading tournaments…</p>}
    {tournaments.length ? <div className="cup-tournament-list">{tournaments.map((tournament) => <a key={tournament.id}
      href={`/tournaments/${tournament.id}`} className="cup-tournament-card">
      <div className="cup-tournament-card-top"><span className="cup-eyebrow">{tournament.edition}</span><StatusPill value={tournament.lifecycle} /></div>
      <h2>{tournament.name}</h2><p>Venoms FC · {tournament.teams.length || 5} teams · Internal Cup</p>
      <div className="cup-card-foot"><span>Open tournament</span><b>↗</b></div></a>)}</div>
      : !loading && <div className="cup-empty-feature"><h2>No tournaments published yet.</h2><p>The host dashboard will show a tournament here after fixtures are reviewed and published.</p></div>}
  </CupLayout>
}

function TournamentPage({ tournament, error, loading, onRemovalChanged }: {
  tournament: Tournament | null; error: string; loading: boolean; onRemovalChanged: () => void
}) {
  const sections = [
    ['overview', 'Overview'], ['table', 'Table'], ['fixtures', 'Fixtures'],
    ['leaders', 'Stats'], ['squads', 'Squads'],
  ] as const
  const requestedSection = new URLSearchParams(window.location.search).get('section')
  const selectedSection = sections.some(([key]) => key === requestedSection) ? requestedSection : 'overview'
  const showSection = (section: string) => selectedSection === 'overview' || selectedSection === section
  const leagueMatches = tournament?.matches.filter((match) => match.stage === 'league') ?? []
  const leagueComplete = leagueMatches.length === 10 && leagueMatches.every((match) => match.state === 'finalized')
  const tieDecisionNeeded = leagueComplete && Boolean(tournament?.unresolved_tie)
  return <CupLayout active="tournaments">
    <div className="cup-breadcrumb"><a href="/">Home</a><span>/</span><a href="/tournaments">Tournaments</a><span>/</span><span>Internal Cup</span></div>
    {error && <div className="cup-alert" role="alert">{error}</div>}
    {loading && <p className="cup-loading" role="status">Loading tournament details…</p>}
    <TournamentRemoval tournamentId={Number(window.location.pathname.split('/').at(-1))}
      version={tournament?.version} onRemovalChanged={onRemovalChanged} />
    {tournament && <>
      <section className="cup-tournament-hero">
        <div><span className="cup-eyebrow">{tournament.edition} · VENOMS FC</span><h1>{tournament.name}</h1>
          <p>Every team meets once. Points, goal difference and goals scored decide the league phase.</p></div>
        <StatusPill value={tournament.lifecycle} />
      </section>
      <nav className="cup-tabs" aria-label="Tournament sections">
        {sections.map(([key, label]) => <a key={key}
          href={key === 'overview' ? `/tournaments/${tournament.id}` : `/tournaments/${tournament.id}?section=${key}`}
          aria-current={selectedSection === key ? 'page' : undefined}>{label}</a>)}
      </nav>
      <ChampionBanner tournament={tournament} />
      <PlayoffAnnouncement tournament={tournament} />
      {selectedSection === 'overview' && <section className="cup-overview-strip">
        <div><strong>{tournament.teams.length || 5}</strong><span>teams</span></div>
        <div><strong>{tournament.matches.filter((match) => match.stage === 'league').length || 10}</strong><span>league fixtures</span></div>
        <div><strong>{tournament.matches.filter((match) => match.state === 'finalized').length}</strong><span>completed</span></div>
        <div><strong>{tournament.standings.reduce((sum, row) => sum + row.goals_for, 0)}</strong><span>league goals</span></div>
      </section>}
      {showSection('table') && <Table tournament={tournament} tieDecisionNeeded={tieDecisionNeeded} />}
      <TournamentHighlights tournament={tournament} />
      {showSection('table') && <QualificationOutlook tournament={tournament} />}
      {showSection('fixtures') && <section className="cup-card">
        <SectionTitle eyebrow="Schedule" title="Fixtures & results" detail="One pitch · no back-to-back team appearances" />
        <div className="cup-fixtures">{tournament.matches.length
          ? tournament.matches.map((match) => <MatchCard key={match.id} match={match} />)
          : <p className="cup-empty-text">Fixtures appear after the host publishes the reviewed schedule.</p>}</div>
      </section>}
      {showSection('leaders') && <div className="cup-leader-grid">
        {([
          ['goals', 'Top scorers'], ['assists', 'Top assists'], ['saves', 'Top saves'],
          ['shots_on_target', 'Shots on target'],
          ['own_goals', 'Own goals'], ['yellow_cards', 'Yellow cards'], ['red_cards', 'Red cards'],
        ] as const).map(([key, title]) => <Leaderboard key={key} title={title}
          metric="LIVE · PROVISIONAL" rows={tournament.leaderboards[key] ?? []} />)}
      </div>}
      {showSection('squads') && <Squads teams={tournament.teams} />}
      <p className="cup-updated"><span>Live / provisional standings · Cup host activity last recorded {new Date(tournament.updated_at).toLocaleString(undefined, { hour12: true })}</span>
        {tieDecisionNeeded ? ' · Host ranking decision pending' : ''}</p>
    </>}
  </CupLayout>
}

function PlayersPage({ players, error, loading }: { players: Player[]; error: string; loading: boolean }) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => players.filter((player) =>
    `${player.name} ${player.position} ${player.teams?.map((team) => team.name).join(' ') ?? ''}`
      .toLocaleLowerCase().includes(query.toLocaleLowerCase())), [players, query])
  return <CupLayout active="players">
    <div className="cup-page-intro"><span className="cup-eyebrow">PLAYER DIRECTORY</span><h1>Every Venoms player.</h1>
      <p>Shared player profiles across the auction and Internal Cup. Football statistics come only from recorded cup matches.</p></div>
    <label className="cup-search"><span className="sr-only">Search players</span><span aria-hidden="true">⌕</span>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a player, team or position" /></label>
    {error && <div className="cup-alert" role="alert">{error}</div>}
    {loading && <p className="cup-loading" role="status">Loading the player directory…</p>}
    <div className="cup-player-grid">{filtered.map((player) => <a href={`/players/${player.id}`} key={player.id} className="cup-player-card">
      <Portrait path={player.photo_path} name={player.name} className="cup-player-photo" />
      <div><span className="cup-eyebrow">{player.position}</span><h2>{player.name}</h2>
        <small>{player.teams?.map((team) => team.name).join(' · ') || 'Cup roster pending'}</small></div>
      <span className="cup-player-arrow" aria-hidden="true">↗</span>
    </a>)}</div>
    {!loading && !error && !filtered.length && <p className="cup-empty-feature">No players match that search.</p>}
  </CupLayout>
}

function PlayerPage({ player, error, loading }: { player: Player | null; error: string; loading: boolean }) {
  const stats = player?.statistics ?? {}
  const statLabels = [
    ['goals', 'Goals'], ['assists', 'Assists'], ['shots', 'Shots'], ['shots_on_target', 'On target'],
    ['saves', 'Saves'], ['own_goals', 'Own goals'], ['yellow_cards', 'Yellow cards'],
    ['red_cards', 'Red cards'], ['second_yellow_reds', 'Second-yellow dismissals'],
  ] as const
  return <CupLayout active="players">
    <div className="cup-breadcrumb"><a href="/">Home</a><span>/</span><a href="/players">Players</a><span>/</span><span>Profile</span></div>
    {error && <div className="cup-alert" role="alert">{error}</div>}
    {loading && <p className="cup-loading" role="status">Loading player profile…</p>}
    {player && <><section className="cup-profile-hero">
      <Portrait path={player.photo_path} name={player.name} className="cup-profile-photo" />
      <div><span className="cup-eyebrow">VENOMS FC · PLAYER PROFILE</span><h1>{player.name}</h1>
        <p>{player.position} · {player.teams?.map((team) => team.name).join(' / ') || 'No active cup squad'}</p>
        {player.teams?.map((team) => <a className="cup-secondary-link" key={team.id} href={`/teams/${team.id}`}>{team.name} squad →</a>)}
      </div>
    </section>
    <section className="cup-card"><SectionTitle eyebrow="Internal Cup" title="Tournament statistics" detail="Only recorded match events are counted." />
      <div className="cup-player-stats">{statLabels.map(([key, label]) => <div key={key}>
        <strong>{stats[key] ?? 0}</strong><span>{label}</span></div>)}</div>
    </section>
    <section className="cup-card"><SectionTitle eyebrow="Internal Cup" title="Match history" detail={`${stats.appearances ?? 0} appearances`} />
      {player.matches?.length
        ? <div className="cup-fixtures">{player.matches.map((match) => <MatchCard key={match.id} match={match} />)}</div>
        : <p className="cup-empty-text">This player has no recorded cup appearances yet.</p>}
    </section></>}
  </CupLayout>
}

function MatchPage({ match, error, loading }: { match: Match | null; error: string; loading: boolean }) {
  const [clockNow, setClockNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const elapsed = match?.clock.anchor && match.state === 'live'
    ? Number(match.clock.elapsed_seconds ?? 0)
      + Math.max(0, Math.floor((clockNow - Date.parse(match.clock.anchor)) / 1000))
    : Number(match?.clock.elapsed_seconds ?? 0)
  const clockLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  const shootoutHome = match?.shootout.home ?? 0
  const shootoutAway = match?.shootout.away ?? 0
  const shootoutWinner = match?.state === 'finalized' && match.shootout_winner_team_id
    ? [match.home_team, match.away_team].find((team) => team?.id === match.shootout_winner_team_id)?.name
    : null
  const isShootoutPeriod = match?.clock.period === 'shootout'
  const isHalfTime = match?.clock.period === 'half_time_break'
  const seenEventIds = useRef<{ matchId: number; ids: Set<number> } | null>(null)
  const [goalBurst, setGoalBurst] = useState<{ id: number; team: string; scorer: string } | null>(null)
  useEffect(() => {
    if (!match) return
    const seen = seenEventIds.current
    if (!seen || seen.matchId !== match.id) {
      // The first payload is the baseline: goals already on the board never replay on load or refresh.
      seenEventIds.current = { matchId: match.id, ids: new Set(match.events.map((event) => event.id)) }
      return
    }
    const fresh = match.events.filter((event) => !seen.ids.has(event.id))
    fresh.forEach((event) => seen.ids.add(event.id))
    const goal = fresh.filter((event) => !event.voided
      && ((event.event_type === 'shot' && event.outcome === 'goal') || event.event_type === 'own_goal')).at(-1)
    if (!goal) return
    const creditedTeam = goal.event_type === 'own_goal'
      ? goal.team_id === match.home_team_id ? match.away_team : match.home_team
      : goal.team_id === match.home_team_id ? match.home_team : match.away_team
    setGoalBurst({ id: goal.id, team: creditedTeam?.name ?? 'Goal', scorer: `${goal.player?.name ?? 'Player'}${goal.event_type === 'own_goal' ? ' (OG)' : ''}` })
  }, [match])
  useEffect(() => {
    if (!goalBurst) return
    const timer = window.setTimeout(() => setGoalBurst(null), 3200)
    return () => window.clearTimeout(timer)
  }, [goalBurst])
  return <CupLayout active="tournaments">
    <div className="cup-breadcrumb"><a href="/">Home</a><span>/</span><a href="/tournaments">Tournament</a><span>/</span><span>Match centre</span></div>
    {error && <div className="cup-alert" role="alert">{error}</div>}
    {loading && <p className="cup-loading" role="status">Loading match centre…</p>}
    {match && <><section className="cup-scoreboard">
      <div className="cup-score-meta"><span className="cup-eyebrow">{match.stage.replace('_', ' ')} · MATCH {match.match_order}</span><StatusPill value={match.state} /></div>
      <div className="cup-score-teams">
        <a href={match.home_team ? `/teams/${match.home_team.id}` : '#'}>{match.home_team && <Portrait path={match.home_team.logo_path} name={match.home_team.name} className="cup-score-logo" />}
          <strong>{match.home_team?.name ?? 'To be confirmed'}</strong></a>
        <div className="cup-score-number">{match.home_team ? match.home_goals : '—'}<i>:</i>{match.away_team ? match.away_goals : '—'}
          <small>{match.state === 'finalized' ? (match.shootout_winner_team_id ? `Full time · pens ${shootoutHome}–${shootoutAway}` : 'Full time') : isShootoutPeriod ? `Penalty shoot-out · ${shootoutHome}–${shootoutAway}`
            : isHalfTime ? 'Half-time break'
              : match.clock.period
                ? `${match.clock.period.replace(/_/g, ' ')}${match.state === 'live' ? ` · ${clockLabel}` : match.state === 'paused' ? ` · paused at ${clockLabel}` : ''}`
            : match.scheduled_at ? new Date(match.scheduled_at).toLocaleString(undefined, { hour12: true }) : 'Kickoff pending'}</small></div>
        <a href={match.away_team ? `/teams/${match.away_team.id}` : '#'}>{match.away_team && <Portrait path={match.away_team.logo_path} name={match.away_team.name} className="cup-score-logo" />}
          <strong>{match.away_team?.name ?? 'To be confirmed'}</strong></a>
      </div>
      <div className="cup-score-highlights">
        <TeamHighlights match={match} teamId={match.home_team_id} side="home" />
        <TeamHighlights match={match} teamId={match.away_team_id} side="away" />
      </div>
      {goalBurst && <div className="cup-goal-burst" key={goalBurst.id} data-testid="cup-goal-burst">
        <svg viewBox="0 0 240 120" aria-hidden="true" className="cup-goal-art">
          <defs><pattern id="cup-net" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M0 0 10 10 M10 0 0 10" stroke="#e8fff4" strokeOpacity=".35" strokeWidth="1" /></pattern></defs>
          <g className="cup-goal-net"><path d="M40 22 H200 L184 104 H56 Z" fill="url(#cup-net)" /></g>
          <path d="M40 104 V22 H200 V104" fill="none" stroke="#f7fafc" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="16" y1="108" x2="224" y2="108" stroke="#aef25b" strokeOpacity=".6" strokeWidth="2" />
          <g className="cup-goal-ball"><circle r="11" fill="#f7fafc" stroke="#1b2530" strokeWidth="2" />
            <path d="M0-5 5-1 3 5-3 5-5-1Z" fill="#202830" /></g>
        </svg>
        <strong>GOAL!</strong><span>{goalBurst.scorer} · {goalBurst.team}</span>
      </div>}
      <p className="sr-only" aria-live="polite">{goalBurst ? `Goal for ${goalBurst.team}, scored by ${goalBurst.scorer}` : ''}</p>
    </section>
    {isShootoutPeriod || match.events.some((event) => event.event_type === 'shootout')
      ? <section className="cup-card cup-shootout-summary" aria-label="Penalty shoot-out">
        <SectionTitle eyebrow="Penalty shoot-out" title={`${shootoutHome} – ${shootoutAway}`} />
        {shootoutWinner && <p><strong>{shootoutWinner} win on penalties.</strong></p>}
        {match.shootout_finish && <p>{match.shootout_finish.host_decided
          ? 'Scores tied: winner explicitly awarded by the host. No extra kicks were added.'
          : 'Shootout finished by the host at the recorded score.'}</p>}
        {match.stage === 'league' && <p>League penalties after a {match.home_goals}–{match.away_goals} draw: the regulation score counts for goals and player statistics; the shoot-out winner takes 3 points and the loser 0.</p>}
      </section> : null}
    <section className="cup-card"><SectionTitle eyebrow="Match centre" title="Line-ups & participation" detail="Starters, substitutes and goalkeepers" />
      <div className="cup-participation-grid">{[match.home_team, match.away_team].filter((side): side is Team => side !== null).map((side) =>
        <section key={side.id} aria-label={`${side.name} match participation`}>
          <h3>{side.name}</h3>
          {(['starter', 'entered', 'bench', 'substituted', 'dismissed'] as const).map((status) => {
            const rows = match.participations.filter((row) => row.team_id === side.id && row.status === status)
            return rows.length ? <div key={status} className="cup-participation-group">
              <h4>{status === 'entered' ? 'Substitutes on' : status === 'substituted' ? 'Substituted off' : status.replace(/_/g, ' ')}</h4>
              <ul>{rows.map((row, index) =>
                <li key={`${row.player?.id ?? index}-${row.status}`}>
                  <span>{row.player?.name ?? 'Player'}</span>
                  {row.goalkeeper && <small>Goalkeeper</small>}
                </li>)}
              </ul>
            </div> : null
          })}
        </section>)}</div>
    </section>
    <section className="cup-card"><SectionTitle eyebrow="Match centre" title="Event timeline" detail={`${match.events.length} recorded events`} />
      <ol className="cup-event-timeline">{match.events.length ? match.events.map((event) => <li key={event.id}>
        <span className="cup-event-minute">{event.minute}&prime;</span>
        <span className={`cup-event-icon cup-event-${event.event_type}`}>{event.event_type === 'shot' ? event.outcome === 'goal' ? '⚽' : event.outcome === 'saved' ? '▣' : '↗' : event.event_type === 'yellow_card' ? '🟨' : event.event_type === 'red_card' ? '🟥' : event.event_type === 'own_goal' ? 'OG' : event.event_type === 'shootout' ? 'PK' : '↔'}</span>
        <span><strong>{event.player?.name ?? 'Player'}</strong>
          <small>{event.period.replace(/_/g, ' ')} · {event.event_type === 'shot' ? event.outcome?.replace(/_/g, ' ')
            : event.event_type === 'shootout' ? event.payload?.scored === true ? 'Penalty scored' : 'Penalty missed'
              : event.event_type === 'substitution' ? 'Substitution'
                : event.event_type === 'yellow_card' && event.payload?.second_yellow_dismissal === true
                  ? 'Second yellow · sent off' : event.event_type.replace(/_/g, ' ')}
            {event.assist ? ` · assist ${event.assist.name}` : ''}
            {event.goalkeeper ? ` · save by ${event.goalkeeper.name}` : ''}</small></span>
        {event.event_type === 'substitution' && <small className="cup-event-substitute">
          On: {match.participations.find((row) => row.player?.id === Number(event.payload?.incoming_player_id))?.player?.name ?? 'Substitute'}
        </small>}
      </li>) : <li className="cup-empty-text">No match events recorded yet.</li>}</ol>
    </section></>}
  </CupLayout>
}

function TeamPage({ team, error, loading }: { team: Team | null; error: string; loading: boolean }) {
  return <CupLayout active="tournaments">
    <div className="cup-breadcrumb"><a href="/">Home</a><span>/</span><a href="/tournaments">Tournament</a><span>/</span><span>Team profile</span></div>
    {error && <div className="cup-alert" role="alert">{error}</div>}
    {loading && <p className="cup-loading" role="status">Loading team…</p>}
    {team && <><section className="cup-team-hero"><Portrait path={team.logo_path} name={team.name} className="cup-team-profile-logo" />
      <div><span className="cup-eyebrow">VENOMS INTERNAL CUP</span><h1>{team.name}</h1>
        <p>{team.players?.length ?? 0} players in the squad</p></div></section>
      <section className="cup-card"><SectionTitle eyebrow="Team players" title="Squad" detail="Captain tag reflects the recorded auction captain while they remain in this squad." />
        <div className="cup-player-tiles">{captainFirst(team).map((player) => <a className="cup-player-tile" key={player.id} href={`/players/${player.id}`}>
          <Portrait path={player.photo_path} name={player.name} className="cup-player-tile-photo" />
          <span><strong>{player.name}</strong><small>{player.position}</small>
            {team.captain_player_id === player.id && <b className="cup-captain">Captain</b>}</span>
          <em>View profile ↗</em></a>)}</div>
      </section>
      <section className="cup-card"><SectionTitle eyebrow="Tournament schedule" title="Fixtures & results" />
        <div className="cup-fixtures">{team.matches?.map((match) => <MatchCard key={match.id} match={match} />)}</div>
      </section></>}
  </CupLayout>
}

export default function Website() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tournaments, setTournaments] = useState<Tournament[]>([])
  const [tournament, setTournament] = useState<Tournament | null>(null)
  const [tournamentRefresh, setTournamentRefresh] = useState(0)
  const [players, setPlayers] = useState<Player[]>([])
  const [player, setPlayer] = useState<Player | null>(null)
  const [match, setMatch] = useState<Match | null>(null)
  const [team, setTeam] = useState<Team | null>(null)
  const refreshTournament = useCallback(() => {
    setTournament(null)
    setError('')
    setLoading(true)
    setTournamentRefresh((revision) => revision + 1)
  }, [])

  useEffect(() => {
    const title = path === '/' || path === '/home' ? 'Venoms FC | Internal Cup'
      : path === '/tournaments' ? 'Tournaments | Venoms FC'
        : /^\/tournaments\/\d+$/.test(path) ? `${tournament?.name ?? 'Tournament'} | Venoms FC`
          : path === '/players' ? 'Players | Venoms FC'
            : /^\/players\/\d+$/.test(path) ? `${player?.name ?? 'Player'} | Venoms FC`
              : /^\/matches\/\d+$/.test(path) ? 'Match centre | Venoms FC'
                : /^\/teams\/\d+$/.test(path) ? `${team?.name ?? 'Team'} | Venoms FC`
                  : path === '/tournament-host' ? 'Tournament host | Venoms FC'
                    : 'Page not found | Venoms FC'
    document.title = title
  }, [path, tournament?.name, player?.name, team?.name])

  useEffect(() => {
    const controller = new AbortController()
    let active = false
    let hasLoaded = false
    async function load() {
      if (active) return
      active = true
      if (!hasLoaded) setLoading(true)
      setError('')
      try {
        if (path === '/' || path === '/home') {
          const result = await request<{ tournaments: TournamentSummary[] }>('/api/cup?summary=1', { signal: controller.signal })
          const featured = result.tournaments.find((row) => ['running', 'paused'].includes(row.lifecycle))
            ?? result.tournaments.find((row) => row.lifecycle === 'published')
            ?? result.tournaments.find((row) => row.lifecycle === 'completed') ?? result.tournaments[0]
          const details = featured
            ? await request<{ tournament: Tournament }>(`/api/cup/${featured.id}`, { signal: controller.signal })
            : null
          setTournaments(details ? [details.tournament] : [])
        } else if (path === '/tournaments') {
          const result = await request<{ tournaments: Tournament[] }>('/api/cup', { signal: controller.signal })
          setTournaments(result.tournaments)
        } else if (path === '/players') {
          const result = await request<{ players: Player[] }>('/api/cup/players', { signal: controller.signal })
          setPlayers(result.players)
        } else if (/^\/tournaments\/\d+$/.test(path)) {
          const result = await request<{ tournament: Tournament }>(`/api/cup/${path.split('/').at(-1)}`, { signal: controller.signal })
          if (!controller.signal.aborted) setTournament(result.tournament)
        } else if (/^\/players\/\d+$/.test(path)) {
          const result = await request<{ player: Player }>(`/api/cup/players/${path.split('/').at(-1)}`, { signal: controller.signal })
          setPlayer(result.player)
        } else if (/^\/matches\/\d+$/.test(path)) {
          const result = await request<{ match: Match }>(`/api/cup/matches/${path.split('/').at(-1)}`, { signal: controller.signal })
          setMatch(result.match)
        } else if (/^\/teams\/\d+$/.test(path)) {
          const result = await request<{ team: Team }>(`/api/cup/teams/${path.split('/').at(-1)}`, { signal: controller.signal })
          setTeam(result.team)
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          if (/^\/tournaments\/\d+$/.test(path) && caught instanceof ApiError && caught.status === 404) {
            setTournament(null)
          }
          setError(messageOf(caught))
        }
      } finally {
        if (!controller.signal.aborted) {
          hasLoaded = true
          setLoading(false)
          active = false
        }
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [path, tournamentRefresh])

  if (path === '/tournament-host') return <TournamentHostPage />
  if (path === '/' || path === '/home') return <HomePage tournaments={tournaments} error={error} loading={loading} />
  if (path === '/tournaments') return <TournamentsPage tournaments={tournaments} error={error} loading={loading} />
  if (path === '/players') return <PlayersPage players={players} error={error} loading={loading} />
  if (/^\/tournaments\/\d+$/.test(path)) return <TournamentPage tournament={tournament} error={error}
    loading={loading} onRemovalChanged={refreshTournament} />
  if (/^\/players\/\d+$/.test(path)) return <PlayerPage player={player} error={error} loading={loading} />
  if (/^\/matches\/\d+$/.test(path)) return <MatchPage match={match} error={error} loading={loading} />
  if (/^\/teams\/\d+$/.test(path)) return <TeamPage team={team} error={error} loading={loading} />
  return <CupLayout active=""><div className="cup-empty-feature"><span className="cup-eyebrow">404 · NOT FOUND</span>
    <h1>That page isn't on the fixture list.</h1><p>Return to the Venoms FC home page to find the cup, players or auction.</p>
    <a className="cup-primary-button" href="/">Back home →</a></div></CupLayout>
}

type HostHistory = { id: number; action: string; match_id: number | null; created_at: string; details: Record<string, unknown>; undone: boolean }
type CupSession = Pick<Session, 'authenticated' | 'csrf_token'>

function ArchivedTournaments() {
  const [rows, setRows] = useState<{ id: number; name: string; edition: string }[] | null>(null)
  const [error, setError] = useState('')
  return <details className="cup-archived-tournaments" onToggle={async (event) => {
    if (!event.currentTarget.open) return
    setError('')
    try {
      const result = await request<{ tournaments: { id: number; name: string; edition: string }[] }>('/api/cup/host/archived-tournaments')
      setRows(result.tournaments)
    } catch (caught) { setError(messageOf(caught)) }
  }}>
    <summary>Removed tournaments · recovery</summary>
    {error && <p role="alert">{error}</p>}
    {rows === null ? <p role="status">Loading removed tournaments…</p> : rows.length
      ? <ul>{rows.map((row) => <li key={row.id}><a href={`/tournaments/${row.id}`}>{row.name} · {row.edition} · #{row.id} →</a></li>)}</ul>
      : <p>No removed tournaments.</p>}
  </details>
}

type RemovalStatus = {
  id: number; name: string; version: number; lifecycle: string
  archive_audit_id: number | null; active_match_id: number | null
}

function TournamentRemoval({ tournamentId, version, onRemovalChanged }: {
  tournamentId: number; version?: number; onRemovalChanged: () => void
}) {
  const [session, setSession] = useState<CupSession | null>(null)
  const [status, setStatus] = useState<RemovalStatus | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [blocked, setBlocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const result = await request<{ tournament: RemovalStatus }>(`/api/cup/host/${tournamentId}/removal`)
      setStatus(result.tournament)
      setError('')
    } catch (caught) {
      setStatus(null)
      setError(`Host removal controls could not be refreshed. ${messageOf(caught)}`)
    }
  }, [tournamentId])

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const current = await request<CupSession>('/api/cup-auth/session', { signal: controller.signal })
        if (controller.signal.aborted) return
        setSession(current)
        if (current.authenticated) {
          setBlocked(window.sessionStorage.getItem(pendingCupCommandKey) !== null)
          await refresh()
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          setBlocked(true)
          setError(`Host removal controls are unavailable. ${messageOf(caught)}`)
        }
      }
    }
    void load()
    return () => controller.abort()
  }, [tournamentId, version, refresh])

  async function changeRemoval() {
    if (!session?.csrf_token || !status || blocked || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setNotice('')
    let sent = false
    let confirmed = false
    try {
      const restoring = status.lifecycle === 'archived'
      let resource = `/api/cup/host/${tournamentId}/archive`
      let body: Record<string, unknown> = { expected_version: status.version }
      if (restoring) {
        if (!status.archive_audit_id) throw new Error('This removal has no reversible archive action. Review its host history before recovering it.')
        const preview = await request<{ target: { id: number; action: string } | null; affected: { id: number }[]; expected_version: number }>(
          `/api/cup/host/${tournamentId}/undo-preview?target_audit_id=${status.archive_audit_id}`,
        )
        if (preview.target?.action !== 'tournament_archive' || preview.affected.length) {
          throw new Error('The removal changed or has later dependent actions. Review host history before recovering it.')
        }
        resource = `/api/cup/host/${tournamentId}/undo`
        body = { expected_version: preview.expected_version, target_audit_id: preview.target.id, cascade: false }
      }
      if (!window.confirm(restoring
        ? `Restore "${status.name}" to the tournament lists? Its retained fixtures, results and history will reappear.`
        : `Remove "${status.name}" from public and host tournament lists? Fixtures, results, history and all player/team records are retained, not deleted. You can restore it from Removed tournaments · recovery.`)) return
      const command: PendingCupCommand = {
        request_id: requestId(), resource, tournament_id: tournamentId, body: {},
      }
      command.body = { ...body, request_id: command.request_id }
      window.sessionStorage.setItem(pendingCupCommandKey, JSON.stringify(command))
      setBlocked(true)
      sent = true
      await request(resource, { method: 'POST', csrf: session.csrf_token, body: command.body })
      confirmed = true
      setNotice(restoring ? 'Tournament restored. Its retained records are available again.'
        : 'Tournament removed from lists. All records are retained for recovery; nothing was deleted.')
      window.sessionStorage.removeItem(pendingCupCommandKey)
      setBlocked(false)
      setStatus(null)
      onRemovalChanged()
      await refresh()
    } catch (caught) {
      setError(`${messageOf(caught)}${sent
        ? confirmed ? ' The action was saved, but its local receipt needs reconciliation. Open the host desk; do not repeat it.'
          : ' Do not repeat this request. Open the host desk to reconcile its recorded outcome.'
        : ' Nothing was sent.'}`)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (!session?.authenticated) return error ? <p className="cup-inline-warning" role="status">{error}</p> : null
  return <section className="cup-card cup-tournament-removal" aria-label="Host tournament management">
    <h2>Host tournament management</h2>
    {error && <p className="cup-alert" role="alert">{error} <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh controls</button></p>}
    {notice && <p role="status">{notice}</p>}
    {blocked && <p role="status">A saved Cup request needs reconciliation before another change. <a href="/tournament-host">Open host desk →</a></p>}
    {status && <>
      <p>{status.lifecycle === 'archived' ? 'This tournament is removed from normal lists. Its records remain intact.'
        : 'Remove duplicate tournaments without deleting their records. Public visitors cannot use these host controls.'}</p>
      {status.active_match_id && <p id="cup-removal-guard">Match {status.active_match_id} is active or under review. Finalize it or undo its start before removing this tournament.</p>}
      <button type="button" className="secondary" disabled={busy || blocked || !!status.active_match_id
        || (status.lifecycle === 'archived' && !status.archive_audit_id)}
        aria-describedby={status.active_match_id ? 'cup-removal-guard' : undefined}
        onClick={() => void changeRemoval()}>{status.lifecycle === 'archived' ? 'Restore tournament' : 'Remove tournament'}</button>
    </>}
    <ArchivedTournaments />
  </section>
}

function TournamentHostPage() {
  const [session, setSession] = useState<CupSession | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const current = await request<CupSession>('/api/cup-auth/session')
      setSession(current)
      setConnected(true)
    } catch (caught) {
      setConnected(false)
      setError(messageOf(caught))
    }
  }, [])
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  async function authenticate(action: 'login' | 'logout') {
    if (!session?.csrf_token || busy) return
    setBusy(true)
    setError('')
    try {
      await request(`/api/cup-auth/${action}`, {
        method: 'POST', csrf: session.csrf_token,
        ...(action === 'login' ? { body: { password } } : {}),
      })
      setPassword('')
      await refresh()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  return <CupLayout active="tournaments">
    <div className="cup-page-intro cup-host-intro"><span className="cup-eyebrow">VENOMS INTERNAL CUP</span>
      <h1>Tournament host</h1><p>Tournament access is separate from the auction host session.</p></div>
    {!connected && <p className="cup-inline-warning" role="status">Connection interrupted. Tournament changes are disabled.</p>}
    {error && <p className="cup-alert" role="alert">{error}</p>}
    {!session && connected && <p role="status">Checking tournament access…</p>}
    {session && !session.authenticated && <form className="cup-card cup-login" onSubmit={(event) => {
      event.preventDefault()
      void authenticate('login')
    }}>
      <label htmlFor="cup-password">Host password</label>
      <input id="cup-password" type="password" autoComplete="current-password" value={password}
        onChange={(event) => setPassword(event.target.value)} />
      <button className="cup-primary-button" disabled={!connected || busy || !password}>Enter tournament desk</button>
    </form>}
    {session?.authenticated && <>
      <div className="cup-host-session-actions"><button className="cup-primary-button" disabled={!connected || busy} onClick={() => void authenticate('logout')}>Sign out of tournament</button></div>
      <CupHostDesk session={session} canMutate={connected} />
    </>}
  </CupLayout>
}
type LineupDraft = { starters: number[]; bench: number[]; goalkeeper: number | null; matchVersion: number; dirty: boolean }

function savedLineup(match: Match, teamId: number): LineupDraft {
  const rows = match.participations.filter((row) => row.team_id === teamId)
  return {
    starters: rows.flatMap((row) => row.status === 'starter' && row.player ? [row.player.id] : []),
    bench: rows.flatMap((row) => row.status === 'bench' && row.player ? [row.player.id] : []),
    goalkeeper: rows.find((row) => row.status === 'starter' && row.goalkeeper)?.player?.id ?? null,
    matchVersion: match.version,
    dirty: false,
  }
}
type MatchFormatDraft = {
  players_per_side: number
  half_minutes: number
  break_minutes: number
  between_match_rest_minutes: number
  playoff_rest_minutes: number
}

type PendingCupCommand = {
  request_id: string
  resource: string
  tournament_id: number | null
  body: Record<string, unknown>
}

const pendingCupCommandKey = 'venomsfc.internal-cup.pending-command.v1'
const requestId = () => crypto.randomUUID()

export function CupHostDesk({ session, canMutate }: { session: CupSession | null; canMutate: boolean }) {
  const [tournaments, setTournaments] = useState<TournamentSummary[]>([])
  const [tournament, setTournament] = useState<Tournament | null>(null)
  const [cupPlayers, setCupPlayers] = useState<Player[]>([])
  const [history, setHistory] = useState<HostHistory[]>([])
  const [selectedMatchId, setSelectedMatchId] = useState<number | null>(null)
  const [hostTab, setHostTab] = useState<'desk' | 'setup' | 'fixtures'>(() => {
    try {
      const saved = window.sessionStorage.getItem('venomsfc.internal-cup.host-tab')
      return saved === 'setup' || saved === 'fixtures' ? saved : 'desk'
    } catch { return 'desk' }
  })
  const initialMatchRestored = useRef(false)
  const [rosterPlayerId, setRosterPlayerId] = useState<number | null>(null)
  const [rosterTeamId, setRosterTeamId] = useState<number | null>(null)
  const [profileChoice, setProfileChoice] = useState('new')
  const [profileName, setProfileName] = useState('')
  const [profilePosition, setProfilePosition] = useState('MID')
  const [profileImage, setProfileImage] = useState('')
  const [profileUpload, setProfileUpload] = useState<File | null>(null)
  const [formatDraft, setFormatDraft] = useState<MatchFormatDraft>({
    players_per_side: 5, half_minutes: 10, break_minutes: 5,
    between_match_rest_minutes: 15, playoff_rest_minutes: 60,
  })
  const formatDraftSource = useRef<{ tournamentId: number | null; dirty: boolean }>({
    tournamentId: null, dirty: false,
  })
  const [fixtureOrderIds, setFixtureOrderIds] = useState<number[]>([])
  const fixtureOrderSource = useRef<{ fixtureKey: string; dirty: boolean }>({
    fixtureKey: '', dirty: false,
  })
  const kickoffSource = useRef<{ key: string; dirty: boolean }>({ key: '', dirty: false })
  const [kickoff, setKickoff] = useState(() => {
    const date = new Date(Date.now() + 24 * 60 * 60 * 1000)
    date.setMinutes(0, 0, 0)
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
    return date.toISOString().slice(0, 16)
  })
  const [playoffKickoff, setPlayoffKickoff] = useState(() => {
    const date = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
    date.setMinutes(0, 0, 0)
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
    return date.toISOString().slice(0, 16)
  })
  const [rescheduledKickoff, setRescheduledKickoff] = useState('')
  const [drafts, setDrafts] = useState<Record<string, LineupDraft>>({})
  const [eventTeam, setEventTeam] = useState<number | null>(null)
  const [eventPlayer, setEventPlayer] = useState<number | null>(null)
  const [eventAssist, setEventAssist] = useState<number | null>(null)
  const [eventKeeper, setEventKeeper] = useState<number | null>(null)
  const [replacementKeeper, setReplacementKeeper] = useState<number | null>(null)
  const [keeperTeamId, setKeeperTeamId] = useState<number | null>(null)
  const [keeperPlayerId, setKeeperPlayerId] = useState<number | null>(null)
  const [subTeam, setSubTeam] = useState<number | null>(null)
  const [subOff, setSubOff] = useState<number | null>(null)
  const [subOn, setSubOn] = useState<number | null>(null)
  const [penaltyTaker, setPenaltyTaker] = useState<number | null>(null)
  const [finishPenaltyWinner, setFinishPenaltyWinner] = useState<number | null>(null)
  const [eventOutcome, setEventOutcome] = useState('goal')
  const [eventMinute, setEventMinute] = useState(1)
  const [historicalEntry, setHistoricalEntry] = useState(false)
  const [historicalPeriod, setHistoricalPeriod] = useState('second_half')
  const [correctEventId, setCorrectEventId] = useState<number | null>(null)
  const [correctTeam, setCorrectTeam] = useState<number | null>(null)
  const [correctPlayer, setCorrectPlayer] = useState<number | null>(null)
  const [correctOutcome, setCorrectOutcome] = useState('goal')
  const [correctAssist, setCorrectAssist] = useState<number | null>(null)
  const [correctKeeper, setCorrectKeeper] = useState<number | null>(null)
  const [correctType, setCorrectType] = useState('')
  const [correctMinute, setCorrectMinute] = useState(0)
  const [correctIncoming, setCorrectIncoming] = useState<number | null>(null)
  const [correctReplacement, setCorrectReplacement] = useState<number | null>(null)
  const [correctScored, setCorrectScored] = useState(true)
  const [correctVoid, setCorrectVoid] = useState(false)
  const [clockNow, setClockNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const setBusyState = useCallback((value: boolean) => {
    busyRef.current = value
    setBusy(value)
  }, [])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [snapshotReady, setSnapshotReady] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const refreshController = useRef<AbortController | null>(null)
  const selectedTournamentId = useRef<number | undefined>(undefined)
  const [pendingCommand, setPendingCommand] = useState<PendingCupCommand | null>(null)
  const [pendingStorageReady, setPendingStorageReady] = useState(false)
  const inFlightRequestId = useRef<string | null>(null)
  const reconciliationInFlight = useRef(false)
  const [shootoutTakerRule, setShootoutTakerRule] = useState('rotate_active_players')
  const writesAvailable = canMutate && snapshotReady && pendingStorageReady && pendingCommand === null
  const selectedMatch = tournament?.matches.find((row) => row.id === selectedMatchId) ?? null
  const leagueMatches = tournament?.matches.filter((row) => row.stage === 'league') ?? []
  const configuredPlayers = Number(tournament?.settings.players_per_side)
  const configuredHalf = Number(tournament?.settings.half_minutes)
  const configuredBreak = Number(tournament?.settings.break_minutes)
  const settingsReady = Number.isInteger(configuredPlayers) && configuredPlayers >= 1 && configuredPlayers <= 30
    && Number.isInteger(configuredHalf) && configuredHalf >= 1 && configuredHalf <= 90
    && Number.isInteger(configuredBreak) && configuredBreak >= 0 && configuredBreak <= 60
    && !formatDraftSource.current.dirty
  const rosterReady = !!tournament && tournament.teams.length === 5
    && tournament.teams.every((team) => (team.players?.length ?? 0) >= configuredPlayers)
  const fixturesReady = leagueMatches.length === 10
    && leagueMatches.every((row) => ['draft', 'scheduled', 'live', 'paused', 'review', 'finalized'].includes(row.state))
  const publishedReady = tournament?.lifecycle === 'published' && fixturesReady && settingsReady && rosterReady
  const lineupSides = selectedMatch && tournament
    ? [selectedMatch.home_team_id, selectedMatch.away_team_id].map((id) =>
      tournament.teams.find((team) => team.id === id))
    : []
  const startingLineupReady = !!selectedMatch && lineupSides.length === 2
    && lineupSides.every((side) => !!side && selectedMatch.participations.filter((row) =>
      row.team_id === side.id && row.status === 'starter').length === configuredPlayers
      && selectedMatch.participations.filter((row) =>
        row.team_id === side.id && row.status === 'starter' && row.goalkeeper).length === 1)
  const lineupRosterProblem = selectedMatch && lineupSides.length === 2
    ? lineupSides.some((side) => !side || !Array.isArray(side.players))
      ? 'The match teams or their active rosters could not be loaded. Refresh before editing the lineup.'
      : lineupSides.some((side) => side?.players?.length === 0)
        ? 'A match team has no active roster players. Assign players to that team before saving lineups.'
        : selectedMatch.participations.some((row) =>
          !row.player || !['starter', 'bench'].includes(row.status)
          || !lineupSides.some((side) => side?.id === row.team_id
            && side.players?.some((player) => player.id === row.player?.id)))
          ? 'The saved lineup no longer matches the active team rosters. Refresh and resolve the roster mismatch before saving.'
          : null
    : null
  const fixtureKey = `${tournament?.id ?? ''}:${tournament?.matches
    .filter((row) => row.stage === 'league').map((row) => row.id).join(',') ?? ''}`
  const orderedDraftFixtures = fixtureOrderIds.flatMap((id) => {
    const match = tournament?.matches.find((row) => row.id === id)
    return match ? [match] : []
  })
  const activeEventPlayers = selectedMatch && eventTeam !== null
    ? selectedMatch.participations.filter((row) => row.team_id === eventTeam
      && ['starter', 'entered'].includes(row.status)).flatMap((row) => row.player ? [row.player] : [])
    : []
  const eventKeepers = selectedMatch && eventTeam !== null
    ? selectedMatch.participations.filter((row) => row.team_id !== eventTeam
      && row.goalkeeper && ['starter', 'entered'].includes(row.status))
      .flatMap((row) => row.player ? [row.player] : [])
    : []
  const selectedEventParticipant = selectedMatch?.participations.find(
    (row) => row.player?.id === eventPlayer && row.team_id === eventTeam,
  )
  const secondYellow = selectedMatch?.events.some((event) =>
    !event.voided && event.event_type === 'yellow_card' && event.player_id === eventPlayer,
  ) ?? false
  const eventDismissesPlayer = eventOutcome === 'red_card' || (eventOutcome === 'yellow_card' && secondYellow)
  const needsReplacementKeeper = eventDismissesPlayer && selectedEventParticipant?.goalkeeper === true
  const replacementKeeperChoices = activeEventPlayers.filter((person) => person.id !== eventPlayer)
  const keeperChoices = selectedMatch && keeperTeamId !== null
    ? selectedMatch.participations.filter((row) => row.team_id === keeperTeamId
      && ['starter', 'entered'].includes(row.status)).flatMap((row) => row.player ? [row.player] : [])
    : []
  const subOnPitch = selectedMatch && subTeam !== null
    ? selectedMatch.participations.filter((row) => row.team_id === subTeam && row.player
      && ['starter', 'entered'].includes(row.status))
    : []
  const subAvailable = selectedMatch && subTeam !== null
    ? selectedMatch.participations.filter((row) => row.team_id === subTeam && row.player
      && ['bench', 'substituted'].includes(row.status))
    : []
  const subOffIsKeeper = subOnPitch.some((row) => row.player?.id === subOff && row.goalkeeper)
  const tiedGroups = useMemo(() => {
    if (!tournament) return []
    const groups = new Map<number, Standing[]>()
    for (const row of tournament.standings) {
      groups.set(row.rank, [...(groups.get(row.rank) ?? []), row])
    }
    return [...groups.entries()].filter(([, rows]) => rows.length > 1)
  }, [tournament])
  const leagueComplete = tournament?.matches.filter(
    (row) => row.stage === 'league' && row.state === 'finalized',
  ).length === 10
  const [tieOrders, setTieOrders] = useState<Record<number, number[]>>({})
  const selectedRosterTeam = tournament?.teams.find((team) =>
    team.players?.some((player) => player.id === rosterPlayerId),
  ) ?? null
  const assignedRosterCount = tournament?.teams.reduce(
    (count, team) => count + (team.players?.length ?? 0), 0,
  ) ?? 0
  const clockPeriod = selectedMatch?.clock.period ?? ''
  const breakMinutes = Number(tournament?.settings.break_minutes ?? 0)
  const breakStartedAt = selectedMatch?.clock.break_started_at
  const frozenBreakElapsed = selectedMatch?.clock.break_elapsed_seconds
  const breakElapsed = clockPeriod === 'half_time_break' ? frozenBreakElapsed ?? (breakStartedAt
    ? Math.max(0, Math.floor((clockNow - Date.parse(breakStartedAt)) / 1000)) : 0) : 0
  const breakRemaining = Math.max(0, breakMinutes * 60 - breakElapsed)
  const periodDuration = clockPeriod.startsWith('extra_time')
    ? Number(selectedMatch?.settings?.extra_time_minutes ?? 0) * 60
    : Number(tournament?.settings.half_minutes ?? 0) * 60
  const periodElapsed = selectedMatch
    ? Number(selectedMatch.clock.elapsed_seconds ?? 0) + (selectedMatch.clock.anchor
      ? Math.max(0, Math.floor((clockNow - Date.parse(selectedMatch.clock.anchor)) / 1000)) : 0)
    : 0
  const periodRemaining = Math.max(0, periodDuration - periodElapsed)
  const activeMatchOnPitch = tournament?.matches.find((row) => ['live', 'paused', 'review'].includes(row.state)) ?? null
  const clockLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const missingBench = selectedMatch && ['live', 'paused'].includes(selectedMatch.state)
    ? lineupSides.flatMap((side) => (side?.players ?? []).filter((person) =>
      !selectedMatch.participations.some((row) => row.player?.id === person.id)))
    : []
  const leagueShootout = !!selectedMatch && selectedMatch.stage === 'league' && selectedMatch.clock.period === 'shootout'
  const leagueDrawReview = !!selectedMatch && selectedMatch.stage === 'league' && selectedMatch.state === 'review'
    && selectedMatch.clock.period !== 'shootout' && selectedMatch.home_goals === selectedMatch.away_goals
  const shootoutWinner = selectedMatch?.shootout_winner_team_id
    ? [selectedMatch.home_team, selectedMatch.away_team].find((side) => side?.id === selectedMatch.shootout_winner_team_id) ?? null
    : null
  const finalizedLeagueDraw = !!selectedMatch && selectedMatch.stage === 'league' && selectedMatch.state === 'finalized'
    && selectedMatch.home_goals === selectedMatch.away_goals && !selectedMatch.shootout_winner_team_id
  const reopenBlocked = activeMatchOnPitch ? `Match ${activeMatchOnPitch.match_order} is on the pitch — finish it first.`
    : tournament?.matches.some((row) => row.stage !== 'league') ? 'Playoff fixtures are already set from the table, so league draws can no longer go to penalties.'
      : ''
  const shootoutActive = !!selectedMatch && selectedMatch.state === 'review' && selectedMatch.clock.period === 'shootout'
  const shootoutAttempts = selectedMatch?.events.filter((row) => row.event_type === 'shootout' && !row.voided)
    .sort((a, b) => a.id - b.id) ?? []
  const shootoutKicks = Number(selectedMatch?.settings?.shootout_kicks ?? 5)
  const homeKicks = shootoutAttempts.filter((row) => row.team_id === selectedMatch?.home_team_id).length
  const awayKicks = shootoutAttempts.length - homeKicks
  const nextKickTeam = !selectedMatch || shootoutWinner ? null
    : homeKicks === awayKicks ? selectedMatch.home_team : selectedMatch.away_team
  const eligiblePenaltyIds = nextKickTeam
    ? selectedMatch?.penalty_eligible_player_ids?.[nextKickTeam.id] : undefined
  const penaltyEligible = nextKickTeam ? (tournament?.teams.find((team) => team.id === nextKickTeam.id)?.players ?? [])
    .filter((person) => eligiblePenaltyIds ? eligiblePenaltyIds.includes(person.id)
      : !selectedMatch?.participations.some((row) => row.player?.id === person.id && row.status === 'dismissed')) : []
  const nextTeamAttempts = shootoutAttempts.filter((row) => row.team_id === nextKickTeam?.id)
  const penaltyWaiting = new Set<number>()
  for (const attempt of nextTeamAttempts) {
    if (penaltyEligible.some((person) => person.id === attempt.player_id)) penaltyWaiting.add(attempt.player_id)
    if (penaltyWaiting.size === penaltyEligible.length) penaltyWaiting.clear()
  }
  const shootoutRound = Math.max(homeKicks, awayKicks) + (homeKicks === awayKicks ? 1 : 0)
  const completionReady = tournament?.matches.length === 12
    && tournament.matches.filter((row) => row.stage === 'league').length === 10
    && tournament.matches.filter((row) => row.stage === 'final').length === 1
    && tournament.matches.filter((row) => row.stage === 'third_place').length === 1
    && tournament.matches.every((row) => row.state === 'finalized')

  function beginCorrection(selected: CupEvent | null) {
    setCorrectEventId(selected?.id ?? null)
    setCorrectTeam(selected?.team_id ?? null)
    setCorrectPlayer(selected?.player_id ?? null)
    setCorrectOutcome(selected?.outcome ?? 'goal')
    setCorrectMinute(selected?.minute ?? 0)
    setCorrectType(selected?.event_type ?? '')
    setCorrectAssist(selected?.assist_player_id ?? null)
    setCorrectKeeper(selected?.goalkeeper_id ?? null)
    setCorrectIncoming(typeof selected?.payload?.incoming_player_id === 'number' ? selected.payload.incoming_player_id : null)
    setCorrectReplacement(typeof selected?.payload?.replacement_goalkeeper_id === 'number' ? selected.payload.replacement_goalkeeper_id : null)
    setCorrectScored(selected?.payload?.scored === true)
    setCorrectVoid(false)
  }

  function eventAuditEntry(event: CupEvent) {
    return [...history].reverse().find((entry) => !entry.undone
      && ['match_event', 'shootout_attempt'].includes(entry.action)
      && Number(entry.details.event_id) === event.id) ?? null
  }

  function correctionPanel(match: Match, event: CupEvent) {
    return <div className="cup-glance-edit" role="group" aria-label={`Edit ${eventLabel(event)}`}>
      <p>Edits are audited and can be undone. Cards and substitutions need later match actions undone first.</p>
      <div className="cup-event-controls">
        {event.event_type !== 'shootout' && <>
          <label>Minute <input type="number" min={0} max={300} value={correctMinute}
            onChange={(change) => setCorrectMinute(Number(change.target.value))} /></label>
          <label>Team <CupSelect value={correctTeam ?? ''} onChange={(change) => {
            setCorrectTeam(Number(change.target.value) || null)
            setCorrectPlayer(null); setCorrectAssist(null); setCorrectKeeper(null)
            setCorrectIncoming(null); setCorrectReplacement(null)
          }}>
            {[match.home_team, match.away_team].filter((row): row is Team => row !== null)
              .map((side) => <option key={side.id} value={side.id}>{side.name}</option>)}
          </CupSelect></label>
          <label>{event.event_type === 'substitution' ? 'Player going off' : 'Player'} <CupSelect value={correctPlayer ?? ''} onChange={(change) => setCorrectPlayer(Number(change.target.value) || null)}>
            <option value="">Choose player</option>{match.participations.filter((row) => row.team_id === correctTeam)
              .flatMap((row) => row.player ? [row.player] : []).map((person) =>
                <option key={person.id} value={person.id}>{person.name}</option>)}
          </CupSelect></label>
          {event.event_type === 'shot' && <>
            <label>Outcome <CupSelect value={correctOutcome} onChange={(change) => {
              setCorrectOutcome(change.target.value); setCorrectAssist(null); setCorrectKeeper(null)
            }}>
              <option value="goal">Goal</option><option value="saved">Saved</option>
              <option value="off_target">Off target</option><option value="blocked">Blocked</option>
            </CupSelect></label>
            {correctOutcome === 'goal' && <label>Assist <CupSelect value={correctAssist ?? ''}
              onChange={(change) => setCorrectAssist(Number(change.target.value) || null)}>
              <option value="">No assist</option>{match.participations.filter((row) => row.team_id === correctTeam)
                .flatMap((row) => row.player && row.player.id !== correctPlayer ? [row.player] : [])
                .map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </CupSelect></label>}
            {correctOutcome === 'saved' && <label>Opposing goalkeeper <CupSelect value={correctKeeper ?? ''}
              onChange={(change) => setCorrectKeeper(Number(change.target.value) || null)}>
              <option value="">Choose goalkeeper</option>{match.participations.filter((row) => row.team_id !== correctTeam)
                .flatMap((row) => row.player ? [row.player] : [])
                .map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </CupSelect></label>}
          </>}
          {['yellow_card', 'red_card'].includes(event.event_type) && <>
            <label>Card <CupSelect value={correctType} onChange={(change) => setCorrectType(change.target.value)}>
              <option value="yellow_card">Yellow card</option><option value="red_card">Red card</option>
            </CupSelect></label>
            <label>Replacement goalkeeper (if needed) <CupSelect value={correctReplacement ?? ''}
              onChange={(change) => setCorrectReplacement(Number(change.target.value) || null)}>
              <option value="">Not needed</option>{match.participations.filter((row) => row.team_id === correctTeam)
                .flatMap((row) => row.player && row.player.id !== correctPlayer ? [row.player] : [])
                .map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </CupSelect></label>
          </>}
          {event.event_type === 'substitution' && <label>Player coming on <CupSelect value={correctIncoming ?? ''}
            onChange={(change) => setCorrectIncoming(Number(change.target.value) || null)}>
            <option value="">Choose substitute</option>{match.participations.filter((row) => row.team_id === correctTeam)
              .flatMap((row) => row.player && row.player.id !== correctPlayer ? [row.player] : [])
              .map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </CupSelect></label>}
          <label className="cup-check"><input type="checkbox" checked={correctVoid}
            onChange={(change) => setCorrectVoid(change.target.checked)} /> Remove only this event (later events stay)</label>
        </>}
        {event.event_type === 'shootout' && <label>Penalty outcome <CupSelect value={correctScored ? 'scored' : 'missed'}
          onChange={(change) => setCorrectScored(change.target.value === 'scored')}>
          <option value="scored">Scored</option><option value="missed">Missed</option>
        </CupSelect></label>}
      </div>
      <div className="cup-glance-edit-actions">
        <button disabled={!writesAvailable || busy || (!correctVoid && event.event_type !== 'shootout'
          && (correctTeam === null || correctPlayer === null || (correctOutcome === 'saved'
            && event.event_type === 'shot' && correctKeeper === null)
            || (event.event_type === 'substitution' && correctIncoming === null)))}
          onClick={() => {
            if (match.state === 'finalized' && !window.confirm('Correct this finalized result? The change is audited and can be undone.')) return
            void send(`/api/cup/host/matches/${match.id}/events/${event.id}/correct`, {
              expected_match_version: match.version, confirm_finalized: match.state === 'finalized',
              ...(event.event_type === 'shootout' ? { scored: correctScored } : {
                voided: correctVoid, team_id: correctTeam, player_id: correctPlayer,
                minute: correctMinute,
                ...(event.event_type === 'shot' ? {
                  outcome: correctOutcome, assist_player_id: correctAssist, goalkeeper_id: correctKeeper,
                } : event.event_type === 'substitution' ? {
                  event_type: 'substitution', incoming_player_id: correctIncoming,
                } : ['yellow_card', 'red_card'].includes(event.event_type) ? {
                  event_type: correctType, replacement_goalkeeper_id: correctReplacement,
                } : {}),
              }),
            }).then((saved) => { if (saved) setCorrectEventId(null) })
          }}>{correctVoid ? 'Remove event' : 'Save changes'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setCorrectEventId(null)}>Cancel</button>
      </div>
    </div>
  }

  const refreshCup = useCallback(async (selectedId?: number) => {
    const targetId = selectedId ?? selectedTournamentId.current
    if (refreshController.current && !refreshController.current.signal.aborted) {
      if (targetId === selectedTournamentId.current) return false
      refreshController.current.abort()
    }
    const controller = new AbortController()
    refreshController.current = controller
    if (targetId !== selectedTournamentId.current) setSnapshotReady(false)
    selectedTournamentId.current = targetId
    setRefreshing(true)
    try {
      const list = await request<{ tournaments: TournamentSummary[] }>('/api/cup?summary=1', { signal: controller.signal })
      setTournaments(list.tournaments)
      const roster = await request<{ players: Player[] }>('/api/cup/players', { signal: controller.signal })
      setCupPlayers(roster.players)
      const id = list.tournaments.some((row) => row.id === targetId) ? targetId : list.tournaments[0]?.id
      if (id) {
        const detail = await request<{ tournament: Tournament }>(`/api/cup/${id}`, { signal: controller.signal })
        selectedTournamentId.current = id
        setTournament(detail.tournament)
        const matches = detail.tournament.matches
        const activeMatch = matches.find((row) => ['live', 'paused', 'review'].includes(row.state))
        setSelectedMatchId((current) => {
          const currentExists = matches.some((row) => row.id === current)
          if (!initialMatchRestored.current) {
            initialMatchRestored.current = true
            let remembered: number | null = null
            try {
              const saved = Number(window.sessionStorage.getItem(`venomsfc.internal-cup.match.${id}`))
              if (Number.isInteger(saved) && matches.some((row) => row.id === saved)) remembered = saved
            } catch { /* Selection can still be restored from the server's active match. */ }
            return activeMatch?.id ?? remembered ?? matches.find((row) => row.state === 'scheduled')?.id
              ?? matches[0]?.id ?? null
          }
          // While a match occupies the pitch the desk stays on it; other fixtures cannot be chosen.
          if (activeMatch) return activeMatch.id
          return currentExists ? current : matches.find((row) => row.state === 'scheduled')?.id ?? matches[0]?.id ?? null
        })
        const audit = await request<{ history: HostHistory[] }>(`/api/cup/host/${id}/history`, { signal: controller.signal })
        setHistory(audit.history)
      } else {
        selectedTournamentId.current = undefined
        setTournament(null)
        setHistory([])
        setCupPlayers([])
      }
      setSnapshotReady(true)
      setRefreshError('')
      return true
    } catch (caught) {
      if (!controller.signal.aborted) {
        setSnapshotReady(false)
        setRefreshError(`The latest Cup state could not be loaded. ${messageOf(caught)} Saved actions are not repeated. Refresh the desk before making another change.`)
      }
      return false
    } finally {
      if (refreshController.current === controller) {
        refreshController.current = null
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => () => refreshController.current?.abort(), [])

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(pendingCupCommandKey)
      if (raw !== null) {
        const saved = JSON.parse(raw) as PendingCupCommand
        if (
          !saved || typeof saved.request_id !== 'string'
          || !/^[A-Za-z0-9._:-]{8,64}$/.test(saved.request_id)
          || typeof saved.resource !== 'string' || !saved.resource.startsWith('/api/cup/host/')
          || (saved.tournament_id !== null && !Number.isInteger(saved.tournament_id))
          || typeof saved.body !== 'object' || saved.body === null || Array.isArray(saved.body)
          || saved.body.request_id !== saved.request_id
        ) throw new Error('Stored pending request data is invalid.')
        setPendingCommand(saved)
      }
      setPendingStorageReady(true)
    } catch {
      setError('The saved Cup request cannot be read safely. Host writes remain disabled.')
    }
  }, [])

  useEffect(() => {
    if (session?.authenticated) void refreshCup()
  }, [session?.authenticated, refreshCup])

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!tournament) {
      setFixtureOrderIds([])
      return
    }
    if (fixtureOrderSource.current.fixtureKey === fixtureKey && fixtureOrderSource.current.dirty) return
    fixtureOrderSource.current = { fixtureKey, dirty: false }
    setFixtureOrderIds(tournament.matches
      .filter((row) => row.stage === 'league')
      .sort((left, right) => left.match_order - right.match_order)
      .map((row) => row.id))
  }, [fixtureKey, tournament])

  useEffect(() => {
    if (!tournament) return
    const first = tournament.matches.filter((row) => row.stage === 'league'
      && ['draft', 'scheduled'].includes(row.state)).sort((a, b) => a.match_order - b.match_order)[0]
    const key = `${tournament.id}:${first?.id ?? ''}`
    if (kickoffSource.current.key === key
      || (kickoffSource.current.dirty && kickoffSource.current.key.startsWith(`${tournament.id}:`))) return
    kickoffSource.current = { key, dirty: false }
    if (first?.scheduled_at) {
      const date = new Date(first.scheduled_at)
      date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
      setKickoff(date.toISOString().slice(0, 16))
    }
  }, [tournament])

  useEffect(() => {
    if (!tournament) return
    if (formatDraftSource.current.tournamentId === tournament.id && formatDraftSource.current.dirty) return
    formatDraftSource.current = { tournamentId: tournament.id, dirty: false }
    setFormatDraft({
      players_per_side: Number(tournament.settings.players_per_side ?? 5),
      half_minutes: Number(tournament.settings.half_minutes ?? 10),
      break_minutes: Number(tournament.settings.break_minutes ?? 5),
      between_match_rest_minutes: Number(tournament.settings.between_match_rest_minutes ?? 15),
      playoff_rest_minutes: Number(tournament.settings.playoff_rest_minutes ?? 60),
    })
  }, [tournament])

  useEffect(() => {
    setShootoutTakerRule(String(selectedMatch?.settings?.shootout_taker_rule ?? 'rotate_active_players'))
  }, [selectedMatch?.id, selectedMatch?.settings?.shootout_taker_rule])

  const persistedTournamentId = tournament?.id
  useEffect(() => {
    try {
      window.sessionStorage.setItem('venomsfc.internal-cup.host-tab', hostTab)
      if (persistedTournamentId !== undefined && selectedMatchId !== null) {
        window.sessionStorage.setItem(`venomsfc.internal-cup.match.${persistedTournamentId}`, String(selectedMatchId))
      }
    } catch { /* Server state remains authoritative if local UI preferences cannot be stored. */ }
  }, [hostTab, persistedTournamentId, selectedMatchId])

  useEffect(() => {
    const tournamentId = tournament?.id
    const matchId = selectedMatch?.id
    const matchState = selectedMatch?.state
    if (!session?.authenticated || !tournamentId || !matchId || !['live', 'paused'].includes(matchState ?? '')) return
    const timer = window.setInterval(() => {
      if (!busyRef.current) void refreshCup(tournamentId)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [session?.authenticated, tournament?.id, selectedMatch?.id, selectedMatch?.state, refreshCup])

  const reconcilePendingCommand = useCallback(async (command: PendingCupCommand, rejection?: string) => {
    if (reconciliationInFlight.current) return
    reconciliationInFlight.current = true
    try {
      const status = await request<{
        request_id: string
        status: 'committed' | 'not_committed' | 'cancelled'
        resource?: string
        tournament_id?: number
      }>(`/api/cup/host/requests/${encodeURIComponent(command.request_id)}`)
      let outcome: { status: 'committed' | 'not_committed' | 'cancelled'; resource?: string; tournament_id?: number } = status
      if (status.status === 'not_committed') {
        try {
          outcome = await request<{
            request_id: string
            status: 'committed' | 'cancelled'
            resource?: string
            tournament_id?: number
          }>(`/api/cup/host/requests/${encodeURIComponent(command.request_id)}/cancel`, {
            method: 'POST',
            csrf: session?.csrf_token,
            body: {
              request_id: command.request_id,
              tournament_id: command.tournament_id,
            },
          })
        } catch (cancelError) {
          const routeMissing = cancelError instanceof ApiError && (cancelError.status === 404 || cancelError.status === 405)
          if (routeMissing && rejection) {
            // The server answered the original command with an explicit rejection, so nothing was recorded.
            await window.sessionStorage.removeItem(pendingCupCommandKey)
            setPendingCommand(null)
            setNotice('')
            setError(`${rejection} Nothing was saved; fix the issue above and try again.`)
            await refreshCup(command.tournament_id ?? undefined)
            return
          }
          if (routeMissing) {
            setError(`Request ${command.request_id} could not be confirmed because this Cup server cannot cancel unconfirmed requests (HTTP ${cancelError.status}). It is running an older version: restart the Cup server, sign in again and press “Check again”. Cup writes stay blocked so the action is never recorded twice.`)
            return
          }
          throw cancelError
        }
      }
      if (outcome.status === 'committed' && outcome.resource !== command.resource) {
        setError(`Request ${command.request_id} was recorded for a different resource. Writes remain blocked for safety.`)
        return
      }
      if (outcome.status === 'committed') {
        await window.sessionStorage.removeItem(pendingCupCommandKey)
        setPendingCommand(null)
        setError('')
        const lineupMatch = /^\/api\/cup\/host\/matches\/(\d+)\/lineup$/.exec(command.resource)
        if (lineupMatch) setDrafts((value) => Object.fromEntries(
          Object.entries(value).filter(([key]) => !key.startsWith(`${lineupMatch[1]}:`)),
        ))
        setNotice(`Cup request ${command.request_id} was confirmed in host history.`)
        await refreshCup(outcome.tournament_id ?? command.tournament_id ?? undefined)
      } else if (outcome.status === 'cancelled') {
        await window.sessionStorage.removeItem(pendingCupCommandKey)
        setPendingCommand(null)
        setError(rejection ? `${rejection} Nothing was saved; review the current state before trying again.` : '')
        setNotice(`${rejection ? `${rejection} ` : ''}Cup request ${command.request_id} was safely cancelled. Any delayed copy will be rejected; review the current state before submitting a new action.`)
        await refreshCup(outcome.tournament_id ?? command.tournament_id ?? undefined)
      } else {
        throw new Error('The Cup request cancellation has no terminal status.')
      }
    } catch (caught) {
      setError(`${rejection ? `${rejection} ` : ''}Request ${command.request_id} is still unconfirmed. Keep this page open or reconnect; Cup writes remain blocked. ${messageOf(caught)}`)
    } finally {
      reconciliationInFlight.current = false
    }
  }, [refreshCup, session?.csrf_token])

  useEffect(() => {
    if (
      session?.authenticated && pendingCommand
      && inFlightRequestId.current !== pendingCommand.request_id
    ) void reconcilePendingCommand(pendingCommand)
  }, [session?.authenticated, pendingCommand, reconcilePendingCommand])

  async function send(
    path: string,
    body: Record<string, unknown>,
    expected = tournament?.version,
    targetTournamentId = tournament?.id ?? null,
    nested = false,
  ): Promise<boolean> {
    // Only an orchestrating command (undo) that already owns the busy lock may send while busy.
    if (!session?.authenticated || !session.csrf_token || !writesAvailable || (busyRef.current && !nested)) return false
    setBusyState(true)
    setError('')
    setNotice('')
    refreshController.current?.abort()
    const id = requestId()
    const command: PendingCupCommand = {
      request_id: id,
      resource: path,
      tournament_id: targetTournamentId,
      body: { ...body, request_id: id, ...(expected === undefined ? {} : { expected_version: expected }) },
    }
    try {
      window.sessionStorage.setItem(pendingCupCommandKey, JSON.stringify(command))
      inFlightRequestId.current = id
      setPendingCommand(command)
    } catch {
      setError('The Cup request could not be saved for safe reconciliation. Nothing was sent.')
      if (!nested) setBusyState(false)
      return false
    }
    try {
      const saved = await request<{ tournament_id?: number; version: number }>(path, {
        method: 'POST',
        csrf: session.csrf_token,
        body: command.body,
      })
      setSnapshotReady(false)
      const savedTournamentId = saved.tournament_id ?? targetTournamentId
      if (savedTournamentId !== null) selectedTournamentId.current = savedTournamentId
      try {
        window.sessionStorage.removeItem(pendingCupCommandKey)
        setPendingCommand(null)
      } catch {
        setError(`Cup request ${id} succeeded, but its local receipt could not be cleared. Writes remain blocked while it is reconciled.`)
        return false
      }
      const fixturesCreated = /^\/api\/cup\/host\/\d+\/fixtures$/.test(path)
      setNotice(fixturesCreated
        ? 'Fixtures were created and saved. Do not generate another set; the schedule will appear when the desk refreshes.'
        : `Cup action ${id} saved. It is recorded in host history and can be undone.`)
      const refreshed = await refreshCup(savedTournamentId ?? undefined)
      if (fixturesCreated && refreshed) setNotice('Fixtures were created and saved. Review the existing schedule below; generating another set is disabled.')
      return true
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 0
        ? `${messageOf(caught)} The write outcome is unconfirmed; reconciling request ${id}. Do not retry.`
        : `${messageOf(caught)} Reconciling request ${id} before allowing another write.`)
      inFlightRequestId.current = null
      await reconcilePendingCommand(command, caught instanceof ApiError && caught.status >= 400 && caught.status < 500
        ? messageOf(caught) : undefined)
      return false
    } finally {
      inFlightRequestId.current = null
      if (!nested) setBusyState(false)
    }
  }

  async function undo(auditId: number, label?: string): Promise<boolean> {
    if (!tournament || !session?.csrf_token || !writesAvailable || busyRef.current) return false
    setBusyState(true)
    setError('')
    try {
      const preview = await request<{ target: { id: number; action: string } | null; affected: { id: number; action: string }[]; expected_version: number }>(
        `/api/cup/host/${tournament.id}/undo-preview?target_audit_id=${auditId}`,
      )
      if (!preview.target) return false
      const downstream = preview.affected.length
        ? ` This also reverses ${preview.affected.length} later host action${preview.affected.length === 1 ? '' : 's'} (${preview.affected.map((row) => `${row.action} #${row.id}`).join(', ')}) in reverse order.`
        : ''
      if (!window.confirm(`Undo ${label ?? `${preview.target.action} #${preview.target.id}`}?${downstream} The audit history is preserved.`)) return false
      return await send(`/api/cup/host/${tournament.id}/undo`, {
        target_audit_id: auditId, cascade: preview.affected.length > 0,
      }, preview.expected_version, tournament.id, true)
    } catch (caught) {
      setError(messageOf(caught))
      await refreshCup(tournament.id)
      return false
    } finally {
      setBusyState(false)
    }
  }

  async function uploadProfileImage() {
    if (!profileUpload || !session?.csrf_token || !writesAvailable || busyRef.current) return
    setBusyState(true)
    setError('')
    setNotice('')
    const body = new FormData()
    body.append('file', profileUpload)
    try {
      const uploaded = await request<{ path: string }>('/api/cup/uploads', {
        method: 'POST', csrf: session.csrf_token, body,
      })
      setProfileImage(uploaded.path)
      setProfileUpload(null)
      setNotice('Image uploaded to Cup-only storage. Save the profile to apply it.')
    } catch (caught) {
      setError(`${messageOf(caught)} The profile was not changed.`)
    } finally {
      setBusyState(false)
    }
  }

  function updateDraft(teamId: number, patch: Partial<LineupDraft>) {
    if (!selectedMatch) return
    const key = `${selectedMatchId}:${teamId}`
    setDrafts((value) => {
      const current = value[key] ?? savedLineup(selectedMatch, teamId)
      const existing = Object.entries(value).find(([draftKey]) => draftKey.startsWith(`${selectedMatch.id}:`))?.[1]
      const next = { ...current, ...patch, matchVersion: existing?.matchVersion ?? current.matchVersion, dirty: true }
      if (patch.starters) {
        next.bench = next.bench.filter((id) => !next.starters.includes(id))
        if (next.goalkeeper !== null && !next.starters.includes(next.goalkeeper)) next.goalkeeper = null
      }
      return { ...value, [key]: next }
    })
  }

  function toggleLineupPlayer(teamId: number, playerId: number) {
    if (!selectedMatch || !tournament) return
    const key = `${selectedMatch.id}:${teamId}`
    const current = drafts[key] ?? savedLineup(selectedMatch, teamId)
    if (current.starters.includes(playerId)) {
      updateDraft(teamId, {
        starters: current.starters.filter((id) => id !== playerId),
        ...(current.goalkeeper === playerId ? { goalkeeper: null } : {}),
      })
    } else if (current.starters.length < Number(tournament.settings.players_per_side)) {
      updateDraft(teamId, { starters: [...current.starters, playerId] })
    }
  }

  function moveFixture(index: number, offset: number) {
    let target = index + offset
    while (target >= 0 && target < orderedDraftFixtures.length
      && !['draft', 'scheduled'].includes(orderedDraftFixtures[target].state)) target += offset
    if (target < 0 || target >= fixtureOrderIds.length) return
    const next = [...fixtureOrderIds]
    const moved = next[index]
    next[index] = next[target]
    next[target] = moved
    fixtureOrderSource.current.dirty = true
    setFixtureOrderIds(next)
  }

  function discardFixtureOrder() {
    if (!tournament) return
    fixtureOrderSource.current.dirty = false
    setFixtureOrderIds(tournament.matches
      .filter((row) => row.stage === 'league')
      .sort((left, right) => left.match_order - right.match_order)
      .map((row) => row.id))
  }

  if (!session?.authenticated) return null
  return <section className="cup-host-desk" aria-labelledby="cup-host-title">
    <div className="cup-host-head"><div><span className="cup-eyebrow">INTERNAL CUP · HOST CONTROLS</span>
      <h2 id="cup-host-title">Cup matchday desk</h2><p>Separate from auction state. Every cup change is versioned and audited.</p></div>
      {tournament && <StatusPill value={tournament.lifecycle} />}</div>
    {error && <div className="cup-alert" role="alert">{error}
      {pendingCommand && session?.authenticated && <> <button type="button" className="secondary" disabled={busy}
        onClick={() => void reconcilePendingCommand(pendingCommand)}>Check again</button></>}</div>}
    {notice && <div className="cup-host-notice" role="status">{notice}</div>}
    {refreshError && <div className="cup-alert" role="alert">{refreshError}
      <button type="button" className="secondary" disabled={busy || refreshing}
        onClick={() => void refreshCup()}>Refresh desk</button></div>}
    {!!tournament?.matches.length && <div className="cup-host-notice" role="status">
      Fixtures already exist for this tournament. Review the existing schedule; generating another set is disabled.
    </div>}
    {!writesAvailable && <div className="cup-alert" role="status">
      {pendingCommand
        ? <>Request <code>{pendingCommand.request_id}</code> is being reconciled against host history. Do not retry; Cup writes stay disabled until its outcome is confirmed.</>
        : !snapshotReady ? 'Waiting for the latest Cup state. Host changes are disabled until the desk is refreshed.'
          : 'Host connection or local request storage is unavailable. Cup writes are disabled until access and connection are confirmed.'}
    </div>}
    {!tournaments.length ? <button className="cup-primary-button" disabled={!writesAvailable || busy}
      onClick={() => void send('/api/cup/host/tournaments', { name: 'Venoms Internal Cup', edition: '1st Edition' }, undefined)}>
      Create Internal Cup
    </button> : <label className="cup-host-select">Tournament
      <CupSelect value={tournament?.id ?? ''} disabled={busy || refreshing || pendingCommand !== null}
        onChange={(event) => void refreshCup(Number(event.target.value))}>
        {tournaments.map((row) => <option value={row.id} key={row.id}>{row.name} · {row.edition}</option>)}
      </CupSelect>
    </label>}
    <ArchivedTournaments />
    {tournament && <div className="cup-host-workspace">
      <PlayoffAnnouncement tournament={tournament} />
      <nav className="cup-host-tabs" aria-label="Tournament host sections">
        {([['desk', 'Match desk'], ['setup', 'Squad & settings'], ['fixtures', 'Fixtures']] as const).map(([tab, label]) =>
          <button key={tab} type="button" className={hostTab === tab ? 'active' : 'secondary'}
            aria-current={hostTab === tab ? 'page' : undefined}
            onClick={() => setHostTab(tab)}>{label}</button>)}
      </nav>
      {hostTab === 'desk' && <section className="cup-host-card cup-readiness">
        <div className="cup-host-card-heading"><div><span className="cup-eyebrow">TOURNAMENT</span><h3>{tournament.lifecycle === 'paused' ? 'Tournament paused' : tournament.lifecycle === 'completed' ? 'Tournament finished' : 'Matchday controls'}</h3></div>
          <StatusPill value={tournament.lifecycle} />
        </div>
        <div className="cup-tournament-actions">
          {tournament.lifecycle === 'published' && <button disabled={!writesAvailable || busy || !publishedReady}
            onClick={() => void send(`/api/cup/host/${tournament.id}/start`, {})}>Start tournament</button>}
          {tournament.lifecycle === 'running' && <button className="secondary" disabled={!writesAvailable || busy}
            onClick={() => {
              if (!window.confirm('Pause the tournament? A live match clock will stop and match changes will be blocked until you resume. Nothing is deleted.')) return
              void send(`/api/cup/host/${tournament.id}/control`, { command: 'pause' })
            }}>Pause tournament</button>}
          {tournament.lifecycle === 'paused' && <button disabled={!writesAvailable || busy}
            onClick={() => void send(`/api/cup/host/${tournament.id}/control`, { command: 'resume' })}>Resume tournament</button>}
          {['running', 'paused'].includes(tournament.lifecycle) && <button className="secondary"
            disabled={!writesAvailable || busy || !completionReady} aria-describedby="cup-tournament-finish-note"
            onClick={() => {
              if (!window.confirm('Finish this tournament? All ten league fixtures, the third-place match and the final are finalized. Results stay available; this action is audited and undoable.')) return
              void send(`/api/cup/host/${tournament.id}/control`, { command: 'finish', confirm: true })
            }}>Finish tournament</button>}
          {tournament.lifecycle === 'draft' && <button className="secondary" onClick={() => setHostTab('fixtures')}>Review fixtures</button>}
        </div>
        {['running', 'paused'].includes(tournament.lifecycle) && <p id="cup-tournament-finish-note">
          {completionReady ? 'All results are finalized. Finish the tournament when ready.'
            : 'Finish unlocks after all 10 league matches, the third-place match and the final are finalized.'}
        </p>}
        {tournament.lifecycle === 'paused' && <p role="status">Match actions are locked. Resume the tournament first, then resume the match clock explicitly when ready. Half-time will not be skipped.</p>}
        <details key={`${tournament.id}:${['draft', 'published'].includes(tournament.lifecycle)}`} className="cup-readiness-details"
          open={['draft', 'published'].includes(tournament.lifecycle) ? true : undefined}>
        <summary>Setup checks <span>{[rosterReady, settingsReady, fixturesReady].filter(Boolean).length}/3 ready</span></summary>
        <ul className="cup-readiness-list">
          <li data-ready={rosterReady}><span>{rosterReady ? '✓' : '!'}</span>Squads have enough assigned players for {Number.isFinite(configuredPlayers) ? configuredPlayers : 'the configured number'} per side</li>
          <li data-ready={settingsReady}><span>{settingsReady ? '✓' : '!'}</span>Match format saved: {Number.isFinite(configuredPlayers) ? configuredPlayers : '—'} per side · {Number.isFinite(configuredHalf) ? configuredHalf : '—'} min halves · {Number.isFinite(configuredBreak) ? configuredBreak : '—'} min break</li>
          <li data-ready={fixturesReady}><span>{fixturesReady ? '✓' : '!'}</span>{fixturesReady ? 'Ten league fixtures are set' : `Fixtures ready: ${leagueMatches.length} of 10`}</li>
          <li data-ready={['published', 'running', 'paused', 'completed'].includes(tournament.lifecycle)}>
            <span>{['published', 'running', 'paused', 'completed'].includes(tournament.lifecycle) ? '✓' : '!'}</span>
            {tournament.lifecycle === 'draft' ? 'Review and publish fixtures in the Fixtures tab before starting' : 'Tournament status: ' + tournament.lifecycle}
          </li>
        </ul>
        </details>
        {tournament.lifecycle === 'published' && !publishedReady && <p role="status">Complete the outstanding setup item before starting.</p>}
      </section>}
      {hostTab === 'setup' && <section className="cup-host-card"><h3>Squad & match settings</h3>
        <p>Import copies auction assignments into cup-only membership records. It never writes to the auction.</p>
        <div className="cup-host-actions">
          <button className="secondary" disabled={!writesAvailable || busy || tournament.lifecycle !== 'draft'}
            onClick={() => void send(`/api/cup/host/${tournament.id}/import-squads`, {})}>Import auction squads</button>
        </div>
        <div className="cup-format-editor">
          {([
            ['players_per_side', 'Players per side', 1, 30],
            ['half_minutes', 'Minutes per half', 1, 90],
            ['break_minutes', 'Half-time break (minutes)', 0, 60],
            ['between_match_rest_minutes', 'Between-match rest (minutes)', 0, 180],
            ['playoff_rest_minutes', 'League-to-playoff rest (minutes)', 1, 1440],
          ] as const).map(([key, label, min, max]) => <label key={key}>{label}
            <input type="number" min={min} max={max} step={1} value={formatDraft[key]}
              onChange={(event) => {
                formatDraftSource.current.dirty = true
                setFormatDraft((current) => ({
                  ...current, [key]: Number(event.target.value),
                }))
              }} />
          </label>)}
          <button className="secondary" disabled={!writesAvailable || busy || tournament.lifecycle !== 'draft'
            || Object.values(formatDraft).some((value) => !Number.isInteger(value))}
            onClick={() => void send(`/api/cup/host/${tournament.id}/settings`, { settings: formatDraft })
              .then((saved) => { if (saved) formatDraftSource.current.dirty = false })}>
            Save match format
          </button>
          {formatDraftSource.current.dirty && <button className="secondary" disabled={busy}
            onClick={() => {
              formatDraftSource.current.dirty = false
              setFormatDraft({
                players_per_side: Number(tournament.settings.players_per_side ?? 5),
                half_minutes: Number(tournament.settings.half_minutes ?? 10),
                break_minutes: Number(tournament.settings.break_minutes ?? 5),
                between_match_rest_minutes: Number(tournament.settings.between_match_rest_minutes ?? 15),
                playoff_rest_minutes: Number(tournament.settings.playoff_rest_minutes ?? 60),
              })
            }}>Discard format changes</button>}
        </div>
        <div className="cup-roster-editor">
          <h4>Manage cup rosters</h4>
          <p>{assignedRosterCount} assigned · {Math.max(0, cupPlayers.length - assignedRosterCount)} available. Changes affect only this cup and are undoable.</p>
          <label>Player <CupSelect aria-label="Cup roster player" value={rosterPlayerId ?? ''}
            onChange={(event) => {
              const playerId = Number(event.target.value) || null
              setRosterPlayerId(playerId)
              setRosterTeamId(tournament.teams.find((team) =>
                team.players?.some((player) => player.id === playerId),
              )?.id ?? null)
            }}>
            <option value="">Choose a player</option>
            {cupPlayers.map((player) => <option value={player.id} key={player.id}>
              {player.name} · {player.teams?.[0]?.name ?? 'available'}
            </option>)}
          </CupSelect></label>
          <label>Assign to <CupSelect aria-label="Cup roster team" value={rosterTeamId ?? ''}
            onChange={(event) => setRosterTeamId(Number(event.target.value) || null)}>
            <option value="">Remove from cup roster</option>
            {tournament.teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}
          </CupSelect></label>
          <button className="secondary" disabled={!writesAvailable || busy || !rosterPlayerId
            || (rosterTeamId === null ? !selectedRosterTeam : rosterTeamId === selectedRosterTeam?.id)}
            onClick={() => void send(`/api/cup/host/${tournament.id}/rosters`, {
              player_id: rosterPlayerId, team_id: rosterTeamId,
            })}>Save roster change</button>
          <h4>Tournament profiles</h4>
          <p>Changes are kept separately from auction profiles. A new player can be assigned above after saving.</p>
          <label>Profile <CupSelect value={profileChoice} disabled={busy} onChange={(event) => {
            const choice = event.target.value
            setProfileChoice(choice)
            const [type, id] = choice.split(':')
            const selected = type === 'team'
             ? tournament.teams.find((item) => item.id === Number(id))
             : cupPlayers.find((item) => item.id === Number(id))
            setProfileName(selected?.name ?? '')
            setProfilePosition(selected && 'position' in selected ? selected.position : 'MID')
            setProfileImage(selected ? ('position' in selected ? selected.photo_path : selected.logo_path) : '')
          }}>
            <option value="new">Add a tournament player</option>
            <optgroup label="Players">{cupPlayers.map((item) =>
             <option key={item.id} value={`player:${item.id}`}>{item.name}</option>)}</optgroup>
            <optgroup label="Teams">{tournament.teams.map((item) =>
             <option key={item.id} value={`team:${item.id}`}>{item.name}</option>)}</optgroup>
          </CupSelect></label>
          <label>Name <input value={profileName} maxLength={120} onChange={(event) => setProfileName(event.target.value)} /></label>
          {!profileChoice.startsWith('team:') && <label>Position <CupSelect value={profilePosition}
            onChange={(event) => setProfilePosition(event.target.value)}>
            {['GK', 'DEF', 'MID', 'ST'].map((position) => <option key={position} value={position}>{position}</option>)}
          </CupSelect></label>}
          <label>Local image path (optional for players) <input value={profileImage} maxLength={500}
            onChange={(event) => setProfileImage(event.target.value)} /></label>
          <label>Upload a Cup photo or logo <input type="file" accept="image/jpeg,image/png,image/webp"
            disabled={!writesAvailable || busy} onChange={(event) =>
              setProfileUpload(event.target.files?.[0] ?? null)} /></label>
          <button type="button" className="secondary" disabled={!writesAvailable || busy || !profileUpload}
            onClick={() => void uploadProfileImage()}>Upload Cup image</button>
          <button className="secondary" disabled={!writesAvailable || busy || !profileName.trim()}
            onClick={() => {
             const [type, id] = profileChoice.split(':')
             const entity = type === 'team' ? 'team' : 'player'
             void send(`/api/cup/host/${tournament.id}/profiles`, {
               entity, id: id ? Number(id) : null, name: profileName,
               ...(entity === 'player' ? { position: profilePosition, photo_path: profileImage } : { logo_path: profileImage }),
             })
            }}>Save tournament profile</button>
        </div>
      </section>}
      {hostTab === 'fixtures' && <>
      <section className="cup-host-card"><h3>Fixture schedule</h3>
        <p>Prepare, review and publish fixtures before matchday. Publishing makes the complete schedule visible to players; it does not start the tournament or a match.</p>
        <CupDateTime label={tournament.lifecycle === 'running' ? 'First pending kickoff' : 'First kickoff'} value={kickoff} onChange={(value) => {
          kickoffSource.current.dirty = true
          setKickoff(value)
        }} />
        <p>One pitch · ten round-robin fixtures. The saved schedule includes suggested rest between matches, but the host can start a ready match at any time when the pitch is free. Started and completed matches stay in place.</p>
        <div className="cup-host-actions">
          <button className="secondary" disabled={!writesAvailable || busy || !kickoff || tournament.lifecycle !== 'draft' || tournament.matches.length > 0}
            onClick={() => void send(`/api/cup/host/${tournament.id}/fixtures`, { kickoff: new Date(kickoff).toISOString() })}>Generate fixtures</button>
          <button disabled={!writesAvailable || busy || tournament.lifecycle !== 'draft' || tournament.matches.length !== 10}
            onClick={() => {
              if (!window.confirm('Publish this reviewed schedule for players to see? This does not start the tournament or any match.')) return
              void send(`/api/cup/host/${tournament.id}/publish`, {})
            }}>Publish reviewed fixtures</button>
        </div>
        {tournament.lifecycle === 'published' && <p role="status">Fixtures are public. Players can see the full schedule on the home page now, before you start the tournament.</p>}
        {tournament.matches.length > 0 && <div className="cup-fixtures cup-host-fixtures">
          {orderedDraftFixtures.map((row, index) => <div className="cup-fixture-order-row" key={row.id}>
            <MatchCard match={row} />
            {['draft', 'published', 'running'].includes(tournament.lifecycle) && <div className="cup-fixture-order-buttons">
              <button className="secondary" aria-label={`Move match ${row.match_order} up`}
                disabled={!writesAvailable || busy || !['draft', 'scheduled'].includes(row.state)
                  || !orderedDraftFixtures.slice(0, index).some((item) => ['draft', 'scheduled'].includes(item.state))}
                onClick={() => moveFixture(index, -1)}>↑</button>
              <button className="secondary" aria-label={`Move match ${row.match_order} down`}
                disabled={!writesAvailable || busy || !['draft', 'scheduled'].includes(row.state)
                  || !orderedDraftFixtures.slice(index + 1).some((item) => ['draft', 'scheduled'].includes(item.state))}
                onClick={() => moveFixture(index, 1)}>↓</button>
            </div>}
          </div>)}
          {['draft', 'published', 'running'].includes(tournament.lifecycle) && orderedDraftFixtures.length === 10
            && orderedDraftFixtures.some((row) => ['draft', 'scheduled'].includes(row.state))
            && <button className="secondary" disabled={!writesAvailable || busy || !kickoff}
              onClick={() => void send(`/api/cup/host/${tournament.id}/fixtures/reorder`, {
                match_ids: fixtureOrderIds, kickoff: new Date(kickoff).toISOString(),
              }).then((saved) => { if (saved) {
                fixtureOrderSource.current.dirty = false
                kickoffSource.current.dirty = false
              } })}>
              Save reviewed order & schedule</button>}
          {['draft', 'published', 'running'].includes(tournament.lifecycle) && fixtureOrderSource.current.dirty
            && <button className="secondary" disabled={busy} onClick={discardFixtureOrder}>Discard order changes</button>}
        </div>}
      </section>
      </>}
      {leagueComplete && tournament.matches.length === 10 && <section className="cup-host-card cup-playoff-setup">
          {tournament.unresolved_tie && <div className="cup-tie-resolution">
            <h3>Choose the order of tied teams</h3>
            <p>Points, goal difference and goals scored are level. Choose one team for each place, then confirm your ranking to decide the playoff participants. This decision is audited and undoable.</p>
            {tiedGroups.map(([rank, rows]) => <fieldset className="cup-tie-group" key={rank}
              disabled={!writesAvailable || busy || tournament.lifecycle === 'paused'}>
              <legend>Tied places {rank}–{rank + rows.length - 1}</legend>
              {rows.map((_, index) => <label className="cup-host-select" key={index}>Place {rank + index}
                <CupSelect value={tieOrders[rank]?.[index] || ''} onChange={(event) => {
                  const teamId = Number(event.target.value)
                  setTieOrders((current) => {
                    const order = [...(current[rank] ?? rows.map(() => 0))]
                    order[index] = teamId
                    return { ...current, [rank]: order }
                  })
                }}>
                  <option value="">Choose team</option>
                  {rows.map((row) => <option value={row.id} key={row.id}
                    disabled={tieOrders[rank]?.some((id, position) => id === row.id && position !== index)}>{row.name}</option>)}
                </CupSelect>
              </label>)}
            </fieldset>)}
            <button disabled={!writesAvailable || busy || tournament.lifecycle === 'paused' || tiedGroups.some(([rank, rows]) =>
              tieOrders[rank]?.length !== rows.length || rows.some((row) => !tieOrders[rank]?.includes(row.id)))}
              onClick={() => {
                const ranking = tiedGroups.flatMap(([rank, rows]) => (tieOrders[rank] ?? []).map((id, index) =>
                  `${rank + index}. ${rows.find((row) => row.id === id)?.name}`)).join('\n')
                if (!window.confirm(`Confirm the host ranking?\n${ranking}\nThis determines playoff qualification. The decision is audited and can be undone.`)) return
                void send(`/api/cup/host/${tournament.id}/tie-resolution`, {
                  team_orders: tiedGroups.map(([rank]) => tieOrders[rank] ?? []),
                }).then((saved) => { if (saved) setTieOrders({}) })
              }}>Save host ranking decisions</button>
          </div>}
          <h3>Add final &amp; third-place match</h3>
          <p>Resolve any exact league-table ties before qualification. Third place plays fourth; first place plays second in the final.</p>
          <CupDateTime label="Third-place kickoff" value={playoffKickoff} onChange={setPlayoffKickoff} />
          <button disabled={!writesAvailable || busy || !playoffKickoff || tournament.lifecycle === 'paused' || !!tournament.unresolved_tie} onClick={() => void send(`/api/cup/host/${tournament.id}/playoffs`, {
            kickoff: new Date(playoffKickoff).toISOString(),
          })}>Add final &amp; third-place match</button>
        </section>}
      {hostTab === 'desk' && <>
      <section className="cup-host-card">
        <h3>Match control & scoring</h3>
        {activeMatchOnPitch ? <p className="cup-host-notice" role="status">Match {activeMatchOnPitch.match_order} is on the pitch. Other fixtures unlock after it is finalized.</p> : <>
        <p>Select any ready league match and start it whenever the pitch is free. Rest intervals do not block kickoff. Playoffs require completed league qualification.</p>
        <label className="cup-host-select">Match <CupSelect value={selectedMatchId ?? ''} onChange={(event) => setSelectedMatchId(Number(event.target.value))}>
          <option value="">Choose a match</option>{tournament.matches.map((row) => <option value={row.id} key={row.id}>
            {row.match_order}. {row.home_team?.name ?? 'TBC'} v {row.away_team?.name ?? 'TBC'} · {row.state}
          </option>)}
        </CupSelect></label></>}
        {tournament.lifecycle === 'paused' && <p className="cup-host-notice" role="status">Tournament paused — use Resume tournament above to unlock match controls. Host activity & undo remains available below.</p>}
        {selectedMatch && <fieldset className="cup-host-match" disabled={tournament.lifecycle === 'paused'}>
          <div className="cup-host-score">
            <div className="cup-host-score-line">
              <span className="cup-host-score-team"><span aria-hidden="true"><Portrait path={selectedMatch.home_team?.logo_path ?? ''} name={selectedMatch.home_team?.name ?? 'Home'} /></span><b>{selectedMatch.home_team?.name ?? 'Home'}</b></span>
              <strong aria-label={`Score ${selectedMatch.home_goals} to ${selectedMatch.away_goals}`}>{selectedMatch.home_goals} – {selectedMatch.away_goals}</strong>
              <span className="cup-host-score-team"><span aria-hidden="true"><Portrait path={selectedMatch.away_team?.logo_path ?? ''} name={selectedMatch.away_team?.name ?? 'Away'} /></span><b>{selectedMatch.away_team?.name ?? 'Away'}</b></span>
            </div>
            {['live', 'paused'].includes(selectedMatch.state) && <p className="cup-clock-status" role="timer">
              {clockPeriod === 'half_time_break'
                ? `Half-time · ${breakRemaining > 0 ? `${clockLabel(breakRemaining)} of the ${breakMinutes}-minute reference break left`
                  : `${clockLabel(breakElapsed - breakMinutes * 60)} past the ${breakMinutes}-minute reference break`} · start the second half whenever ready`
                : `${clockPeriod.replace(/_/g, ' ')}${selectedMatch.state === 'paused' ? ' · paused' : ''} · ${clockLabel(periodElapsed)} / ${clockLabel(periodDuration)} reference${periodElapsed > periodDuration ? ` (+${clockLabel(periodElapsed - periodDuration)})` : ''}`}
            </p>}
            <div className="cup-host-actions">
              {selectedMatch.state === 'scheduled' && <button disabled={!writesAvailable || busy || !startingLineupReady || tournament.lifecycle !== 'running'}
                aria-describedby={tournament.lifecycle !== 'running' ? 'cup-kickoff-prerequisite' : undefined}
                onClick={() => void send(`/api/cup/host/matches/${selectedMatch.id}/clock`, {
                  command: 'kickoff', expected_match_version: selectedMatch.version,
                })}>Kick off</button>}
              {selectedMatch.state === 'scheduled' && tournament.lifecycle !== 'running'
                && <p className="cup-host-notice" id="cup-kickoff-prerequisite" role="status">Start the tournament first — use “Start tournament” at the top of the Match desk.</p>}
              {selectedMatch.state === 'scheduled' && !startingLineupReady
                && <p className="cup-host-notice" role="status">Choose and save the configured starting players and one goalkeeper per team before kickoff.</p>}
              {selectedMatch.state === 'live' && <button className="secondary" disabled={!writesAvailable || busy} onClick={() => void send(`/api/cup/host/matches/${selectedMatch.id}/clock`, { command: 'pause', expected_match_version: selectedMatch.version })}>Pause clock</button>}
              {selectedMatch.state === 'paused' && <button disabled={!writesAvailable || busy} onClick={() => void send(`/api/cup/host/matches/${selectedMatch.id}/clock`, { command: 'resume', expected_match_version: selectedMatch.version })}>
                {clockPeriod === 'half_time_break' ? 'Start second half' : 'Resume clock'}</button>}
              {['live', 'paused'].includes(selectedMatch.state) && clockPeriod !== 'half_time_break'
                && <button className="secondary" disabled={!writesAvailable || busy}
                  onClick={() => {
                    const name = periodName(clockPeriod)
                    if (periodRemaining > 0 && !window.confirm(`${clockLabel(periodRemaining)} of the ${clockLabel(periodDuration)} reference time is left. End the ${name} now?`)) return
                    void send(`/api/cup/host/matches/${selectedMatch.id}/clock`, { command: 'end_period', expected_match_version: selectedMatch.version })
                  }}>End {periodName(clockPeriod)}</button>}
              {selectedMatch.state === 'review' && leagueDrawReview && <button className="secondary" disabled={!writesAvailable || busy}
                onClick={() => {
                  if (!window.confirm(`Settle this ${selectedMatch.home_goals}–${selectedMatch.away_goals} draw by penalties? The shootout winner gets 3 league points and the loser 0. The regulation score stays for goals and statistics. This is audited and can be undone.`)) return
                  void send(`/api/cup/host/matches/${selectedMatch.id}/clock`, {
                    command: 'league_shootout', expected_match_version: selectedMatch.version,
                    shootout_kicks: 5, shootout_taker_rule: shootoutTakerRule,
                  })
                }}>Settle draw by penalties</button>}
              {selectedMatch.state === 'review' && leagueShootout && !selectedMatch.shootout_finish && !selectedMatch.events.some((row) => row.event_type === 'shootout')
                && <button className="secondary" disabled={!writesAvailable || busy} onClick={() => void send(`/api/cup/host/matches/${selectedMatch.id}/clock`, {
                  command: 'cancel_league_shootout', expected_match_version: selectedMatch.version,
                })}>Back to a draw (no penalties)</button>}
              {selectedMatch.state === 'review' && <button disabled={!writesAvailable || busy || (selectedMatch.clock.period === 'shootout' && !shootoutWinner)}
                onClick={() => {
                  const summary = selectedMatch.clock.period === 'shootout' && shootoutWinner
                    ? `${selectedMatch.home_goals}–${selectedMatch.away_goals}, ${shootoutWinner.name} win on penalties (recorded kicks ${selectedMatch.shootout.home}–${selectedMatch.shootout.away}${selectedMatch.shootout_finish?.host_decided ? '; winner awarded by host' : ''})`
                    : `${selectedMatch.home_goals}–${selectedMatch.away_goals}`
                  if (!window.confirm(`Finalize the result as ${summary}? Standings update immediately; this is audited and can be undone.`)) return
                  void send(`/api/cup/host/matches/${selectedMatch.id}/finalize`, { expected_match_version: selectedMatch.version })
                }}>{leagueDrawReview ? 'Finalize as a draw' : selectedMatch.clock.period === 'shootout'
                  ? (shootoutWinner ? `Finalize · ${shootoutWinner.name} win on pens` : 'Finalize after a decisive shootout') : 'Finalize result'}</button>}
              {selectedMatch.state === 'review' && leagueShootout && <p className="cup-host-notice" role="status">
                League penalties: regulation {selectedMatch.home_goals}–{selectedMatch.away_goals} stands for goals and statistics; shootout {selectedMatch.shootout.home}–{selectedMatch.shootout.away}. Winner gets 3 points, loser 0.</p>}
              {finalizedLeagueDraw && <button className="secondary" disabled={!writesAvailable || busy || Boolean(reopenBlocked)}
                aria-describedby="cup-reopen-pens-note"
                onClick={() => {
                  if (!window.confirm(`Settle this finalized ${selectedMatch.home_goals}–${selectedMatch.away_goals} draw by penalties? The match goes back to result review for the shootout, then you finalize it again. The winner gets 3 league points and the loser 0; the regulation score stays for goals and statistics. Rest times keep the original full-time. This is audited and can be undone.`)) return
                  void send(`/api/cup/host/matches/${selectedMatch.id}/clock`, {
                    command: 'league_shootout', expected_match_version: selectedMatch.version,
                    shootout_kicks: 5, shootout_taker_rule: shootoutTakerRule,
                  })
                }}>Settle this draw by penalties</button>}
              {finalizedLeagueDraw && <p className="cup-host-notice" id="cup-reopen-pens-note" role="status">
                {reopenBlocked || 'Finalized as a draw. You can still settle it by penalties: record each taker, then finalize the winner.'}</p>}
              <StatusPill value={selectedMatch.state} />
            </div>
            {shootoutActive && <section className="cup-shootout-panel" aria-labelledby="cup-shootout-title">
              <div className="cup-shootout-head">
                <h4 id="cup-shootout-title">Penalty shootout</h4>
                <p className="cup-shootout-score" aria-live="polite">
                  <span>{selectedMatch.home_team?.name}</span>
                  <strong>{selectedMatch.shootout.home} – {selectedMatch.shootout.away}</strong>
                  <span>{selectedMatch.away_team?.name}</span>
                </p>
                <p className="cup-shootout-progress" role="status">{shootoutWinner
                  ? selectedMatch.shootout_finish?.host_decided
                    ? `${shootoutWinner.name} awarded the win by the host · recorded penalties ${selectedMatch.shootout.home}–${selectedMatch.shootout.away} · finalize the result above`
                    : `${shootoutWinner.name} win ${selectedMatch.shootout.home}–${selectedMatch.shootout.away} on penalties · finalize the result above`
                  : `${shootoutRound > shootoutKicks ? `Sudden death · round ${shootoutRound}` : `Round ${shootoutRound} of ${shootoutKicks}`} · ${nextKickTeam?.name ?? 'Next team'} to kick`}</p>
              </div>
              {selectedMatch.shootout_finish ? <p className="cup-host-notice" role="status">
                {selectedMatch.shootout_finish.host_decided ? 'Winner explicitly awarded by the host at a tied penalty score.'
                  : 'Shootout finished by the host at the recorded score.'} All kicks are preserved. Undo “shootout finish” in Host activity to reopen.
              </p> : <div className="cup-shootout-finish">
                <p>Finish at any point, even before all kicks are taken. Recorded kicks stay unchanged.</p>
                {selectedMatch.shootout.home === selectedMatch.shootout.away && <label>Winner awarded by host
                  <CupSelect value={finishPenaltyWinner ?? ''} onChange={(event) => setFinishPenaltyWinner(Number(event.target.value) || null)}>
                    <option value="">Choose the winning team</option>
                    {[selectedMatch.home_team, selectedMatch.away_team].map((team) => team && <option key={team.id} value={team.id}>{team.name}</option>)}
                  </CupSelect>
                </label>}
                <button type="button" className="secondary" disabled={!writesAvailable || busy
                  || (selectedMatch.shootout.home === selectedMatch.shootout.away
                    && ![selectedMatch.home_team_id, selectedMatch.away_team_id].includes(finishPenaltyWinner))}
                  onClick={() => {
                    const tied = selectedMatch.shootout.home === selectedMatch.shootout.away
                    const winnerId = tied ? finishPenaltyWinner
                      : selectedMatch.shootout.home > selectedMatch.shootout.away ? selectedMatch.home_team_id : selectedMatch.away_team_id
                    const winner = [selectedMatch.home_team, selectedMatch.away_team].find((team) => team?.id === winnerId)
                    if (!winner || !window.confirm(`Finish this shootout now after ${shootoutAttempts.length} kicks? Recorded penalties: ${selectedMatch.shootout.home}–${selectedMatch.shootout.away}. ${tied
                      ? `You explicitly award the win to ${winner.name} despite the tied score. No successful kicks will be invented.`
                      : `${winner.name} lead and will win.`} This is audited and undoable. Finalize the match result afterwards.`)) return
                    void send(`/api/cup/host/matches/${selectedMatch.id}/shootout/finish`, {
                      expected_match_version: selectedMatch.version, confirm: true, winner_team_id: winner.id,
                    }).then((saved) => { if (saved) setFinishPenaltyWinner(null) })
                  }}>Finish shootout</button>
              </div>}
              {!shootoutWinner && nextKickTeam && <>
                <fieldset className="cup-shootout-takers">
                  <legend>{nextKickTeam.name} penalty taker</legend>
                  {penaltyEligible.length ? penaltyEligible.map((person) => {
                    const waiting = penaltyWaiting.has(person.id)
                    const duplicateName = penaltyEligible.some((other) => other.id !== person.id && other.name === person.name)
                    return <button type="button" key={person.id} aria-pressed={penaltyTaker === person.id}
                      className={penaltyTaker === person.id ? 'is-selected' : undefined} disabled={waiting}
                      title={waiting ? 'Already taken this rotation' : undefined}
                      onClick={() => setPenaltyTaker(person.id)}>
                      <span className="cup-shootout-photo" aria-hidden="true"><Portrait path={person.photo_path} name={person.name} /></span>
                      <span>{person.name}{duplicateName && <small>{person.position} · player #{person.id}</small>}{waiting && <small>taken</small>}</span>
                    </button>
                  }) : <p className="cup-empty-text">No assigned squad player is eligible to take a penalty.</p>}
                </fieldset>
                <div className="cup-shootout-outcome">
                  {([[true, '⚽ Scored'], [false, '✕ Missed / saved']] as const).map(([scored, label]) =>
                    <button key={label} type="button" className={scored ? undefined : 'secondary'}
                      disabled={!writesAvailable || busy || penaltyTaker === null || !penaltyEligible.some((row) => row.id === penaltyTaker)}
                      onClick={() => {
                        if (penaltyTaker === null) return
                        void send(`/api/cup/host/matches/${selectedMatch.id}/shootout`, {
                          expected_match_version: selectedMatch.version, team_id: nextKickTeam.id,
                          player_id: penaltyTaker, scored,
                        }).then((saved) => { if (saved) setPenaltyTaker(null) })
                      }}>{label}</button>)}
                </div>
                <p className="cup-shootout-hint">Teams alternate, starting with {selectedMatch.home_team?.name}. Every eligible player kicks before anyone repeats. Kicks don’t change the match score or player statistics. Use Undo in Recorded events to remove a mistaken kick.</p>
              </>}
              {shootoutAttempts.length > 0 && <ol className="cup-shootout-attempts" aria-label="Penalty attempts">
                {shootoutAttempts.map((row, index) => {
                  const side = row.team_id === selectedMatch.home_team_id ? selectedMatch.home_team : selectedMatch.away_team
                  const scored = row.payload?.scored === true
                  const duplicateName = tournament.teams.find((team) => team.id === row.team_id)?.players
                    ?.some((person) => person.id !== row.player_id && person.name === row.player?.name)
                  return <li key={row.id} className={scored ? 'is-scored' : 'is-missed'}>
                    <span>{index + 1}</span><b>{row.player?.name ?? 'Player'}{duplicateName && <small> · #{row.player_id}</small>}</b><small>{side?.name}</small>
                    <em>{scored ? 'Scored' : 'Missed'}</em>
                  </li>
                })}
              </ol>}
            </section>}
            {['live', 'paused', 'review', 'finalized'].includes(selectedMatch.state) && <div className="cup-host-event-glance">
              <h4>Recorded events <small>{selectedMatch.events.length} saved on the server</small></h4>
              {selectedMatch.events.length ? <ol aria-label="Recorded match events">{[...selectedMatch.events].reverse().map((event) => {
                const team = event.team_id === selectedMatch.home_team_id ? selectedMatch.home_team : selectedMatch.away_team
                const incoming = event.event_type === 'substitution'
                  ? selectedMatch.participations.find((row) => row.player?.id === Number(event.payload?.incoming_player_id))?.player?.name
                  : null
                const edited = history.some((entry) => entry.action === 'event_correction' && !entry.undone
                  && Number(entry.details.event_id) === event.id)
                const audit = eventAuditEntry(event)
                const editable = ['shot', 'own_goal', 'shootout', 'yellow_card', 'red_card', 'substitution'].includes(event.event_type)
                const editing = correctEventId === event.id
                const name = event.event_type === 'substitution' ? `${incoming ?? 'Substitute'} on · ${event.player?.name ?? 'Player'} off` : event.player?.name ?? 'Player'
                return <li key={event.id} data-event-id={event.id} className={editing ? 'is-editing' : undefined}>
                  <span className="cup-glance-minute">{event.event_type === 'shootout' ? 'Pen' : `${event.minute}′`}</span>
                  <span className="cup-glance-icon" aria-hidden="true">{eventIcon(event)}</span>
                  <span><strong>{name}</strong>
                    <small>{eventLabel(event)}{event.assist ? ` · assist ${event.assist.name}` : ''}{event.goalkeeper ? ` · save ${event.goalkeeper.name}` : ''} · {team?.name ?? 'Team'}</small></span>
                  {edited && <em className="cup-glance-edited">Corrected</em>}
                  <span className="cup-glance-actions">
                    {editable && <button type="button" className={editing ? 'selected' : 'secondary'} aria-expanded={editing}
                      aria-label={`Edit ${eventLabel(event)} by ${name}`} disabled={busy}
                      onClick={() => beginCorrection(editing ? null : event)}>Edit</button>}
                    {audit && <button type="button" className="secondary" aria-label={`Undo ${eventLabel(event)} by ${name}`}
                      disabled={!writesAvailable || busy}
                      onClick={() => void undo(audit.id, `${eventLabel(event)} · ${name}`).then((done) => { if (done && editing) setCorrectEventId(null) })}>Undo</button>}
                  </span>
                  {editing && correctionPanel(selectedMatch, event)}
                </li>
              })}</ol> : <p className="cup-empty-text">No events recorded yet.</p>}
              <p className="cup-glance-note">Edit fixes the player, assist, time or outcome. Undo reverses that entry plus any later host actions (you see the list first). Everything stays in Host activity &amp; undo.</p>
            </div>}
          </div>
          {['live', 'paused', 'review', 'finalized'].includes(selectedMatch.state) && <div className="cup-event-form">
            <h4>Record a match event <small>{['live', 'paused'].includes(selectedMatch.state) && !historicalEntry ? 'The minute is taken from the match clock when you save.' : 'Offline writes are blocked; check history after reconnecting.'}</small></h4>
            {['live', 'paused'].includes(selectedMatch.state) && <label className="cup-check cup-historical-entry"><input type="checkbox" checked={historicalEntry}
              aria-describedby="cup-historical-entry-help" onChange={(event) => setHistoricalEntry(event.target.checked)} />
              <span>Add an omitted earlier event<small id="cup-historical-entry-help">Choose the played period and minute instead of using the live clock.</small></span></label>}
            {(historicalEntry || ['review', 'finalized'].includes(selectedMatch.state)) && <>
              <p>Omitted events must follow all previously recorded match events. Undo dependent later actions first if this event belongs earlier.</p>
              <label>Played period <CupSelect value={historicalPeriod} onChange={(event) => setHistoricalPeriod(event.target.value)}>
                <option value="first_half">First half</option><option value="second_half">Second half</option>
                <option value="extra_time_1">Extra time 1</option><option value="extra_time_2">Extra time 2</option>
              </CupSelect></label>
            </>}
            <div className="cup-event-controls">
              <label>Team <CupSelect value={eventTeam ?? ''} onChange={(event) => {
                setEventTeam(Number(event.target.value) || null)
                setEventPlayer(null); setEventAssist(null); setEventKeeper(null)
              }}><option value="">Choose team</option>
                {[selectedMatch.home_team, selectedMatch.away_team].filter((row): row is Team => row !== null).map((side) => <option key={side.id} value={side.id}>{side.name}</option>)}
              </CupSelect></label>
              <label>Player <CupSelect value={eventPlayer ?? ''} onChange={(event) => {
                setEventPlayer(Number(event.target.value) || null)
                setReplacementKeeper(null)
              }}>
                <option value="">Choose player</option>{activeEventPlayers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </CupSelect></label>
              {(historicalEntry || ['review', 'finalized'].includes(selectedMatch.state)) && <label>Minute <input type="number" min={0} max={300} value={eventMinute} onChange={(event) => setEventMinute(Number(event.target.value))} /></label>}
              <label>Event <CupSelect value={eventOutcome} onChange={(event) => {
                setEventOutcome(event.target.value)
                setReplacementKeeper(null)
              }}>
                <option value="goal">Shot · goal</option><option value="saved">Shot · saved</option>
                <option value="off_target">Shot · off target</option><option value="blocked">Shot · blocked</option>
                <option value="own_goal">Own goal</option><option value="yellow_card">Yellow card</option><option value="red_card">Red card</option>
              </CupSelect></label>
              {eventOutcome === 'goal' && <label>Assist (optional) <CupSelect value={eventAssist ?? ''} onChange={(event) => setEventAssist(Number(event.target.value) || null)}>
                <option value="">No assist</option>{activeEventPlayers.filter((person) => person.id !== eventPlayer).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </CupSelect></label>}
              {eventOutcome === 'saved' && <label>Opposing goalkeeper <CupSelect value={eventKeeper ?? ''} onChange={(event) => setEventKeeper(Number(event.target.value) || null)}>
                <option value="">Choose goalkeeper</option>{eventKeepers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </CupSelect></label>}
              {needsReplacementKeeper && <label>Replacement goalkeeper <CupSelect value={replacementKeeper ?? ''} onChange={(event) =>
                setReplacementKeeper(Number(event.target.value) || null)}>
                <option value="">Choose active teammate</option>{replacementKeeperChoices.map((person) =>
                  <option value={person.id} key={person.id}>{person.name}</option>)}
              </CupSelect></label>}
            </div>
            <button disabled={!writesAvailable || busy || eventTeam === null || eventPlayer === null
              || (needsReplacementKeeper && replacementKeeper === null)}
              onClick={() => {
                if (eventTeam === null || eventPlayer === null) return
                const historical = historicalEntry || ['review', 'finalized'].includes(selectedMatch.state)
                if (selectedMatch.state === 'finalized' && !window.confirm('Add this omitted event to the finalized result? The change is audited and can be undone.')) return
                const event_type = ['goal', 'saved', 'off_target', 'blocked'].includes(eventOutcome)
                  ? 'shot' : eventOutcome
                void send(`/api/cup/host/matches/${selectedMatch.id}/events`, {
                  expected_match_version: selectedMatch.version, event_type, team_id: eventTeam,
                  player_id: eventPlayer, ...(historical ? { minute: eventMinute } : {}),
                  period: historical ? historicalPeriod : selectedMatch.clock.period ?? 'first_half',
                  historical, confirm_finalized: selectedMatch.state === 'finalized',
                  ...(event_type === 'shot' ? {
                    outcome: eventOutcome,
                    ...(eventOutcome === 'goal' && eventAssist ? { assist_player_id: eventAssist } : {}),
                    ...(eventOutcome === 'saved' && eventKeeper ? { goalkeeper_id: eventKeeper } : {}),
                  } : {}),
                  ...(needsReplacementKeeper && replacementKeeper
                    ? { replacement_goalkeeper_id: replacementKeeper } : {}),
                })
              }}>Save event</button>
          </div>}
          {['live', 'paused'].includes(selectedMatch.state) && <div className="cup-event-form cup-sub-panel">
            <h4>Rolling substitution <small>Players who went off can come back on. The minute comes from the match clock.</small></h4>
            <div className="cup-sub-teams" role="group" aria-label="Substitution team">
              {[selectedMatch.home_team, selectedMatch.away_team].filter((row): row is Team => row !== null).map((side) =>
                <button type="button" key={side.id} className={subTeam === side.id ? 'selected' : 'secondary'} aria-pressed={subTeam === side.id}
                  onClick={() => { setSubTeam(side.id); setSubOff(null); setSubOn(null) }}>{side.name}</button>)}
            </div>
            {missingBench.length > 0 && <div className="cup-bench-fill">
              <p>{missingBench.length} squad player{missingBench.length === 1 ? ' is' : 's are'} not in this match yet ({missingBench.map((person) => person.name).join(', ')}). Add them to the bench so they can come on. Players already in the match keep their status; this is audited and can be undone.</p>
              <button type="button" className="secondary" disabled={!writesAvailable || busy}
                onClick={() => void send(`/api/cup/host/matches/${selectedMatch.id}/bench`, {
                  expected_match_version: selectedMatch.version,
                })}>Add remaining squad to bench ({missingBench.length})</button>
            </div>}
            {subTeam !== null && <>
              <div className="cup-sub-columns">
                <div role="group" aria-label="Player coming off"><span>Coming off</span>
                  {subOnPitch.length ? subOnPitch.map((row) => row.player && <button type="button" key={row.player.id}
                    className={subOff === row.player.id ? 'selected' : 'secondary'} aria-pressed={subOff === row.player.id}
                    onClick={() => setSubOff(row.player?.id ?? null)}>{row.player.name}{row.goalkeeper ? ' (GK)' : ''}</button>)
                    : <p className="cup-empty-text">No players on the pitch.</p>}
                </div>
                <div role="group" aria-label="Player coming on"><span>Coming on</span>
                  {subAvailable.length ? subAvailable.map((row) => row.player && <button type="button" key={row.player.id}
                    className={subOn === row.player.id ? 'selected' : 'secondary'} aria-pressed={subOn === row.player.id}
                    onClick={() => setSubOn(row.player?.id ?? null)}>{row.player.name}{row.status === 'substituted' ? ' · re-entry' : ''}</button>)
                    : <p className="cup-empty-text">No bench or substituted players available.</p>}
                </div>
              </div>
              {subOffIsKeeper && <p className="cup-host-notice" role="status">The goalkeeper is coming off — the incoming player takes over in goal. Use “Change active goalkeeper” afterwards to hand the gloves to someone else.</p>}
              <button disabled={!writesAvailable || busy || subOff === null || subOn === null}
                onClick={() => {
                  if (subTeam === null || subOff === null || subOn === null) return
                  void send(`/api/cup/host/matches/${selectedMatch.id}/events`, {
                    expected_match_version: selectedMatch.version, event_type: 'substitution', team_id: subTeam,
                    player_id: subOff, incoming_player_id: subOn,
                    period: selectedMatch.clock.period ?? 'first_half', historical: false, confirm_finalized: false,
                  }).then((saved) => { if (saved) { setSubOff(null); setSubOn(null) } })
                }}>Make substitution</button>
            </>}
          </div>}
          {['live', 'paused'].includes(selectedMatch.state) && <div className="cup-event-form">
            <h4>Change active goalkeeper</h4>
            <div className="cup-event-controls">
              <label>Team <CupSelect aria-label="Goalkeeper team" value={keeperTeamId ?? ''} onChange={(event) => {
                const teamId = Number(event.target.value) || null
                setKeeperTeamId(teamId)
                setKeeperPlayerId(selectedMatch.participations.find((row) =>
                  row.team_id === teamId && row.goalkeeper && ['starter', 'entered'].includes(row.status),
                )?.player?.id ?? null)
              }}><option value="">Choose team</option>
                {[selectedMatch.home_team, selectedMatch.away_team].filter((row): row is Team => row !== null)
                  .map((side) => <option key={side.id} value={side.id}>{side.name}</option>)}
              </CupSelect></label>
              <label>Active goalkeeper <CupSelect aria-label="Active goalkeeper" value={keeperPlayerId ?? ''} onChange={(event) =>
                setKeeperPlayerId(Number(event.target.value) || null)}>
                <option value="">Choose active player</option>{keeperChoices.map((person) =>
                  <option value={person.id} key={person.id}>{person.name}</option>)}
              </CupSelect></label>
              <button className="secondary" disabled={!writesAvailable || busy || keeperTeamId === null
                || keeperPlayerId === null
                || selectedMatch.participations.some((row) => row.team_id === keeperTeamId
                  && row.player?.id === keeperPlayerId && row.goalkeeper && ['starter', 'entered'].includes(row.status))}
                onClick={() => {
                  if (keeperTeamId === null || keeperPlayerId === null) return
                  void send(`/api/cup/host/matches/${selectedMatch.id}/goalkeeper`, {
                    expected_match_version: selectedMatch.version,
                    team_id: keeperTeamId, player_id: keeperPlayerId,
                  })
                }}>Save goalkeeper</button>
            </div>
          </div>}
          {selectedMatch.stage !== 'league' && selectedMatch.state === 'scheduled' && <div className="cup-event-form">
            <h4>Reschedule this playoff</h4>
            <CupDateTime label="New kickoff" value={rescheduledKickoff} onChange={setRescheduledKickoff} />
            <button className="secondary" disabled={!writesAvailable || busy || !rescheduledKickoff}
              onClick={() => void send(`/api/cup/host/matches/${selectedMatch.id}/reschedule`, {
                kickoff: new Date(rescheduledKickoff).toISOString(),
              }).then((saved) => { if (saved) setRescheduledKickoff('') })}>Save playoff kickoff</button>
          </div>}
          {selectedMatch.stage !== 'league' && selectedMatch.state === 'scheduled' && <div className="cup-playoff-rules">
            <h4>Draw-deciding method</h4>
            <p>Choose before kickoff. Penalty shootouts remain separate from match goals and player statistics.</p>
            <div className="cup-host-actions">
              <button className="secondary" disabled={!writesAvailable || busy} onClick={() => void send(`/api/cup/host/matches/${selectedMatch.id}/playoff-rules`, {
                expected_match_version: selectedMatch.version, draw_method: 'direct_penalties',
                extra_time_minutes: 0, shootout_kicks: 5,
                shootout_taker_rule: shootoutTakerRule,
              })}>Direct penalties</button>
              <button className="secondary" disabled={!writesAvailable || busy} onClick={() => {
                const minutes = Number(window.prompt('Extra-time minutes per period', '5'))
                if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) return
                void send(`/api/cup/host/matches/${selectedMatch.id}/playoff-rules`, {
                  expected_match_version: selectedMatch.version, draw_method: 'extra_time_penalties',
                  extra_time_minutes: minutes, shootout_kicks: 5,
                  shootout_taker_rule: shootoutTakerRule,
                })
              }}>Extra time + penalties</button>
            </div>
            <label>Penalty taker rotation
              <CupSelect aria-label="Penalty taker rotation" value={shootoutTakerRule}
                onChange={(event) => setShootoutTakerRule(event.target.value)}>
                <option value="rotate_active_players">Every eligible squad player kicks before anyone repeats; team totals may differ</option>
                <option value="equal_players_only">Require equal eligible squad counts; rotate takers each round</option>
              </CupSelect>
            </label>
          </div>}
          {['scheduled', 'draft'].includes(selectedMatch.state) &&
            <div className="cup-lineup-editor"><h4>Lineup & active goalkeeper</h4>
              <p>Choose {Number(tournament.settings.players_per_side)} starters for each team, then choose the starting goalkeeper from those players. Everyone else in the squad goes on the bench automatically.</p>
              {lineupRosterProblem && <p role="alert">{lineupRosterProblem}</p>}
              {!lineupRosterProblem && lineupSides.map((side) => {
                if (!side || !side.players) return null
                const key = `${selectedMatch.id}:${side.id}`
                const draft = drafts[key] ?? savedLineup(selectedMatch, side.id)
                const starterCount = Number(tournament.settings.players_per_side)
                return <div className="cup-lineup-side" key={side.id}>
                  <strong>{side.name} <small>{draft.starters.length}/{starterCount} starters · {side.players.length - draft.starters.length} on the bench automatically</small></strong>
                  <div className="cup-lineup-roster">{side.players.map((person) => {
                    const isStarter = draft.starters.includes(person.id)
                    const isKeeper = draft.goalkeeper === person.id
                    return <article className="cup-lineup-player" key={person.id}>
                      <span><b>{person.name}</b><small>{person.position}</small></span>
                      <div className="cup-lineup-player-actions">
                        <button type="button" className={isStarter ? 'selected' : 'secondary'}
                          aria-pressed={isStarter} disabled={busy || (!isStarter && draft.starters.length >= starterCount)}
                          onClick={() => toggleLineupPlayer(side.id, person.id)}>
                          {isStarter ? 'Starting' : 'Select starter'}
                        </button>
                        {isStarter && <button type="button" className={isKeeper ? 'cup-lineup-keeper selected' : 'cup-lineup-keeper secondary'}
                          aria-pressed={isKeeper} disabled={busy}
                          onClick={() => updateDraft(side.id, { goalkeeper: isKeeper ? null : person.id })}>
                          {isKeeper ? 'Starting goalkeeper' : 'Set as goalkeeper'}
                        </button>}
                      </div>
                    </article>
                  })}</div>
                </div>
              })}
              {lineupSides.length === 2 && <p className="cup-lineup-status" role="status">{lineupSides.map((side) => {
                if (!side) return 'Team roster unavailable'
                const draft = drafts[`${selectedMatch.id}:${side.id}`] ?? savedLineup(selectedMatch, side.id)
                return `${side.name}: ${draft.starters.length}/${Number(tournament.settings.players_per_side)} starters${draft.goalkeeper && draft.starters.includes(draft.goalkeeper) ? ', goalkeeper selected' : ', choose a goalkeeper'}`
              }).join(' · ')}</p>}
              <button className="secondary" disabled={!writesAvailable || busy || !!lineupRosterProblem || lineupSides.length !== 2
                || lineupSides.some((side) => {
                  if (!side) return true
                  const draft = drafts[`${selectedMatch.id}:${side.id}`] ?? savedLineup(selectedMatch, side.id)
                  return draft.starters.length !== Number(tournament.settings.players_per_side)
                    || draft.goalkeeper === null || !draft.starters.includes(draft.goalkeeper)
                })
                || !lineupSides.some((side) => {
                  if (!side) return false
                  const draft = drafts[`${selectedMatch.id}:${side.id}`]
                  if (draft?.dirty) return true
                  const saved = savedLineup(selectedMatch, side.id)
                  const bench = (side.players ?? []).map((person) => person.id).filter((id) => !saved.starters.includes(id))
                  return bench.length !== saved.bench.length || bench.some((id) => !saved.bench.includes(id))
                })}
                onClick={() => {
                const sides = lineupSides.filter((side): side is Team => !!side)
                const selectedDrafts = sides.map((side) => drafts[`${selectedMatch.id}:${side.id}`] ?? savedLineup(selectedMatch, side.id))
                const players = sides.flatMap((side, index) => {
                  const draft = selectedDrafts[index]
                  return [
                    ...draft.starters.map((player_id) => ({ player_id, team_id: side.id, status: 'starter', goalkeeper: player_id === draft.goalkeeper })),
                    ...(side.players ?? []).filter((person) => !draft.starters.includes(person.id))
                      .map((person) => ({ player_id: person.id, team_id: side.id, status: 'bench', goalkeeper: false })),
                  ]
                })
                void send(`/api/cup/host/matches/${selectedMatch.id}/lineup`, {
                  expected_match_version: Math.min(...selectedDrafts.map((draft) => draft.matchVersion)), players,
                }).then((saved) => {
                  if (saved) setDrafts((value) => Object.fromEntries(
                    Object.entries(value).filter(([key]) => !key.startsWith(`${selectedMatch.id}:`)),
                  ))
                })
              }}>Save starting lineups</button>
            </div>}
        </fieldset>}
      </section>
      <details className="cup-host-disclosure cup-host-card">
        <summary>Host activity & undo</summary>
        <p>Undo previews include later active cup commands and reverse confirmed cascades in dependency order. Undo entries are preserved but cannot themselves be undone. Auction actions are not included.</p>
        {history.length ? <ol className="cup-history">{[...history].reverse().map((entry) => <li key={entry.id}>
          <span><strong>{entry.action.replace(/_/g, ' ')}</strong><small>{new Date(entry.created_at).toLocaleString(undefined, { hour12: true })} · {entry.match_id ? `Match ${entry.match_id}` : 'Tournament'}</small></span>
          <button className="secondary" disabled={!writesAvailable || busy || entry.undone || entry.action === 'undo'} onClick={() => void undo(entry.id)}>
            {entry.action === 'undo' ? 'Undo record' : entry.undone ? 'Undone' : 'Undo'}
          </button>
        </li>)}</ol> : <p className="cup-empty-text">Cup actions appear here after the first host change.</p>}
      </details>
      </>}
    </div>}
  </section>
}
