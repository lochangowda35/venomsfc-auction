export type Position = 'GK' | 'DEF' | 'MID' | 'ST'
export type SetName = Position | 'UNSOLD'
export type Bid = { team_id: number; amount: number }
export type Player = {
  id: number
  name: string
  photo_path: string
  position: Position
  status: 'available' | 'current' | 'sold' | 'unsold'
  team_id: number | null
  price: number | null
  captain: boolean
  bids: Bid[] // Final sold round only, in order. Empty for captains/unsold.
}
export type Team = {
  id: number
  name: string
  logo_path: string
  budget: number // Remaining points, not the initial allocation.
  spent: number
  remaining_slots: number
  max_bid: number
  roster: Array<Pick<Player, 'id' | 'name' | 'photo_path' | 'position'> & { price: number; captain: boolean }>
}
export type AuctionState = {
  version: number
  fixed_teams?: boolean
  status: 'setup' | 'running' | 'paused' | 'completed'
  squad_size: number
  open_set: SetName | null
  teams: Team[]
  players: Player[]
  current: null | { player_id: number; team_id: number | null; bid: number; bids?: Bid[] }
  last_event: null | { action: string; player_id?: number; team_id?: number; amount?: number; set_name?: SetName }
  can_undo: boolean
}
export type Session = { authenticated: boolean; csrf_token: string }
export type AuctionEvent = {
  id: number
  action: string
  created_at: string
  undone: boolean
  summary: Record<string, unknown>
}
export type Action =
  | 'configure' | 'start' | 'select' | 'random' | 'bid' | 'sold' | 'unsold'
  | 'pause' | 'resume' | 'undo' | 'reauction'
  | 'captain' | 'remove_captain' | 'open_set' | 'close_set'
export type ActionFields = {
  player_id?: number; team_id?: number; squad_size?: number; price?: number; set_name?: SetName
}
