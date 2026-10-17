import type { AuctionState, Player, SetName, Team } from './types'

export const positions = ['GK', 'DEF', 'MID', 'ST'] as const
export const sets: SetName[] = ['GK', 'DEF', 'MID', 'ST', 'UNSOLD']
export const setLabels: Record<SetName, string> = {
  GK: 'Set 1 · Goalkeepers', DEF: 'Set 2 · Defenders', MID: 'Set 3 · Midfielders', ST: 'Set 4 · Strikers', UNSOLD: 'Unsold',
}
export const captainLimit = (squadSize: number) => 1000 - 10 * (squadSize - 1)

/** Every player shown in a set grid: waiting, current and already sold. Captains are not auctioned. */
export function setMembers(state: AuctionState, set: SetName): Player[] {
  const fromUnsold = (p: Player) => p.status === 'unsold' || (p.status === 'current' && state.open_set === 'UNSOLD')
  if (set === 'UNSOLD') return state.players.filter(fromUnsold)
  return state.players.filter((p) => !p.captain && p.position === set && !fromUnsold(p))
}

/** Players the host can still bring to the floor from a set (mirrors the server rule). */
export const setPool = (state: AuctionState, set: SetName) =>
  setMembers(state, set).filter((p) => p.status === (set === 'UNSOLD' ? 'unsold' : 'available'))
export const mediaPath = /^\/api\/(?:media\/[a-zA-Z0-9-]+\.(?:jpg|jpeg|png|webp)|branding\/(?:blackmambas|cobras|vipers|pythons|anacondas)\.jpg)$/i

export function portraitPath(path: string): string {
  if (path === '/api/branding/blackmambas.jpg') return '/api/branding/blackmambas-crest.jpg'
  if (path === '/api/branding/vipers.jpg') return '/api/branding/vipers-crest.jpg'
  return path
}
export const credits = (amount: number) => new Intl.NumberFormat('en-IN').format(amount)
export const availablePlayers = (state: AuctionState) => state.players.filter((p) => p.status === 'available' || p.status === 'unsold')

export function bidBlockReason(state: AuctionState, team: Team): string | null {
  if (state.status !== 'running') return 'Auction is not live'
  if (!state.current) return 'Choose a player first'
  if (team.remaining_slots <= 0) return 'Squad full'
  if (state.current.team_id === team.id) return 'Leading bid'
  if (state.current.bid + 10 > team.max_bid) return 'Reserve / budget limit'
  return null
}

export function setupProblems(state: AuctionState): string[] {
  const problems: string[] = []
  if (state.teams.length !== 5) problems.push(`Add exactly five teams (${state.teams.length}/5 ready).`)
  if (!Number.isInteger(state.squad_size) || state.squad_size < 1 || state.squad_size > 100) {
    problems.push('Choose a squad size between 1 and 100.')
  }
  const needed = 5 * state.squad_size
  if (state.players.length < needed) problems.push(`Add ${needed - state.players.length} more players for ${state.squad_size} per team (${needed} total).`)
  if (state.teams.some((t) => !mediaPath.test(t.logo_path))) problems.push('Re-upload team logos that are missing or from the old demo.')
  if (state.players.some((p) => !mediaPath.test(p.photo_path))) problems.push('Re-upload player photos that are missing or from the old demo.')
  const withCaptain = state.teams.filter((t) => t.roster.some((r) => r.captain)).length
  if (withCaptain < state.teams.length || state.teams.length === 0) problems.push(`Assign a captain and captain price for every team (${withCaptain}/5 done).`)
  return problems
}

export function eventDescription(state: AuctionState): string {
  const event = state.last_event
  if (!event) return state.status === 'setup' ? 'The stage is yours. Build your auction.' : 'Welcome to matchday.'
  const player = state.players.find((p) => p.id === event.player_id)?.name ?? 'Player'
  const team = state.teams.find((t) => t.id === event.team_id)?.name ?? 'Team'
  switch (event.action) {
    case 'bid': return `${team} bids ${credits(event.amount ?? state.current?.bid ?? 0)} points`
    case 'sold': return `${player} → ${team}${event.amount !== undefined ? ` · ${credits(event.amount)} points` : ''}`
    case 'unsold': return `${player} goes unsold`
    case 'select':
    case 'random': return `${player} enters the auction`
    case 'reauction': return `${player} is back in the pool`
    case 'pause': return 'Auction paused. We’ll be right back.'
    case 'resume': return 'Back in play. Bidding is open.'
    case 'start': return 'The auction is live!'
    case 'undo': return 'Latest change reversed · state restored'
    case 'configure': return `Squad size set to ${state.squad_size}`
    case 'profile': return 'Auction setup updated. Matchday is getting closer.'
    case 'captain': return `${player} named captain of ${team}${event.amount !== undefined ? ` · ${credits(event.amount)} points` : ''}`
    case 'remove_captain': return `${team} captain cleared`
    case 'open_set': return `${event.set_name ? setLabels[event.set_name] : 'Set'} is open`
    case 'close_set': return `${event.set_name ? setLabels[event.set_name] : 'Set'} closed`
    case 'maintenance': return 'Auction reset to setup by the organiser.'
    default: return event.action.replace(/_/g, ' ')
  }
}

export function resultsCsv(players: Player[], teams: Team[]): string {
  const cell = (value: unknown) => {
    const raw = String(value ?? '')
    // Neutralize spreadsheet formulas, including leading whitespace/control characters.
    const prefix = [...raw].find((character) => character.charCodeAt(0) > 32 && character.trim())
    const safe = prefix && '=+-@'.includes(prefix) ? `'${raw}` : raw
    return `"${safe.replace(/"/g, '""')}"`
  }
  const rows = [['Player', 'Position', 'Status', 'Team', 'Price (points)'],
    ...players.map((p) => [p.name, p.position, p.status, teams.find((t) => t.id === p.team_id)?.name ?? '', p.price ?? ''])]
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n')
}
