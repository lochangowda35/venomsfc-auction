import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/cup-auth/session', (route) =>
    route.fulfill({ json: { authenticated: false, csrf_token: 'synthetic-public-only' } }))
  await page.route('**/api/branding/**', (route) => route.fulfill({ status: 404 }))
})

for (const unresolved of [null, 'An exact sporting tie requires a host decision.']) {
test(`completed league ${unresolved ? 'awaits sporting tie resolution' : 'announces official playoff participants everywhere'}`, async ({ page }) => {
  const teams = ['Anacondas', 'BlackMambas', 'Cobras', 'Pythons', 'Vipers'].map((name, index) => ({
    id: index + 1, name, logo_path: '', players: [],
  }))
  const standings = teams.map((side, index) => ({
    ...side, rank: index + 1, played: 4, won: 4 - index, drawn: 0, lost: index,
    goals_for: 4 - index, goals_against: index, goal_difference: 4 - index * 2, points: 12 - index * 3,
  }))
  const fixtures = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1, tournament_id: 1, match_order: index + 1, stage: 'league', state: 'finalized',
    home_team: teams[index % 5], away_team: teams[(index + 1) % 5], home_team_id: index % 5 + 1,
    away_team_id: (index + 1) % 5 + 1, home_goals: 1, away_goals: 0, version: 1,
    scheduled_at: null, clock: { period: 'full_time' }, settings: {}, events: [], participations: [],
    shootout: { home: 0, away: 0 },
  }))
  await page.route('**/api/branding/**', (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#087f5b"/></svg>',
  }))
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const cup = { id: 1, name: 'Venoms Internal Cup', edition: 'Test', lifecycle: 'running', version: 2,
      timezone: 'UTC', settings: { players_per_side: 4, half_minutes: 7 }, teams, standings,
      matches: fixtures, leaderboards: {}, unresolved_tie: unresolved, updated_at: '2026-11-13T10:00:00Z' }
    await route.fulfill({ json: path === '/api/cup-auth/session'
      ? { authenticated: true, csrf_token: 'synthetic-only' } : path.endsWith('/history')
        ? { history: [] } : path === '/api/cup' ? { tournaments: [cup] } : { tournament: cup } })
  })
  for (const path of ['/', '/tournaments/1?section=fixtures', '/tournament-host']) {
    await page.goto(path)
    const banner = page.getByRole('status', { name: 'Playoff qualification' })
    if (unresolved) {
      await expect(banner).toContainText('awaiting a tie decision')
      await expect(banner).not.toContainText('Anacondas vs BlackMambas')
    } else {
      await expect(banner).toContainText('Anacondas vs BlackMambas')
      await expect(banner).toContainText('Cobras vs Pythons')
    }
    if (path === '/tournament-host') {
      const createPlayoffs = page.getByRole('button', { name: 'Add final & third-place match' })
      if (unresolved) await expect(createPlayoffs).toBeDisabled()
      else await expect(createPlayoffs).toBeEnabled()
      await expect(page.getByRole('button', { name: 'Finish tournament', exact: true })).toBeDisabled()
    }
    for (const width of [390, 430, 800]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
})
}

const player = {
  id: 1, name: 'Rhea Striker', photo_path: 'players/rhea.jpg', position: 'ST',
  teams: [{ id: 1, name: 'Vipers', logo_path: 'teams/vipers.png' }],
}
const team = { id: 1, name: 'Vipers', logo_path: 'teams/vipers.png', players: [player], captain_player_id: 1 }
const away = { id: 2, name: 'Cobras', logo_path: 'teams/cobras.png', players: [] }
const match = {
  id: 21, tournament_id: 1, stage: 'league', home_team: team, away_team: away,
  home_team_id: 1, away_team_id: 2, match_order: 1, scheduled_at: '2026-11-10T12:00:00+00:00',
  state: 'finalized', version: 3, clock: { period: 'full_time', elapsed_seconds: 60, anchor: null, paused: true }, home_goals: 1, away_goals: 0,
  shootout: { home: 2, away: 1 }, participations: [
    { player, team_id: 1, status: 'starter', goalkeeper: true },
    { player: { ...player, id: 2, name: 'Rhea Sub' }, team_id: 1, status: 'entered', goalkeeper: false },
    { player: { ...player, id: 3, name: 'Cobras Keeper' }, team_id: 2, status: 'starter', goalkeeper: true },
  ],
  events: [{
    id: 1, event_type: 'shot', minute: 12, period: 'first_half', team_id: 1, player_id: 1,
    assist_player_id: null, goalkeeper_id: null, outcome: 'goal', payload: {},
    player, assist: null, goalkeeper: null,
  }, {
    id: 2, event_type: 'shootout', minute: 0, period: 'shootout', team_id: 1, player_id: 1,
    assist_player_id: null, goalkeeper_id: null, outcome: null, payload: { scored: true },
    player, assist: null, goalkeeper: null,
  }, {
    id: 3, event_type: 'substitution', minute: 65, period: 'second_half', team_id: 1, player_id: 1,
    assist_player_id: null, goalkeeper_id: null, outcome: null, payload: { incoming_player_id: 2 },
    player, assist: null, goalkeeper: null,
  }, {
    id: 4, event_type: 'yellow_card', minute: 70, period: 'second_half', team_id: 1, player_id: 1,
    assist_player_id: null, goalkeeper_id: null, outcome: null, payload: { second_yellow_dismissal: true },
    player, assist: null, goalkeeper: null,
  }],
}
const tournament = {
  id: 1, name: 'Venoms Internal Cup', edition: 'Test edition', lifecycle: 'completed',
  timezone: 'Asia/Kolkata', version: 30, settings: { players_per_side: 5 },
  teams: [team, away],
  standings: [
    { id: 1, name: 'Vipers', logo_path: team.logo_path, played: 1, won: 1, drawn: 0, lost: 0, goals_for: 1, goals_against: 0, goal_difference: 1, points: 3, rank: 1 },
    { id: 2, name: 'Cobras', logo_path: away.logo_path, played: 1, won: 0, drawn: 0, lost: 1, goals_for: 0, goals_against: 1, goal_difference: -1, points: 0, rank: 2 },
  ],
  unresolved_tie: null,
  leaderboards: {
    goals: [{ rank: 1, player, team, total: 1, appearances: 1 }],
    assists: [], saves: [],
  },
  matches: [match], updated_at: '2026-11-10T12:12:00+00:00',
}

async function mockPlayoffResults(page: Page) {
  const thirdHome = { ...team, id: 3, name: 'Pythons', players: [] }
  const thirdAway = { ...away, id: 4, name: 'Anacondas' }
  const teams = [team, away, thirdHome, thirdAway, { ...away, id: 5, name: 'BlackMambas' }]
  const league = teams.flatMap((home, index) => teams.slice(index + 1).map((visitor) => ({
    ...match, home_team: home, away_team: visitor, home_team_id: home.id, away_team_id: visitor.id,
    home_goals: 0, away_goals: 0, shootout: { home: 0, away: 0 }, events: [],
  }))).map((fixture, index) => ({ ...fixture, id: index + 1, match_order: index + 1 }))
  type PlayoffMatch = typeof match & {
    shootout_winner_team_id: number | null
    shootout_finish?: { winner_team_id: number; host_decided: boolean } | null
  }
  const final: PlayoffMatch = { ...match, id: 31, match_order: 12, stage: 'final', state: 'review',
    home_goals: 2, away_goals: 1, shootout: { home: 0, away: 0 }, shootout_winner_team_id: null, events: [] }
  const third: PlayoffMatch = { ...match, id: 32, match_order: 11, stage: 'third_place', state: 'scheduled',
    home_team: thirdHome, away_team: thirdAway, home_team_id: 3, away_team_id: 4,
    home_goals: 0, away_goals: 0, shootout: { home: 0, away: 0 }, shootout_winner_team_id: null, events: [] }
  const secondPlayer = { ...player, id: 2, name: 'Noah Finisher' }
  const creator = { ...player, id: 3, name: 'Arun Creator' }
  const leader = { rank: 1, player, team, total: 5, appearances: 5 }
  const cup = { ...tournament, lifecycle: 'running', teams, matches: [...league, third, final],
    standings: teams.map((side, index) => ({ ...tournament.standings[0], ...side, rank: index + 1, played: 4 })),
    leaderboards: {
      ...tournament.leaderboards,
      goals: [{ ...leader, player: creator, rank: 3, total: 2 }, leader, { ...leader, player: secondPlayer }],
      assists: [{ ...leader, total: 3 }, { ...leader, player: creator, total: 3 }, { ...leader, player: secondPlayer, rank: 3, total: 1 }],
    },
  }
  await page.route('**/api/branding/**', (route) => route.fulfill({ status: 404 }))
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    await route.fulfill({ json: path === '/api/cup-auth/session'
      ? { authenticated: true, csrf_token: 'synthetic-only' } : path.endsWith('/history')
        ? { history: [] } : path === '/api/cup' ? { tournaments: [cup] } : { tournament: cup } })
  })
  return { cup, final, third }
}

test('playoff placings follow finalized results, corrections and undo without inventing pending winners', async ({ page }) => {
  test.setTimeout(120_000)
  const { final, third } = await mockPlayoffResults(page)
  await page.goto('/')
  await expect(page.getByRole('status', { name: 'Playoff qualification' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Cup champions' })).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'Playoff results' })).toHaveCount(0)
  third.state = 'finalized'
  third.away_goals = 1
  const podium = page.getByRole('status', { name: 'Playoff results' })
  await expect(podium).toContainText('Anacondas', { timeout: 15_000 })
  await expect(podium).toContainText('Winners and runners-up await a confirmed final result.')
  await expect(page.getByRole('region', { name: 'Cup champions' })).toHaveCount(0)
  final.state = 'finalized'
  const champions = page.getByRole('region', { name: 'Cup champions' })
  await expect(champions.getByRole('heading', { name: 'Vipers', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(podium.locator('p').filter({ has: page.getByText('Runners-up', { exact: true }) })).toContainText('Cobras')
  await expect(podium.locator('p').filter({ has: page.getByText('Third place', { exact: true }) })).toContainText('Anacondas')
  final.away_goals = 3
  await expect(champions.getByRole('heading', { name: 'Cobras', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(podium.locator('p').filter({ has: page.getByText('Runners-up', { exact: true }) })).toContainText('Vipers')
  final.state = 'review'
  await expect(champions).toHaveCount(0, { timeout: 15_000 })
  await expect(podium).toContainText('Winners and runners-up await a confirmed final result.')
  third.state = 'scheduled'
  await expect(podium).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByRole('status', { name: 'Playoff qualification' })).toBeVisible()
})

test('penalty champions, partial podium and shared goal and assist leaders appear on public pages', async ({ page }) => {
  test.setTimeout(120_000)
  const { cup, final, third } = await mockPlayoffResults(page)
  final.state = 'finalized'
  final.home_goals = 1
  final.away_goals = 1
  final.shootout = { home: 3, away: 4 }
  final.shootout_winner_team_id = 2
  for (const path of ['/', '/tournaments/1?section=fixtures', '/tournaments/1?section=leaders']) {
    await page.goto(path)
    const champions = page.getByRole('region', { name: 'Cup champions' })
    await expect(champions.getByRole('heading', { name: 'Cobras', exact: true })).toBeVisible()
    await expect(champions).toContainText('penalties 3–4')
    await expect(champions.getByRole('link', { name: 'Relive the final' })).toHaveAttribute('href', '/matches/31')
    await expect(page.getByRole('status', { name: 'Playoff results' })).toContainText('Awaiting a confirmed third-place result.')
    const leaders = page.getByRole('region', { name: 'Goal and assist leaders' })
    const goals = leaders.getByRole('article', { name: 'Most goals', exact: true })
    const assists = leaders.getByRole('article', { name: 'Most assists', exact: true })
    await expect(goals).toContainText('5 goals')
    await expect(goals).toContainText('Shared lead · 2 players')
    await expect(goals.getByRole('link')).toHaveCount(3)
    await expect(goals.getByRole('link', { name: /Rhea Striker/ })).toHaveAttribute('href', '/players/1')
    await expect(goals.getByRole('link', { name: /Noah Finisher/ })).toHaveAttribute('href', '/players/2')
    await expect(goals.getByRole('link', { name: /Arun Creator/ })).toContainText('2 goals')
    await expect(assists).toContainText('3 assists')
    await expect(assists.getByRole('link')).toHaveCount(3)
    await expect(assists).toContainText('Arun Creator')
    for (const width of [390, 430, 800, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
  final.shootout = { home: 0, away: 0 }
  final.shootout_winner_team_id = 1
  final.shootout_finish = { winner_team_id: 1, host_decided: true }
  third.state = 'finalized'
  third.shootout_winner_team_id = 4
  third.shootout_finish = { winner_team_id: 4, host_decided: true }
  await page.goto('/tournament-host')
  await expect(page.getByRole('status', { name: 'Playoff results' })).toContainText('Vipers')
  await expect(page.getByRole('status', { name: 'Playoff results' })).toContainText('Anacondas')
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Cup champions' })).toContainText('penalties 0–0')
  await expect(page.getByRole('region', { name: 'Cup champions' }).getByRole('heading', { name: 'Vipers' })).toBeVisible()
  cup.leaderboards.goals = [cup.leaderboards.goals[0]]
  cup.leaderboards.assists = []
  await expect(page.getByRole('article', { name: 'Most goals', exact: true })).toContainText('Arun Creator', { timeout: 15_000 })
  await expect(page.getByRole('article', { name: 'Most goals', exact: true }).getByRole('link')).toHaveCount(1)
  await expect(page.getByRole('article', { name: 'Most assists', exact: true })).toContainText('No assists recorded yet.')
  final.shootout_winner_team_id = null
  final.shootout_finish = null
  await expect(page.getByRole('region', { name: 'Cup champions' })).toHaveCount(0, { timeout: 15_000 })
})

test('compact leaders follow full fixtures and the league table, cap three players and retain full Stats', async ({ page }) => {
  const { cup } = await mockPlayoffResults(page)
  const base = cup.leaderboards.goals[1]
  cup.leaderboards.goals = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Omega'].map((name, index) => ({
    ...base, player: { ...player, id: index + 10, name }, total: index < 4 ? 7 : 1,
  }))
  cup.leaderboards.assists = cup.leaderboards.goals.map((row, index) => ({ ...row, total: 5 - index }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const spotlight = page.getByRole('region', { name: 'Goal and assist leaders' })
  await expect(page.locator('.cup-home-fixtures .cup-match-card')).toHaveCount(12)
  const goals = spotlight.getByRole('article', { name: 'Most goals', exact: true })
  await expect(goals.locator('li')).toHaveCount(3)
  await expect(goals.locator('.cup-spotlight-name b')).toHaveText(['Alpha', 'Beta', 'Delta'])
  await expect(goals.locator('.cup-spotlight-total')).toHaveText(['7 goals', '7 goals', '7 goals'])
  await expect(goals).toContainText('Shared lead · 4 players')
  await expect(spotlight.getByRole('article', { name: 'Most assists', exact: true }).locator('.cup-spotlight-total'))
    .toHaveText(['5 assists', '4 assists', '3 assists'])
  expect(await page.evaluate(() => Boolean(document.querySelector('.cup-home-fixtures')!
    .compareDocumentPosition(document.querySelector('.cup-spotlight')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
  await expect(page.locator('.cup-home-fixtures time').first()).toContainText(/AM|PM/)
  for (const width of [390, 430, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.goto('/tournaments/1')
  await expect(spotlight).toBeVisible()
  expect(await page.evaluate(() => Boolean(document.querySelector('.cup-table')!
    .compareDocumentPosition(document.querySelector('.cup-spotlight')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
  await page.goto('/tournaments/1?section=leaders')
  await expect(page.locator('.cup-leaderboard').filter({ has: page.getByRole('heading', { name: 'Top scorers' }) }).locator('li')).toHaveCount(5)
  await expect(page.locator('.cup-leaderboard').filter({ has: page.getByRole('heading', { name: 'Top assists' }) }).locator('li')).toHaveCount(5)
})

test('shootout takers with duplicate names retain distinct selectable identities', async ({ page }) => {
  const second = { ...player, id: 2, position: 'DEF' }
  const side = { ...team, players: [player, second] }
  const shootout = { ...match, home_team: side, state: 'review', home_goals: 0, away_goals: 0,
    clock: { period: 'shootout' }, shootout: { home: 0, away: 0 }, events: [],
    penalty_eligible_player_ids: { 1: [1, 2] } }
  const cup = { ...tournament, lifecycle: 'running', teams: [side, away], matches: [shootout] }
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    await route.fulfill({ json: path === '/api/cup-auth/session'
      ? { authenticated: true, csrf_token: 'synthetic-only' } : path.endsWith('/history')
        ? { history: [] } : path === '/api/cup' ? { tournaments: [cup] } : { tournament: cup } })
  })
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/tournament-host')
  const first = page.getByRole('button', { name: /Rhea Striker.*player #1/ })
  const bench = page.getByRole('button', { name: /Rhea Striker.*player #2/ })
  await expect(first).toBeVisible()
  await expect(bench).toBeVisible()
  await bench.click()
  await expect(bench).toHaveAttribute('aria-pressed', 'true')
  await expect(first).toHaveAttribute('aria-pressed', 'false')
})

test('penalty result cards name the winner without host-ended labels and preserve the actual score', async ({ page }) => {
  let hostDecided = false
  await page.route('**/api/branding/**', (route) => route.fulfill({ status: 404 }))
  await page.route('**/api/cup**', async (route) => {
    const result = { ...match, home_goals: 1, away_goals: 1, shootout_winner_team_id: team.id,
      shootout: hostDecided ? { home: 0, away: 0 } : { home: 4, away: 3 },
      shootout_finish: { host_decided: hostDecided, winner_team_id: team.id },
    }
    const cup = { ...tournament, matches: [result] }
    await route.fulfill({ json: new URL(route.request().url()).pathname === '/api/cup'
      ? { tournaments: [cup] } : { tournament: cup } })
  })
  for (const awarded of [false, true]) {
    hostDecided = awarded
    await page.goto('/')
    const latest = page.locator('.cup-home-latest .cup-match-card')
    await expect(latest.locator('.cup-match-decision')).toHaveText('Vipers win on penalties')
    await expect(latest).not.toContainText(/Host ended|Host award/)
    await expect(latest.locator('.cup-match-score')).toHaveText('1 : 1')
    await expect(latest.locator('.cup-match-pens')).toHaveText(awarded ? 'Pens 0–0' : 'Pens 4–3')
    for (const width of [390, 430, 800]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
})

test('phone and unfolded headers keep every navigation label visible on one line without scrolling', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/cup**', (route) => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({ json: path === '/api/cup-auth/session' ? { authenticated: false }
      : path === '/api/cup' ? { tournaments: [tournament] } : { tournament } })
  })
  await page.setViewportSize({ width: 360, height: 900 })
  await page.goto('/')
  await page.evaluate(() => document.fonts.ready)
  const nav = page.getByRole('navigation', { name: 'Main navigation' })
  await expect(nav.getByRole('link')).toHaveCount(5)
  for (const width of [360, 390, 412, 600, 720, 768, 840, 900, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    const layout = await nav.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return {
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        left: bounds.left, right: bounds.right,
        links: Array.from(element.querySelectorAll('a')).map((link) => {
          const box = link.getBoundingClientRect()
          const text = document.createRange()
          text.selectNodeContents(link)
          const label = text.getBoundingClientRect()
          return {
            label: link.textContent, left: box.left, right: box.right, height: box.height,
            textLeft: label.left, textRight: label.right, textHeight: label.height,
            fontSize: parseFloat(getComputedStyle(link).fontSize),
          }
        }),
      }
    })
    expect(layout.scrollWidth, `Navigation overflow at ${width}px`).toBeLessThanOrEqual(layout.clientWidth)
    expect(layout.left).toBeGreaterThanOrEqual(0)
    expect(layout.right).toBeLessThanOrEqual(width)
    for (const link of layout.links) {
      expect(link.left, `${link.label} starts outside navigation at ${width}px`).toBeGreaterThanOrEqual(layout.left)
      expect(link.right, `${link.label} ends outside navigation at ${width}px`).toBeLessThanOrEqual(layout.right)
      expect(link.textLeft).toBeGreaterThanOrEqual(link.left)
      expect(link.textRight).toBeLessThanOrEqual(link.right)
      expect(link.textHeight, `${link.label} wraps at ${width}px`).toBeLessThanOrEqual(link.fontSize * 1.7)
      expect(link.height).toBeGreaterThanOrEqual(width <= 760 ? 44 : 42)
    }
    await page.locator('.cup-header').screenshot({ path: testInfo.outputPath(`header-${width}.png`) })
  }
})

test('public Internal Cup routes render standings, leaders, profiles and match events on mobile', async ({ page }) => {
  await page.route('**/api/branding/**', async (route) => {
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#087f5b"/></svg>',
    })
  })
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const payload = path === '/api/cup'
      ? { tournaments: [tournament] }
      : path === '/api/cup/1'
        ? { tournament }
        : path === '/api/cup/players'
          ? { players: [player] }
          : path === '/api/cup/players/1'
            ? { player: { ...player, statistics: { appearances: 1, goals: 1, assists: 0, shots: 1, shots_on_target: 1, saves: 0, own_goals: 0, yellow_cards: 0, red_cards: 0, second_yellow_reds: 0 }, matches: [match] } }
            : path === '/api/cup/matches/21'
              ? { match: { ...match, shootout_winner_team_id: team.id } }
              : path === '/api/cup/teams/1'
                ? { team: { ...team, matches: [match] } }
                : { error: 'Unexpected synthetic cup route.' }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) })
  })

  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /One club/i })).toBeVisible()
  await page.goto('/tournaments/1')
  await expect(page.getByRole('heading', { name: 'Venoms Internal Cup', exact: true })).toBeVisible()
  await expect(page).toHaveTitle('Venoms Internal Cup | Venoms FC')
  await expect(page.getByRole('table', { name: 'Internal Cup league standings' })).toContainText('Vipers')
  await expect(page.getByRole('heading', { name: 'Top scorers' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Rhea Striker' }).first()).toHaveAttribute('href', '/players/1')

  await page.goto('/players')
  await page.getByLabel('Search players').fill('Rhea')
  await expect(page.getByRole('link', { name: /Rhea Striker/ })).toBeVisible()
  await page.goto('/players/1')
  await expect(page.getByRole('heading', { name: 'Rhea Striker' })).toBeVisible()
  await expect(page.getByText('Goals', { exact: true })).toBeVisible()
  await expect(page.getByText('Second-yellow dismissals', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Match history' })).toBeVisible()
  await expect(page.locator('.cup-match-card')).toHaveAttribute('href', '/matches/21')

  await page.goto('/matches/21')
  await expect(page).toHaveTitle('Match centre | Venoms FC')
  await expect(page.getByRole('heading', { name: 'Event timeline' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Line-ups & participation' })).toBeVisible()
  await expect(page.getByText('Goalkeeper', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('2 – 1')).toBeVisible()
  await expect(page.getByText('Vipers win on penalties.')).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'first half · goal' }).getByText('Rhea Striker')).toBeVisible()
  await expect(page.getByText('first half · goal')).toBeVisible()
  await expect(page.getByText('Penalty scored')).toBeVisible()
  await expect(page.getByText(/On: Rhea Sub/)).toBeVisible()
  await expect(page.getByText('second half · Second yellow · sent off')).toBeVisible()
  await page.goto('/teams/1')
  await expect(page.getByRole('heading', { name: 'Vipers' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Rhea Striker/ })).toBeVisible()
  expect(await page.locator('.cup-site').evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true)
})

test('resolved tie ranks are displayed as distinct sequential positions', async ({ page }) => {
  const resolvedTournament = {
    ...structuredClone(tournament),
    standings: Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      name: `Tie team ${index + 1}`,
      logo_path: `teams/${index + 1}.png`,
      played: 4, won: 0, drawn: 4, lost: 0, goals_for: 0, goals_against: 0,
      goal_difference: 0, points: 4, rank: index + 1,
    })),
    unresolved_tie: null,
  }
  await page.route('**/api/cup**', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ tournament: resolvedTournament }),
  }))
  await page.goto('/tournaments/1')
  await expect(page.getByRole('table', { name: 'Internal Cup league standings' })).toBeVisible()
  await expect.poll(() => page.locator('.cup-table tbody tr td:first-child').allTextContents())
    .toEqual(['1', '2', '3', '4', '5'])
})

test('level teams get unique alphabetical display positions, outlook stays conditional and leaders navigate', async ({ page }) => {
  const row = (id: number, name: string, points: number, rank: number, played = 2) => ({
    id, name, logo_path: `teams/${id}.png`, played, won: 0, drawn: 0, lost: 0, goals_for: 2, goals_against: 2,
    goal_difference: 0, points, rank,
  })
  const slot = (status: string, secure: number | null, outright: number | null, alive: number | null) =>
    ({ status, secure_points: secure, outright_min_points: outright, alive_min_points: alive })
  const leader = { rank: 1, player, team, total: 3, appearances: 2 }
  const data = {
    ...structuredClone(tournament), lifecycle: 'running',
    // Server order inside an unresolved tie group is not alphabetical; display must not depend on it.
    standings: [row(5, 'Vipers', 6, 1), row(3, 'Mambas', 4, 2), row(4, 'Cobras', 4, 2), row(1, 'Pythons', 2, 4), row(2, 'Anacondas', 1, 5)],
    unresolved_tie: 'Host ranking decision required',
    leaderboards: { goals: [leader], assists: [], saves: [] },
    qualification: null as unknown,
  }
  await page.route('**/api/branding/**', async (route) => route.fulfill({ status: 404 }))
  await page.route('**/api/cup/players/1', async (route) => route.fulfill({ json: { player: {
    ...player, statistics: { appearances: 2, goals: 3, assists: 0, shots: 3, shots_on_target: 3, saves: 0, own_goals: 0, yellow_cards: 0, red_cards: 0, second_yellow_reds: 0 }, matches: [] } } }))
  await page.route('**/api/cup/1', async (route) => route.fulfill({ json: { tournament: data } }))
  await page.goto('/tournaments/1?section=table')
  const table = page.getByRole('table', { name: 'Internal Cup league standings' })
  await expect(table).toBeVisible()
  expect(await table.locator('tbody tr').evaluateAll((rows) => rows.map((tr) =>
    [tr.querySelector('td')!.textContent, tr.querySelector('th a')!.lastChild!.textContent]))).toEqual([
    ['1', 'Vipers'], ['2=', 'Cobras'], ['3=', 'Mambas'], ['4', 'Pythons'], ['5', 'Anacondas']])
  // A tie straddling 2nd/3rd must not be highlighted as a final place by name.
  expect(await table.locator('tbody td.cup-qualify').count()).toBe(1)
  await expect(page.locator('.cup-table-note')).toContainText('listed alphabetically')
  await expect(page.getByRole('heading', { name: 'Qualification scenarios' })).toHaveCount(0)

  data.qualification = { minimum_played: 2, remaining_matches: [{ id: 9, home_team_id: 3, away_team_id: 4 }], teams: [
    { team_id: 3, name: 'Mambas', points: 4, games_left: 1, max_points: 7, best_position: 1, worst_position: 3,
      final: slot('possible', 3, 3, 1), playoff: slot('secured', 0, 0, 0) },
    { team_id: 1, name: 'Pythons', points: 2, games_left: 0, max_points: 2, best_position: 4, worst_position: 4,
      final: slot('eliminated', null, null, null), playoff: slot('tiebreak', null, null, null) },
  ] }
  await page.reload()
  const outlook = page.locator('.cup-outlook')
  await expect(outlook.getByRole('heading', { name: 'Qualification scenarios' })).toBeVisible()
  await expect(outlook).toContainText('Qualification scenarios, not a forecast')
  const mambas = outlook.getByRole('article', { name: 'Mambas qualification scenarios' })
  await expect(mambas).toContainText('Can finish 1st–3rd · 1 left: vs Cobras')
  await expect(mambas.locator('[data-status="possible"]')).toContainText('3 points (e.g. 1 win) from the remaining 1 guarantees it.')
  await expect(mambas.locator('[data-status="secured"]')).toContainText('Secured on points')
  await expect(outlook.getByRole('article', { name: 'Pythons qualification scenarios' }).locator('[data-status="tiebreak"]'))
    .toContainText('Only by finishing level on points')

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/tournaments/1?section=leaders')
    const link = page.locator('.cup-leaderboard').first().getByRole('link', { name: /^Rhea Striker Vipers/ })
    await expect(link).toHaveAttribute('href', '/players/1')
    expect(await link.locator('a').count()).toBe(0)
    const box = await link.boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
    // Click the photo side of the link to confirm the whole row area navigates.
    await link.click({ position: { x: 12, y: box!.height / 2 } })
    await expect(page).toHaveURL(/\/players\/1$/)
    await expect(page.getByRole('heading', { name: 'Rhea Striker' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})

test('tournament navigation shows only the chosen section and restores it with browser history', async ({ page }) => {
  await page.route('**/api/cup/**', async (route) => route.fulfill({ json: { tournament } }))
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/tournaments/1')
  const nav = page.getByRole('navigation', { name: 'Tournament sections' })
  await expect(page.getByRole('heading', { name: 'Team table' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Top scorers' })).toBeVisible()
  await nav.getByRole('link', { name: 'Table' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/section=table/)
  await expect(page.getByRole('heading', { name: 'Team table' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Fixtures & results' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Top scorers' })).toHaveCount(0)
  await nav.getByRole('link', { name: 'Stats' }).click()
  await expect(page.getByRole('heading', { name: 'Top scorers' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Team table' })).toHaveCount(0)
  await page.goBack()
  await expect(nav.getByRole('link', { name: 'Table' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: 'Team table' })).toBeVisible()
  expect(await page.locator('.cup-site').evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true)
})

test('homepage retains completed fixtures over newer drafts while prioritizing published and active cups', async ({ page }) => {
  const completed = { ...structuredClone(tournament), matches: Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(match), id: index + 21, match_order: index + 1,
  })) }
  const draft = { ...structuredClone(tournament), id: 9, name: 'Newer empty draft', lifecycle: 'draft', matches: [] }
  const published = { ...structuredClone(tournament), id: 2, name: 'Published Cup', lifecycle: 'published' }
  const active = { ...structuredClone(tournament), id: 3, name: 'Active Cup', lifecycle: 'running' }
  let rows = [draft, completed]
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const selected = rows.find((row) => row.id === Number(path.split('/').at(-1)))
    return route.fulfill({ json: path === '/api/cup-auth/session' ? { authenticated: false }
      : path === '/api/cup' ? { tournaments: rows } : { tournament: selected } })
  })
  for (const featured of [completed, published, active, { ...active, lifecycle: 'paused' }]) {
    rows = featured.id === completed.id ? [draft, completed]
      : featured.id === published.id ? [draft, completed, published] : [draft, completed, published, featured]
    await page.goto('/')
    await expect(page.locator('.cup-featured-banner')).toHaveAttribute('href', `/tournaments/${featured.id}`)
    await expect(page.locator('.cup-featured-banner')).toContainText(featured.name)
    await expect(page.locator('.cup-home-fixtures .cup-match-card')).toHaveCount(featured.matches.length)
    await expect(page.getByRole('heading', { name: 'Fixtures & results', exact: true })).toBeVisible()
  }
})

test('homepage follows the selected cup lifecycle and shows its squads directly', async ({ page }) => {
  test.setTimeout(180_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/branding/**', async (route) => route.fulfill({ status: 404 }))
  const live = { ...structuredClone(match), id: 22, state: 'live', home_goals: 2, away_goals: 1 }
  const upcoming = { ...structuredClone(match), id: 23, state: 'scheduled', home_goals: 0, away_goals: 0 }
  const laterUpcoming = { ...structuredClone(upcoming), id: 24, scheduled_at: '2026-11-11T12:00:00+00:00' }
  let current = { ...structuredClone(tournament), lifecycle: 'draft', matches: [match, laterUpcoming, upcoming, live] }
  const previous = { ...structuredClone(tournament), id: 2, lifecycle: 'draft' }
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const payload = path === '/api/cup' ? { tournaments: [current, previous] } : { tournament: current }
    await route.fulfill({ json: payload })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Squads' })).toBeVisible({ timeout: 20_000 })
  for (const width of [390, 430, 800, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.getByRole('heading', { name: 'Squads' })).toBeVisible()
    await expect(page.locator('.cup-roster-team')).toHaveCount(2)
    await expect(page.locator('.cup-roster-team').first().getByRole('link', { name: /Rhea Striker/ })).toHaveAttribute('href', '/players/1')
    await expect(page.locator('.cup-roster-team').first().getByText('Captain')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Live now' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Fixtures & results' })).toHaveCount(0)
    await expect(page.locator('.cup-featured')).toBeVisible()
    await expect(page.locator('.cup-featured-banner')).toHaveCount(0)
    await expect(page.locator('.pitch-ball svg path')).toHaveCount(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  current = { ...current, lifecycle: 'published' }
  await page.goto('/home')
  await expect(page.getByRole('heading', { name: 'Squads' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Live now' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Fixtures & results' })).toBeVisible()
  const upNext = page.locator('.cup-home-fixture-group').filter({ has: page.getByRole('heading', { name: /Up next/ }) })
  const resultsGroup = page.locator('.cup-home-fixture-group').filter({ has: page.getByRole('heading', { name: /Results/ }) })
  await expect(upNext.locator('a[href="/matches/23"] .cup-match-score')).toHaveText('vs')
  await expect(upNext.locator('a[href="/matches/23"] .cup-match-center time.cup-match-when')).toHaveAttribute('datetime', upcoming.scheduled_at)
  await expect(upNext.locator('.cup-match-card')).toHaveCount(2)
  expect(await upNext.locator('.cup-match-card').evaluateAll((cards) =>
    cards.map((card) => card.getAttribute('href')))).toEqual(['/matches/23', '/matches/24'])
  await expect(resultsGroup.locator('.cup-match-card')).toHaveCount(1)
  await expect(resultsGroup.locator('.cup-match-score')).toHaveText('1 : 0')
  await expect(page.locator('.cup-featured')).toHaveCount(0)
  await expect(page.locator('.cup-featured-banner')).toHaveAttribute('href', `/tournaments/${tournament.id}`)
  expect(await page.evaluate(() => {
    const hero = document.querySelector('.cup-home-hero')!
    const fixtures = document.querySelector('.cup-home-fixtures')!
    return Boolean(hero.compareDocumentPosition(fixtures) & Node.DOCUMENT_POSITION_FOLLOWING)
  })).toBe(true)
  for (const width of [390, 430, 800, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const clipped = await page.locator('.cup-main').evaluate((main) =>
      Array.from(main.querySelectorAll('a, button')).some((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.left < -1 || bounds.right > window.innerWidth + 1
      }))
    expect(clipped).toBe(false)
    const centred = await upNext.locator('a[href="/matches/23"]').evaluate((card) => {
      const box = card.getBoundingClientRect()
      const score = card.querySelector('.cup-match-score')!.getBoundingClientRect()
      const when = card.querySelector('.cup-match-when')!.getBoundingClientRect()
      const mid = (r: DOMRect) => r.left + r.width / 2
      return { score: Math.abs(mid(score) - mid(box)), when: Math.abs(mid(when) - mid(box)), below: when.top >= score.bottom - 1 }
    })
    expect(centred.score).toBeLessThan(3)
    expect(centred.when).toBeLessThan(3)
    expect(centred.below).toBe(true)
  }
  current = { ...current, lifecycle: 'running' }
  await expect(page.getByRole('heading', { name: 'Live now' })).toBeVisible({ timeout: 25_000 })
  await expect(page.locator('.cup-home-live > .cup-fixtures .cup-match-card')).toHaveAttribute('href', '/matches/22')
  await expect(page.locator('.cup-home-live')).toContainText('2 : 1')
  await expect(upNext).toBeVisible()
  await expect(resultsGroup).toContainText('1 : 0')
  await expect(page.locator('.cup-home-latest .cup-match-card')).toHaveAttribute('href', `/matches/${match.id}`)
  await expect(page.locator('.cup-home-latest')).toContainText('1 : 0')
  for (const width of [390, 430, 800]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole('heading', { name: 'Latest result', exact: true })).toBeVisible()
  }
  for (const state of ['paused', 'review']) {
    current = { ...current, matches: [match, { ...live, state }] }
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Live now' })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.cup-home-live')).toContainText(state === 'paused' ? 'Paused' : 'Result in review')
  }
  current = { ...current, lifecycle: 'completed', matches: [match] }
  await page.goto('/home')
  await expect(page.getByText('No match is live right now.')).toBeVisible({ timeout: 20_000 })
  await expect(resultsGroup).toContainText('1 : 0')
  await expect(upNext).toHaveCount(0)
})

test('squads mark mapped captains and only requested leaderboards are removed', async ({ page }) => {
  const leader = { rank: 1, player, team, total: 3, appearances: 2 }
  const squad = { ...team, players: [
    { ...player, id: 2, name: 'First teammate' }, player,
    { ...player, id: 3, name: 'Second teammate' },
  ] }
  const noCaptain = { ...away, players: [
    { ...player, id: 4, name: 'Unmarked first' },
    { ...player, id: 5, name: 'Unmarked second' },
  ] }
  const data = { ...structuredClone(tournament), teams: [squad, noCaptain], leaderboards: {
    goals: [leader], assists: [], saves: [], shots: [leader],
    shots_on_target: [], appearances: [leader], own_goals: [], yellow_cards: [],
    red_cards: [], second_yellow_reds: [],
  } }
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    await route.fulfill({ json: path === '/api/cup' ? { tournaments: [data] }
      : path === '/api/cup/teams/1' ? { team: squad } : { tournament: data } })
  })
  const expectedOrder = ['Rhea Striker', 'First teammate', 'Second teammate']
  await page.goto('/')
  await expect(page.locator('.cup-roster-team').first().locator('li strong')).toHaveText(expectedOrder)
  await expect(page.locator('.cup-roster-team').nth(1).locator('li strong'))
    .toHaveText(['Unmarked first', 'Unmarked second'])
  await page.goto('/tournaments/1?section=squads')
  await expect(page.locator('.cup-roster-team').first().getByText('Captain')).toBeVisible()
  await expect(page.locator('.cup-roster-team').first().locator('li strong')).toHaveText(expectedOrder)
  await page.goto('/teams/1')
  await expect(page.locator('.cup-player-tile').getByText('Captain')).toBeVisible()
  await expect(page.locator('.cup-player-tile strong')).toHaveText(expectedOrder)
  await page.goto('/tournaments/1?section=leaders')
  for (const title of ['Top scorers', 'Top assists', 'Top saves', 'Shots on target',
    'Own goals', 'Yellow cards', 'Red cards']) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  }
  for (const title of ['Shots', 'Appearances', 'Second-yellow dismissals']) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0)
  }
  await expect(page.getByText('No yellow cards recorded yet.')).toBeVisible()
})

test('pre-match scores and incomplete league ties do not look like played results or host warnings', async ({ page }) => {
  const setupTournament = {
    ...structuredClone(tournament),
    lifecycle: 'published',
    unresolved_tie: 'Host ranking decision required',
    matches: [{ ...structuredClone(match), state: 'scheduled', home_goals: 0, away_goals: 0, events: [], shootout: { home: 0, away: 0 } }],
  }
  await page.route('**/api/cup**', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ tournament: setupTournament }),
  }))
  await page.goto('/tournaments/1')
  await expect(page.getByText('Host ranking decision required')).toHaveCount(0)
  await expect(page.locator('.cup-match-score').first()).toHaveText('vs')
})

test('host explains missing roster data rather than showing empty lineup selectors', async ({ page }) => {
  const missingRoster = { ...team, players: undefined }
  const scheduled = { ...match, state: 'scheduled', home_team: team, away_team: away, participations: [] }
  const data = { ...tournament, lifecycle: 'published', teams: [missingRoster, away], matches: [scheduled] }
  await page.route('**/api/cup**', (route) => {
    const path = new URL(route.request().url()).pathname
    const payload = path === '/api/cup' ? { tournaments: [data] }
      : path === '/api/cup/players' ? { players: [] }
        : path.endsWith('/history') ? { history: [] } : { tournament: data }
    return route.fulfill({ json: payload })
  })
  await page.route('**/api/cup-auth/session', (route) =>
    route.fulfill({ json: { authenticated: true, csrf_token: 'synthetic-token' } }))
  await page.goto('/tournament-host')
  await expect(page.getByText('The match teams or their active rosters could not be loaded. Refresh before editing the lineup.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save starting lineups' })).toBeDisabled()
  await expect(page.locator('.cup-lineup-side')).toHaveCount(0)
})

test('host readiness, touch lineup selection and match kickoff work on a phone viewport', async ({ page }) => {
  const teams = Array.from({ length: 5 }, (_, index) => {
    const players = Array.from({ length: 5 }, (_, playerIndex) => ({
      id: index * 10 + playerIndex + 1,
      name: `Player ${index + 1}-${playerIndex + 1}`,
      photo_path: null,
      position: playerIndex === 0 ? 'GK' : 'ST',
      teams: [],
    }))
    return {
      id: index + 1, name: `Team ${index + 1}`, logo_path: null, players,
      captain_player_id: players[0].id,
    }
  })
  const pairs = [[0, 1], [2, 3], [0, 4], [1, 2], [3, 4], [0, 2], [1, 3], [2, 4], [0, 3], [1, 4]]
  const hostTournament = {
    ...tournament,
    lifecycle: 'published',
    version: 5,
    settings: {
      players_per_side: 4, half_minutes: 10, break_minutes: 5,
      between_match_rest_minutes: 15, playoff_rest_minutes: 60,
    },
    teams,
    matches: pairs.map(([homeIndex, awayIndex], index) => {
      const home = teams[homeIndex]
      const awayTeam = teams[awayIndex]
      return {
        ...match, id: 100 + index, stage: 'league', match_order: index + 1,
        home_team: home, away_team: awayTeam, home_team_id: home.id, away_team_id: awayTeam.id,
        scheduled_at: '2026-11-14T08:00:00+00:00', state: 'scheduled', version: 0,
        clock: { period: null, elapsed_seconds: 0, anchor: null, paused: true },
        home_goals: 0, away_goals: 0, participations: [], events: [],
      }
    }),
    standings: teams.map((row, index) => ({
      id: row.id, name: row.name, logo_path: row.logo_path, played: 0, won: 0,
      drawn: 0, lost: 0, goals_for: 0, goals_against: 0, goal_difference: 0, points: 0, rank: index + 1,
    })),
  }
  let startCalls = 0
  let kickoffCalls = 0
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    if (path === '/api/cup' && method === 'GET') return route.fulfill({ json: { tournaments: [hostTournament] } })
    if (path === '/api/cup/players') return route.fulfill({ json: { players: teams.flatMap((row) => row.players) } })
    if (path === '/api/cup/1' && method === 'GET') return route.fulfill({ json: { tournament: hostTournament } })
    if (path === '/api/cup/host/1/history') return route.fulfill({ json: { history: [] } })
    if (path.startsWith('/api/cup/host/requests/') && method === 'GET') {
      return route.fulfill({ json: {
        request_id: path.split('/').at(-1), status: 'committed',
        resource: '/api/cup/host/1/start', tournament_id: 1,
      } })
    }
    if (path === '/api/cup/host/1/start' && method === 'POST') {
      startCalls += 1
      hostTournament.lifecycle = 'running'
      hostTournament.version += 1
      return route.abort('failed')
    }
    if (path === '/api/cup/host/matches/100/lineup' && method === 'POST') {
      const body = route.request().postDataJSON()
      expect(body.players.filter((row: { status: string }) => row.status === 'starter')).toHaveLength(8)
      expect(body.players.filter((row: { goalkeeper: boolean }) => row.goalkeeper)).toHaveLength(2)
      const selectedMatch = hostTournament.matches[0]
      selectedMatch.participations = body.players.map((row: { player_id: number; team_id: number; status: string; goalkeeper: boolean }) => ({
        ...row, player: teams.flatMap((teamRow) => teamRow.players).find((person) => person.id === row.player_id),
      }))
      selectedMatch.version += 1
      hostTournament.version += 1
      return route.fulfill({ json: { version: hostTournament.version } })
    }
    if (path === '/api/cup/host/matches/100/clock' && method === 'POST') {
      expect(route.request().postDataJSON().command).toBe('kickoff')
      kickoffCalls += 1
      hostTournament.matches[0].state = 'live'
      hostTournament.lifecycle = 'running'
      hostTournament.version += 1
      return route.fulfill({ json: { version: hostTournament.version } })
    }
    return route.fulfill({ status: 404, json: { error: 'Unexpected synthetic cup route.' } })
  })
  await page.route('**/api/cup-auth/session', (route) =>
    route.fulfill({ json: { authenticated: true, csrf_token: 'synthetic-token' } }))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tournament-host')
  await expect(page.getByRole('heading', { name: 'Matchday controls' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start tournament' })).toBeEnabled()
  await expect(page.getByText('Match format saved: 4 per side · 10 min halves · 5 min break')).toBeVisible()
  const matchCard = page.locator('.cup-host-card').filter({ hasText: 'Select any ready league match' })
  const matchPicker = matchCard.locator('select').first()
  await expect(matchPicker).toHaveValue('100')
  for (const sideIndex of [0, 1]) {
    const side = page.locator('.cup-lineup-side').nth(sideIndex)
    for (let index = 0; index < 4; index += 1) {
      await side.getByRole('button', { name: 'Select starter' }).first().click()
    }
    await side.getByRole('button', { name: 'Set as goalkeeper' }).first().click()
  }
  await page.getByRole('button', { name: 'Save starting lineups' }).click()
  await expect(page.locator('.cup-lineup-status')).toContainText('Team 1: 4/4 starters, goalkeeper selected')
  await expect(page.locator('.cup-lineup-status')).toContainText('Team 2: 4/4 starters, goalkeeper selected')
  await expect(page.getByRole('button', { name: 'Kick off', exact: true })).toBeDisabled()
  await expect(page.locator('#cup-kickoff-prerequisite')).toHaveText(/Start the tournament first/)
  await page.getByRole('button', { name: 'Start tournament' }).click()
  await expect.poll(() => startCalls).toBe(1)
  await expect(page.locator('.cup-host-notice').first()).toContainText('was confirmed in host history')
  await expect(page.locator('#cup-kickoff-prerequisite')).toHaveCount(0)
  await page.getByRole('button', { name: 'Kick off', exact: true }).click()
  await expect.poll(() => kickoffCalls).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('authenticated host desk edits cup roster and submits a reviewed fixture order', async ({ page }) => {
  test.setTimeout(60_000)
  const teams = Array.from({ length: 5 }, (_, index) => {
    const id = index + 1
    const roster = [index * 2, index * 2 + 1].map((playerIndex) => ({
      id: playerIndex + 1, name: `Player ${playerIndex + 1}`,
      photo_path: `/api/media/player-${playerIndex + 1}.jpg`, position: playerIndex % 2 ? 'ST' : 'GK',
      teams: [],
    }))
    return {
      id, name: `Team ${id}`, logo_path: `/api/branding/team-${id}.jpg`,
      players: roster,
      roster: [], budget: 1000, spent: 0, remaining_slots: null, max_bid: 1000,
    }
  })
  const liveAnchor = new Date().toISOString()
  const fixtures = [['A', 'B'], ['C', 'D'], ['A', 'E'], ['B', 'C'], ['D', 'E'],
    ['A', 'C'], ['B', 'D'], ['C', 'E'], ['A', 'D'], ['B', 'E']]
  const matches = fixtures.map(([home, away], index) => {
    const homeTeam = teams[home.charCodeAt(0) - 65]
    const awayTeam = teams[away.charCodeAt(0) - 65]
    return {
      id: 100 + index, tournament_id: 1, stage: 'league', home_team: homeTeam, away_team: awayTeam,
      home_team_id: homeTeam.id, away_team_id: awayTeam.id, match_order: index + 1,
      scheduled_at: '2026-11-10T12:00:00+00:00', state: index === 0 ? 'live' : index === 4 ? 'finalized' : 'scheduled', version: 0,
      clock: {
        period: index === 0 ? 'first_half' : null, elapsed_seconds: 0,
        anchor: index === 0 ? liveAnchor : null, paused: index !== 0,
      },
      home_goals: 0, away_goals: 0, shootout: { home: 0, away: 0 },
      participations: index === 0 || index === 9 ? [
        { player: homeTeam.players[0], team_id: homeTeam.id, status: 'starter', goalkeeper: true },
        { player: homeTeam.players[1], team_id: homeTeam.id, status: 'entered', goalkeeper: false },
        { player: awayTeam.players[0], team_id: awayTeam.id, status: 'starter', goalkeeper: true },
        { player: awayTeam.players[1], team_id: awayTeam.id, status: 'entered', goalkeeper: false },
      ] : [],
      events: [],
    }
  })
  const standings = teams.map((row, index) => ({
    id: row.id, name: row.name, logo_path: row.logo_path, played: 0, won: 0, drawn: 0, lost: 0,
    goals_for: 0, goals_against: 0, goal_difference: 0, points: 0, rank: index + 1,
  }))
  const hostTournament = {
    ...tournament, lifecycle: 'draft', version: 12, teams, matches, standings,
    leaderboards: { goals: [], assists: [], saves: [] },
    settings: {
      players_per_side: 1, half_minutes: 10, break_minutes: 5,
      between_match_rest_minutes: 15, playoff_rest_minutes: 60,
    },
  }
  const cupPlayers = teams.flatMap((row) => row.players)
  let sendChangedServerTournament = false
  let refreshedAfterDraftEdit = false
  let matchday = false
  let savedOrder: number[] = []
  let kickedOff = false
  await page.route('**/api/branding/**', async (route) => {
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#087f5b"/></svg>',
    })
  })
  await page.route('**/api/auction/host-state', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      version: 1, status: 'completed', squad_size: 5, open_set: null,
      teams, players: [], current: null, last_event: null, can_undo: false,
    }),
  }))
  await page.route('**/api/auction/history', async (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ events: [] }),
  }))
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === 'POST' && path === '/api/cup/host/1/rosters') {
      const body = route.request().postDataJSON()
      expect(body.player_id).toBe(cupPlayers[0].id)
      expect(body.team_id).toBe(teams[1].id)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 13 }) })
    } else if (route.request().method() === 'POST' && path === '/api/cup/host/matches/100/goalkeeper') {
      expect(route.request().postDataJSON()).toMatchObject({
        team_id: teams[0].id, player_id: teams[0].players[1].id,
      })
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 13 }) })
    } else if (route.request().method() === 'POST' && path === '/api/cup/host/1/settings') {
      expect(route.request().postDataJSON().settings.break_minutes).toBe(7)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 13 }) })
    } else if (route.request().method() === 'POST' && path === '/api/cup/host/1/fixtures/reorder') {
      const body = route.request().postDataJSON()
      expect(body.match_ids).toHaveLength(10)
      expect(new Set(body.match_ids).size).toBe(10)
      savedOrder = body.match_ids
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 14 }) })
    } else if (route.request().method() === 'POST' && path === '/api/cup/host/matches/109/clock') {
      expect(route.request().postDataJSON().command).toBe('kickoff')
      kickedOff = true
      await route.fulfill({ json: { version: 15 } })
    } else if (path === '/api/cup') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tournaments: [hostTournament] }) })
    } else if (path === '/api/cup/1') {
      const current = structuredClone(hostTournament)
      if (matchday) current.lifecycle = 'running'
      if (sendChangedServerTournament) {
        refreshedAfterDraftEdit = true
        current.version += 1
        current.settings.break_minutes = 11
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tournament: current }) })
    } else if (path === '/api/cup/players') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ players: cupPlayers }) })
    } else if (path === '/api/cup/host/1/history') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ history: [] }) })
    } else {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected synthetic cup route.' }) })
    }
  })

  await page.route('**/api/cup-auth/session', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, csrf_token: 'synthetic-csrf-token' }),
  }))
  await page.goto('/tournament-host')
  await expect(page.getByRole('heading', { name: 'Cup matchday desk' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Matchday controls' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Manage cup rosters' })).toHaveCount(0)
  for (const width of [390, 430, 800, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await page.locator('.cup-host-desk button').first().evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
    const clipped = await page.locator('.cup-host-desk').evaluate((desk) => {
      const bounds = desk.getBoundingClientRect()
      return Array.from(desk.querySelectorAll('button, input, select')).some((element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
      })
    })
    expect(clipped).toBe(false)
  }
  await expect(page.getByRole('timer')).toContainText('first half')
  await expect(page.getByRole('button', { name: 'End first half' })).toBeEnabled()
  await page.getByRole('button', { name: 'Squad & settings' }).click()
  await expect(page.getByRole('heading', { name: 'Manage cup rosters' })).toBeVisible()
  const firstPendingTime = new Date(matches[1].scheduled_at)
  firstPendingTime.setMinutes(firstPendingTime.getMinutes() - firstPendingTime.getTimezoneOffset())
  const firstPendingHour = Number(firstPendingTime.toISOString().slice(11, 13))
  await page.getByRole('button', { name: 'Fixtures' }).click()
  await expect(page.getByLabel('First kickoff date', { exact: true })).toHaveValue(firstPendingTime.toISOString().slice(0, 10))
  await expect(page.getByLabel('First kickoff hour', { exact: true })).toHaveValue(String(firstPendingHour % 12 || 12))
  await expect(page.getByLabel('First kickoff AM/PM', { exact: true })).toHaveValue(firstPendingHour >= 12 ? 'PM' : 'AM')
  await page.getByRole('button', { name: 'Squad & settings' }).click()
  await page.getByLabel('Half-time break (minutes)').fill('7')
  await page.getByRole('button', { name: 'Fixtures' }).click()
  await expect(page.getByRole('button', { name: 'Move match 2 up' })).toBeDisabled()
  await page.getByRole('button', { name: 'Move match 4 up' }).click()
  const locallyReorderedFixture = await page.locator('.cup-fixture-order-row').nth(2).innerText()
  sendChangedServerTournament = true
  await expect.poll(() => refreshedAfterDraftEdit, { timeout: 12_000 }).toBe(true)
  await expect.poll(() => page.locator('.cup-fixture-order-row').nth(2).innerText())
    .toBe(locallyReorderedFixture)
  await page.getByRole('button', { name: 'Squad & settings' }).click()
  await expect(page.getByLabel('Half-time break (minutes)')).toHaveValue('7')
  await page.getByRole('button', { name: 'Save match format' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'saved. It is recorded in host history' })).toBeVisible()
  matchday = true
  await page.getByRole('button', { name: 'Fixtures' }).click()
  await expect(page.getByLabel('First pending kickoff date', { exact: true })).toBeVisible({ timeout: 12_000 })
  await page.getByRole('button', { name: 'Move match 6 up' }).click()
  await page.getByRole('button', { name: 'Squad & settings' }).click()
  await page.getByLabel('Cup roster player').selectOption(String(cupPlayers[0].id))
  await page.getByLabel('Cup roster team').selectOption(String(teams[1].id))
  await page.getByRole('button', { name: 'Save roster change' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'saved. It is recorded in host history' })).toBeVisible()
  await page.getByRole('button', { name: 'Match desk' }).click()
  await page.getByLabel('Goalkeeper team').selectOption(String(teams[0].id))
  await page.getByLabel('Active goalkeeper').selectOption(String(teams[0].players[1].id))
  await page.getByRole('button', { name: 'Save goalkeeper' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'saved. It is recorded in host history' })).toBeVisible()

  await page.getByRole('button', { name: 'Fixtures' }).click()
  await page.getByRole('button', { name: 'Save reviewed order & schedule' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'saved. It is recorded in host history' })).toBeVisible()
  expect(savedOrder.slice(3, 6)).toEqual([105, 104, 102])
  await page.getByRole('button', { name: 'Match desk' }).click()
  await expect(page.getByText('Match 1 is on the pitch. Other fixtures unlock after it is finalized.')).toBeVisible()
  await expect(page.locator('.cup-host-card').filter({ hasText: 'Select any ready league match' })).toHaveCount(0)
  matches[0].state = 'finalized'
  matches[0].clock = { period: 'full_time', elapsed_seconds: 1200, anchor: null, paused: true }
  await page.locator('.cup-host-card').filter({ hasText: 'Select any ready league match' })
    .locator('select').first().selectOption('109', { timeout: 15_000 })
  await page.getByRole('button', { name: 'Kick off', exact: true }).click()
  await expect.poll(() => kickedOff).toBe(true)
})

function draftFixtureGenerationData() {
  const players = Array.from({ length: 28 }, (_, index) => ({
    ...player, id: index + 1, name: `Synthetic Player ${index + 1}`, teams: [],
  }))
  const teams = Array.from({ length: 5 }, (_, index) => ({
    ...team, id: index + 1, name: `Synthetic Team ${index + 1}`,
    players: players.filter((person) => person.id <= 26 && (person.id - 1) % 5 === index),
  }))
  const matches: (Omit<typeof match, 'clock'> & { clock: Partial<typeof match.clock> })[] = []
  const data = {
    ...tournament, lifecycle: 'draft', version: 1, teams, matches,
    settings: { players_per_side: 4, half_minutes: 10, break_minutes: 5,
      between_match_rest_minutes: 15, playoff_rest_minutes: 60 },
    standings: teams.map((side) => ({ ...tournament.standings[0], ...side, played: 0, points: 0 })),
  }
  return { data, players }
}

test('hosts publish complete fixtures before start and Tournament navigation opens the active cup', async ({ page }) => {
  const { data, players } = draftFixtureGenerationData()
  const posts: string[] = []
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/cup-auth/session') return route.fulfill({ json: { authenticated: true, csrf_token: 'synthetic-only' } })
    if (route.request().method() === 'POST') {
      posts.push(path)
      data.version += 1
      if (path.endsWith('/fixtures')) {
        data.matches = Array.from({ length: 10 }, (_, index) => ({
          ...match, id: index + 1, match_order: index + 1, state: 'draft', clock: {},
          scheduled_at: new Date(Date.UTC(2026, 10, 14, 14, 30) + index * 25 * 60_000).toISOString(),
        }))
      } else if (path.endsWith('/publish')) {
        data.lifecycle = 'published'
        data.matches.forEach((fixture) => { fixture.state = 'scheduled' })
      }
      return route.fulfill({ json: { tournament_id: 1, version: data.version } })
    }
    return route.fulfill({ json: path === '/api/cup' ? { tournaments: [data] }
      : path === '/api/cup/players' ? { players }
        : path.endsWith('/history') ? { history: [] } : { tournament: data } })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tournament-host')
  await page.getByRole('button', { name: 'Fixtures', exact: true }).click()
  await page.getByLabel('First kickoff hour', { exact: true }).selectOption('12')
  await page.getByLabel('First kickoff minute', { exact: true }).selectOption('30')
  await page.getByLabel('First kickoff AM/PM', { exact: true }).selectOption('AM')
  await page.getByRole('button', { name: 'Generate fixtures', exact: true }).click()
  await expect(page.locator('.cup-fixture-order-row')).toHaveCount(10)
  await expect(page.getByRole('button', { name: 'Start tournament', exact: true })).toHaveCount(0)
  await expect(page.getByText('Prepare, review and publish fixtures before matchday.', { exact: false })).toBeVisible()
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('does not start the tournament')
    await dialog.accept()
  })
  await page.getByRole('button', { name: 'Publish reviewed fixtures', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Fixtures are public.' })).toBeVisible()
  expect(posts).toEqual(['/api/cup/host/1/fixtures', '/api/cup/host/1/publish'])
  expect(data.lifecycle).toBe('published')
  await page.goto('/')
  await expect(page.locator('.cup-home-fixtures .cup-match-card')).toHaveCount(10)
  await expect(page.getByRole('heading', { name: 'Live now', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Tournament', exact: true }).click()
  await expect(page).toHaveURL(/\/tournaments$/)
  data.lifecycle = 'running'
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Tournament', exact: true }).click()
  await expect(page).toHaveURL(/\/tournaments\/1$/)
  data.lifecycle = 'paused'
  await page.goto('/players')
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Tournament', exact: true }).click()
  await expect(page).toHaveURL(/\/tournaments\/1$/)
  expect(posts).toHaveLength(2)
})

test('only authenticated hosts can remove and recover a tournament, with safe uncertain-write handling', async ({ page }) => {
  const { data } = draftFixtureGenerationData()
  data.matches.push(structuredClone(match))
  let authenticated = false
  let activeMatch: number | null = 1
  let privateReads = 0
  let loseReceipt = false
  const posts: { path: string; body: Record<string, unknown> }[] = []
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/cup-auth/session') return route.fulfill({ json: { authenticated, csrf_token: 'synthetic-only' } })
    if (path.startsWith('/api/cup/host/requests/')) return route.fulfill({ json: {
      request_id: path.split('/').at(-1), status: 'committed', resource: '/api/cup/host/1/archive', tournament_id: 1,
    } })
    if (path === '/api/cup/players') return route.fulfill({ json: { players: [] } })
    if (path.endsWith('/history')) return route.fulfill({ json: { history: [] } })
    if (path.endsWith('/removal')) {
      privateReads += 1
      return route.fulfill({ json: { tournament: { ...data, active_match_id: activeMatch,
        archive_audit_id: data.lifecycle === 'archived' ? 101 : null } } })
    }
    if (path.endsWith('/undo-preview')) return route.fulfill({ json: {
      target: { id: 101, action: 'tournament_archive' }, affected: [], expected_version: data.version,
    } })
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON()
      posts.push({ path, body })
      expect(body.expected_version).toBe(data.version)
      data.version += 1
      data.lifecycle = path.endsWith('/archive') ? 'archived' : 'draft'
      if (loseReceipt) return route.abort('failed')
      return route.fulfill({ json: { tournament_id: 1, version: data.version } })
    }
    if (path === '/api/cup/host/archived-tournaments') return route.fulfill({ json: {
      tournaments: data.lifecycle === 'archived' ? [data] : [],
    } })
    if (path === '/api/cup/1' && data.lifecycle === 'archived') return route.fulfill({ status: 404, json: { error: 'Tournament not found.' } })
    return route.fulfill({ json: path === '/api/cup' ? { tournaments: data.lifecycle === 'archived' ? [] : [data] } : { tournament: data } })
  })
  await page.clock.install({ time: new Date('2026-11-14T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-14T00:00:01Z'))
  await page.goto('/tournaments/1')
  await expect(page.getByRole('heading', { name: data.name, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove tournament', exact: true })).toHaveCount(0)
  expect(privateReads).toBe(0)
  authenticated = true
  await page.reload()
  const management = page.getByRole('region', { name: 'Host tournament management' })
  const remove = management.getByRole('button', { name: 'Remove tournament', exact: true })
  await expect(remove).toBeDisabled()
  await expect(management).toContainText('Match 1 is active or under review')
  activeMatch = null
  await page.reload()
  await expect(remove).toBeEnabled()
  await expect(page.locator('.cup-fixtures .cup-match-card')).toHaveCount(1)
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('retained, not deleted')
    await dialog.accept()
  })
  await remove.click()
  await expect(management.getByRole('status')).toContainText('All records are retained for recovery')
  await expect(page.getByRole('heading', { name: data.name, exact: true })).toHaveCount(0)
  await expect(page.locator('.cup-fixtures .cup-match-card')).toHaveCount(0)
  await expect(page.locator('.cup-main > [role="alert"]')).toContainText('Tournament not found.')
  await expect(management.getByRole('button', { name: 'Restore tournament', exact: true })).toBeEnabled()
  await management.getByText('Removed tournaments · recovery', { exact: true }).click()
  await expect(management.getByRole('link', { name: /#1/ })).toHaveAttribute('href', '/tournaments/1')
  page.once('dialog', (dialog) => dialog.accept())
  await management.getByRole('button', { name: 'Restore tournament', exact: true }).click()
  await expect(management.getByRole('status')).toContainText('Tournament restored.')
  await expect(page.getByRole('heading', { name: data.name, exact: true })).toBeVisible()
  await expect(page.locator('.cup-fixtures .cup-match-card')).toHaveCount(1)
  await expect(page.locator('.cup-main > [role="alert"]')).toHaveCount(0)
  await expect(page).toHaveURL(/\/tournaments\/1$/)
  await expect(remove).toBeEnabled()
  expect(posts.map((row) => row.path)).toEqual(['/api/cup/host/1/archive', '/api/cup/host/1/undo'])
  expect(posts[1].body).toMatchObject({ target_audit_id: 101, cascade: false })
  expect(await page.evaluate(() => sessionStorage.getItem('venomsfc.internal-cup.pending-command.v1'))).toBeNull()
  loseReceipt = true
  page.once('dialog', (dialog) => dialog.accept())
  await remove.click()
  await expect(management.getByRole('alert')).toContainText('Do not repeat this request')
  await expect(management.getByRole('link', { name: 'Open host desk' })).toBeVisible()
  expect(posts).toHaveLength(3)
  const pending = await page.evaluate(() => JSON.parse(sessionStorage.getItem('venomsfc.internal-cup.pending-command.v1')!))
  expect(pending.resource).toBe('/api/cup/host/1/archive')
  await management.getByRole('link', { name: 'Open host desk' }).click()
  await expect(page.getByRole('button', { name: 'Create Internal Cup', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => sessionStorage.getItem('venomsfc.internal-cup.pending-command.v1'))).toBeNull()
  expect(posts).toHaveLength(3)
})

test('tournament polling clears definite not-found details and recovers without hiding real refresh errors', async ({ page }) => {
  let responseStatus = 200
  await page.route('**/api/cup**', (route) => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({ status: path === '/api/cup/1' ? responseStatus : 200,
      json: path === '/api/cup-auth/session' ? { authenticated: false }
        : responseStatus === 404 ? { error: 'Tournament not found.' }
          : responseStatus === 503 ? { error: 'Tournament refresh temporarily unavailable.' } : { tournament } })
  })
  await page.clock.install({ time: new Date('2026-11-14T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-14T00:00:01Z'))
  await page.goto('/tournaments/1')
  const heading = page.getByRole('heading', { name: tournament.name, exact: true })
  const alert = page.locator('.cup-main > [role="alert"]')
  await expect(heading).toBeVisible()
  responseStatus = 503
  await page.clock.runFor(5000)
  await expect(alert).toContainText('Tournament refresh temporarily unavailable.')
  await expect(heading).toBeVisible()
  responseStatus = 404
  await page.clock.runFor(5000)
  await expect(alert).toContainText('Tournament not found.')
  await expect(heading).toHaveCount(0)
  await expect(page.locator('.cup-fixtures .cup-match-card')).toHaveCount(0)
  responseStatus = 200
  await page.clock.runFor(5000)
  await expect(heading).toBeVisible()
  await expect(alert).toHaveCount(0)
})

test.describe('touch-friendly host inputs', () => {
  test.use({ hasTouch: true })
  test('opened selectors are dark and support touch, keyboard and a clearly labeled historical-event checkbox', async ({ page }) => {
    const { data } = activeMatchFixture()
    await page.route('**/api/cup**', (route) => {
      const path = new URL(route.request().url()).pathname
      return route.fulfill({ json: path === '/api/cup-auth/session' ? { authenticated: true, csrf_token: 'synthetic-only' }
        : path === '/api/cup' ? { tournaments: [data] } : path.endsWith('/history') ? { history: [] }
          : path === '/api/cup/players' ? { players: [] } : { tournament: data } })
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/tournament-host')
    const form = page.locator('.cup-event-form').filter({ has: page.getByRole('heading', { name: /Record a match event/ }) })
    const historical = form.getByRole('checkbox', { name: /Add an omitted earlier event/ })
    await expect(historical).toHaveAccessibleDescription('Choose the played period and minute instead of using the live clock.')
    const bounds = await historical.boundingBox()
    expect(bounds?.width).toBe(22)
    expect(bounds?.height).toBe(22)
    await historical.check()
    await expect(form.getByLabel('Minute', { exact: true })).toBeVisible()
    const side = form.getByRole('combobox', { name: 'Team', exact: true })
    await side.tap()
    const popup = page.getByRole('listbox')
    await expect(popup).toBeVisible()
    await expect(popup).toHaveCSS('background-color', 'rgb(17, 42, 62)')
    expect(await popup.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
    })).toBe(true)
    await popup.getByRole('option', { name: 'Vipers', exact: true }).tap()
    await expect(side).toHaveValue('1')
    await expect(popup).toHaveCount(0)
    const event = form.getByRole('combobox', { name: 'Event', exact: true })
    await event.focus()
    await event.press('ArrowDown')
    await expect(popup).toBeVisible()
    await event.press('End')
    await event.press('Enter')
    await expect(event).toHaveValue('red_card')
    await expect(popup).toHaveCount(0)
    await event.press('ArrowUp')
    await event.press('Escape')
    await expect(event).toBeFocused()
    await expect(popup).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})

test('fixture save survives a follow-up read timeout and never generates a second set', async ({ page }) => {
  test.setTimeout(45_000)
  const { data, players } = draftFixtureGenerationData()
  let fixturePosts = 0
  let detailReads = 0
  let holdDetails = false
  let releaseDetails: (() => void) | undefined
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/cup-auth/session') {
      return route.fulfill({ json: { authenticated: true, csrf_token: 'synthetic-only' } })
    }
    if (path === '/api/cup/host/1/fixtures' && route.request().method() === 'POST') {
      fixturePosts += 1
      data.version = 2
      data.matches.push(...Array.from({ length: 10 }, (_, index) => ({
        ...match, id: index + 1, match_order: index + 1, state: 'draft',
      })))
      holdDetails = true
      return route.fulfill({ json: { tournament_id: 1, version: 2 } })
    }
    if (path === '/api/cup/1') {
      detailReads += 1
      if (holdDetails) await new Promise<void>((resolve) => { releaseDetails = resolve })
      return route.fulfill({ json: { tournament: data } })
    }
    return route.fulfill({ json: path === '/api/cup' ? { tournaments: [data] }
      : path === '/api/cup/players' ? { players } : { history: [] } })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tournament-host')
  await page.getByRole('button', { name: 'Fixtures', exact: true }).click()
  const generate = page.getByRole('button', { name: 'Generate fixtures', exact: true })
  await expect(generate).toBeEnabled()
  expect(detailReads).toBe(1)
  await generate.click()
  await expect(page.locator('.cup-host-notice').first()).toContainText('Fixtures were created and saved.')
  await expect(page.locator('.cup-host-select select')).toBeDisabled()
  const readFailure = page.getByRole('alert').filter({ hasText: 'The latest Cup state could not be loaded.' })
  await expect(readFailure).toContainText('The server did not respond in time.', { timeout: 12_000 })
  await expect(page.locator('.cup-host-notice').first()).toContainText('Fixtures were created and saved.')
  await expect(generate).toBeDisabled()
  await expect(page.getByText('The write outcome is unconfirmed', { exact: false })).toHaveCount(0)
  expect(fixturePosts).toBe(1)
  expect(await page.evaluate(() => sessionStorage.getItem('venomsfc.internal-cup.pending-command.v1'))).toBeNull()
  holdDetails = false
  releaseDetails?.()
  await readFailure.getByRole('button', { name: 'Refresh desk' }).click()
  await expect(readFailure).toHaveCount(0)
  await expect(page.locator('.cup-host-select select')).toBeEnabled()
  await expect(page.getByRole('status').filter({ hasText: 'Fixtures already exist for this tournament.' })).toBeVisible()
  await expect(generate).toBeDisabled()
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'Fixtures already exist for this tournament.' })).toBeVisible()
  await expect(generate).toBeDisabled()
  expect(fixturePosts).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('fixture rejection keeps the real server reason at the top even if the refresh fails', async ({ page }) => {
  const { data, players } = draftFixtureGenerationData()
  let fixturePosts = 0
  let cancellations = 0
  await page.route('**/api/cup**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/cup-auth/session') {
      return route.fulfill({ json: { authenticated: true, csrf_token: 'synthetic-only' } })
    }
    if (path === '/api/cup/host/1/fixtures' && route.request().method() === 'POST') {
      fixturePosts += 1
      return route.fulfill({ status: 409, json: { error: 'Fixtures already exist. Review the saved schedule.' } })
    }
    if (path.startsWith('/api/cup/host/requests/')) {
      if (path.endsWith('/cancel')) {
        cancellations += 1
        return route.fulfill({ json: { status: 'cancelled', tournament_id: 1 } })
      }
      return route.fulfill({ json: { status: 'not_committed' } })
    }
    if (fixturePosts && path === '/api/cup') return route.abort('failed')
    return route.fulfill({ json: path === '/api/cup' ? { tournaments: [data] }
      : path === '/api/cup/players' ? { players }
        : path.endsWith('/history') ? { history: [] } : { tournament: data } })
  })
  await page.goto('/tournament-host')
  await page.getByRole('button', { name: 'Fixtures', exact: true }).click()
  const generate = page.getByRole('button', { name: 'Generate fixtures', exact: true })
  await expect(generate).toBeEnabled()
  await generate.click()
  await expect(page.getByRole('alert').filter({ hasText: 'Nothing was saved' }))
    .toContainText('Fixtures already exist. Review the saved schedule.')
  await expect(page.getByRole('alert').filter({ hasText: 'The latest Cup state could not be loaded.' })).toBeVisible()
  await expect(generate).toBeDisabled()
  expect(fixturePosts).toBe(1)
  expect(cancellations).toBe(1)
})

test('host recovers clearly when the server cannot cancel an unconfirmed request', async ({ page }) => {
  const scheduled = { ...match, state: 'scheduled', home_team: team, away_team: away, participations: [] }
  const data = { ...tournament, lifecycle: 'draft', teams: [team, away], matches: [scheduled] }
  let cancelAvailable = false
  let cancelCalls = 0
  let rejectedCalls = 0
  await page.route('**/api/cup**', (route) => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    if (path.startsWith('/api/cup/host/requests/') && path.endsWith('/cancel')) {
      cancelCalls += 1
      if (!cancelAvailable) return route.fulfill({ status: 405, json: { error: 'Method not allowed.' } })
      return route.fulfill({ json: { request_id: 'stuck-request', status: 'cancelled', resource: '/api/cup/host/matches/1/clock', tournament_id: 1 } })
    }
    if (path.startsWith('/api/cup/host/requests/')) {
      return route.fulfill({ json: { request_id: path.split('/').at(-1), status: 'not_committed' } })
    }
    if (path === '/api/cup/host/1/settings' && method === 'POST') {
      rejectedCalls += 1
      return route.fulfill({ status: 409, json: { error: 'Synthetic server rejection reason.' } })
    }
    const payload = path === '/api/cup' ? { tournaments: [data] }
      : path === '/api/cup/players' ? { players: [] }
        : path.endsWith('/history') ? { history: [] } : { tournament: data }
    return route.fulfill({ json: payload })
  })
  await page.route('**/api/cup-auth/session', (route) =>
    route.fulfill({ json: { authenticated: true, csrf_token: 'synthetic-token' } }))
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem('synthetic-seeded')) return
    window.sessionStorage.setItem('synthetic-seeded', '1')
    window.sessionStorage.setItem('venomsfc.internal-cup.pending-command.v1', JSON.stringify({
      request_id: 'stuck-request', resource: '/api/cup/host/matches/1/clock', tournament_id: 1,
      body: { command: 'kickoff', request_id: 'stuck-request' },
    }))
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tournament-host')
  const alert = page.locator('.cup-alert[role="alert"]')
  await expect(alert).toContainText('cannot cancel unconfirmed requests (HTTP 405)')
  await expect(alert).toContainText('restart the Cup server')
  await expect(page.getByRole('button', { name: 'Kick off', exact: true })).toBeDisabled()

  cancelAvailable = true
  await alert.getByRole('button', { name: 'Check again' }).click()
  await expect(page.locator('.cup-host-notice').first()).toContainText('was safely cancelled')
  expect(await page.evaluate(() => window.sessionStorage.getItem('venomsfc.internal-cup.pending-command.v1'))).toBeNull()
  await expect(page.getByRole('button', { name: 'Kick off', exact: true })).toBeDisabled()
  await expect(page.locator('#cup-kickoff-prerequisite')).toHaveText(/Start the tournament first/)
  expect(rejectedCalls).toBe(0)
  expect(cancelCalls).toBeGreaterThanOrEqual(2)

  cancelAvailable = false
  await page.getByRole('button', { name: /Squad & settings/i }).click()
  await page.getByRole('button', { name: 'Save match format' }).click()
  await expect.poll(() => rejectedCalls).toBe(1)
  await expect(alert).toContainText('Synthetic server rejection reason. Nothing was saved')
  await expect(alert.getByRole('button', { name: 'Check again' })).toHaveCount(0)
  expect(await page.evaluate(() => window.sessionStorage.getItem('venomsfc.internal-cup.pending-command.v1'))).toBeNull()
  await expect(page.getByRole('button', { name: 'Save match format' })).toBeEnabled()
})

function activeMatchFixture() {
  const person = (id: number, name: string, position = 'ST') => ({ id, name, photo_path: null, position, teams: [] })
  const vipersKeeper = person(1, 'Rhea Striker', 'GK')
  const vipersOutfield = person(2, 'Mia Winger')
  const vipersBench = person(4, 'Cara Bench')
  const vipersReturn = person(5, 'Dan Back')
  const cobrasKeeper = person(3, 'Cobras Keeper', 'GK')
  const cobrasOutfield = person(6, 'Leo Cobra')
  const home = { id: 1, name: 'Vipers', logo_path: null, players: [vipersKeeper, vipersOutfield, vipersBench, vipersReturn], captain_player_id: 1 }
  const visitor = { id: 2, name: 'Cobras', logo_path: null, players: [cobrasKeeper, cobrasOutfield], captain_player_id: 3 }
  const event = (id: number, type: string, minute: number, teamId: number, who: ReturnType<typeof person>, extra: Record<string, unknown> = {}) => ({
    id, event_type: type, minute, period: 'first_half', team_id: teamId, player_id: who.id,
    assist_player_id: null, goalkeeper_id: null, outcome: null, payload: {}, voided: false,
    player: who, assist: null, goalkeeper: null, ...extra,
  })
  const live = {
    ...match, id: 41, stage: 'league', match_order: 1, home_team: home, away_team: visitor,
    home_team_id: 1, away_team_id: 2, state: 'paused', version: 6,
    clock: {
      period: 'half_time_break' as string, elapsed_seconds: 0, anchor: null as string | null, paused: true,
      break_started_at: new Date(Date.now() - 30_000).toISOString() as string | null,
    },
    home_goals: 1, away_goals: 0, shootout: { home: 0, away: 0 },
    participations: [
      { player: vipersKeeper, team_id: 1, status: 'starter', goalkeeper: true },
      { player: vipersOutfield, team_id: 1, status: 'entered', goalkeeper: false },
      { player: vipersBench, team_id: 1, status: 'bench', goalkeeper: false },
      { player: vipersReturn, team_id: 1, status: 'substituted', goalkeeper: false },
      { player: cobrasKeeper, team_id: 2, status: 'starter', goalkeeper: true },
      { player: cobrasOutfield, team_id: 2, status: 'starter', goalkeeper: false },
    ],
    events: [
      event(11, 'shot', 3, 1, vipersOutfield, { outcome: 'goal' }),
      event(12, 'yellow_card', 5, 2, cobrasOutfield),
      event(13, 'substitution', 6, 1, vipersReturn, { payload: { incoming_player_id: 2 } }),
    ],
  }
  const next = {
    ...match, id: 42, stage: 'league', match_order: 2, home_team: visitor, away_team: home,
    home_team_id: 2, away_team_id: 1, state: 'scheduled', version: 0, participations: [], events: [],
    clock: { period: null, elapsed_seconds: 0, anchor: null, paused: true }, home_goals: 0, away_goals: 0,
  }
  const data = {
    ...tournament, lifecycle: 'running', version: 20, teams: [home, visitor],
    settings: { players_per_side: 2, half_minutes: 7, break_minutes: 5, between_match_rest_minutes: 15, playoff_rest_minutes: 60 },
    matches: [live, next],
  }
  return { data, live, event, people: { vipersKeeper, vipersOutfield, vipersReturn, cobrasOutfield, cobrasKeeper } }
}

test('active match desk leads with events, rolling subs and untimed clock control on phones', async ({ page }) => {
  const { data, live, event, people } = activeMatchFixture()
  const history: { id: number; action: string; match_id: number; created_at: string; details: Record<string, unknown>; undone: boolean }[] = [
    { id: 80, action: 'match_event', match_id: 41, created_at: new Date().toISOString(), details: { match_id: 41, event_id: 11 }, undone: false },
  ]
  const posts: { path: string; body: Record<string, unknown> }[] = []
  await page.route('**/api/cup**', (route) => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    if (method === 'POST') {
      const body = route.request().postDataJSON()
      posts.push({ path, body })
      data.version += 1
      live.version += 1
      if (path.endsWith('/events') && body.event_type === 'substitution') {
        live.events.push(event(14, 'substitution', Number(body.minute), 1, people.vipersKeeper, { payload: { incoming_player_id: body.incoming_player_id } }))
        live.participations = live.participations.map((row) => row.player.id === body.player_id
          ? { ...row, status: 'substituted', goalkeeper: false }
          : row.player.id === body.incoming_player_id ? { ...row, status: 'entered', goalkeeper: true } : row)
      } else if (path.endsWith('/clock') && body.command === 'resume') {
        live.state = 'live'
        live.clock = { period: 'second_half', elapsed_seconds: 0, anchor: new Date(Date.now() - 60_000).toISOString(), paused: false, break_started_at: null }
      } else if (path.endsWith('/clock') && body.command === 'end_period') {
        live.state = 'review'
        live.clock = { ...live.clock, period: 'full_time', anchor: null, paused: true }
      }
      return route.fulfill({ json: { version: data.version, match_version: live.version } })
    }
    const payload = path === '/api/cup' ? { tournaments: [data] }
      : path === '/api/cup/players' ? { players: [] }
        : path.endsWith('/history') ? { history } : { tournament: data }
    return route.fulfill({ json: payload })
  })
  await page.route('**/api/cup-auth/session', (route) =>
    route.fulfill({ json: { authenticated: true, csrf_token: 'synthetic-token' } }))
  await page.addInitScript(() => window.sessionStorage.setItem('venomsfc.internal-cup.match.1', '42'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tournament-host')

  await expect(page.getByText('Match 1 is on the pitch. Other fixtures unlock after it is finalized.')).toBeVisible()
  await expect(page.getByLabel('Match', { exact: true })).toHaveCount(0)
  const glance = page.locator('.cup-host-score .cup-host-event-glance')
  await expect(glance).toContainText('Mia Winger')
  await expect(glance).toContainText('Yellow card')
  await expect(glance).toContainText('Mia Winger on · Dan Back off')
  const status = page.locator('.cup-clock-status')
  await expect(status).toContainText('reference break left')
  await expect(status).toContainText('start the second half whenever ready')

  const y = async (locator: ReturnType<typeof page.locator>) => (await locator.boundingBox())?.y ?? Number.NaN
  const recordY = await y(page.getByRole('heading', { name: /Record a match event/ }))
  const subY = await y(page.getByRole('heading', { name: /Rolling substitution/ }))
  const clockY = await y(page.getByRole('button', { name: 'Start second half' }))
  const keeperY = await y(page.getByRole('heading', { name: 'Change active goalkeeper' }))
  expect(clockY).toBeLessThan(recordY)
  expect(recordY).toBeLessThan(subY)
  expect(subY).toBeLessThan(keeperY)
  await expect(page.getByLabel('Minute', { exact: true })).toHaveCount(0)
  await expect(glance.getByRole('button', { name: /^Edit / }).first()).toBeVisible()
  await expect(glance.getByRole('button', { name: /^Undo / }).first()).toBeVisible()
  await expect(page.getByLabel('Event', { exact: true }).locator('option[value="substitution"]')).toHaveCount(0)

  await page.getByRole('group', { name: 'Substitution team' }).getByRole('button', { name: 'Vipers' }).click()
  await page.getByRole('group', { name: 'Player coming off' }).getByRole('button', { name: 'Rhea Striker (GK)' }).click()
  await expect(page.getByText(/The goalkeeper is coming off/)).toBeVisible()
  const comingOn = page.getByRole('group', { name: 'Player coming on' })
  await expect(comingOn.getByRole('button', { name: 'Cara Bench' })).toBeVisible()
  await comingOn.getByRole('button', { name: 'Dan Back · re-entry' }).click()
  await page.getByRole('button', { name: 'Make substitution' }).click()
  await expect.poll(() => posts.length).toBe(1)
  expect(posts[0].path).toBe('/api/cup/host/matches/41/events')
  expect(posts[0].body).toMatchObject({ event_type: 'substitution', team_id: 1, player_id: 1, incoming_player_id: 5, historical: false })
  expect(posts[0].body).not.toHaveProperty('minute')
  await expect(glance).toContainText('Dan Back on · Rhea Striker off')

  for (const width of [390, 430, 800]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(page.getByRole('button', { name: 'Start second half' })).toBeInViewport({ ratio: 1 }).catch(async () => {
      await page.getByRole('button', { name: 'Start second half' }).scrollIntoViewIfNeeded()
      await expect(page.getByRole('button', { name: 'Start second half' })).toBeInViewport({ ratio: 1 })
    })
  }

  await expect(page.getByRole('button', { name: 'Start second half' })).toBeEnabled()
  await page.getByRole('button', { name: 'Start second half' }).click()
  await expect.poll(() => posts.length).toBe(2)
  expect(posts[1].body).toMatchObject({ command: 'resume' })
  await expect(status).toContainText('second half')

  let dialogs = 0
  page.once('dialog', (dialog) => { dialogs += 1; expect(dialog.message()).toContain('reference time is left'); void dialog.dismiss() })
  await page.getByRole('button', { name: 'End second half' }).click()
  await expect.poll(() => dialogs).toBe(1)
  expect(posts).toHaveLength(2)

  // Beyond the 7-minute reference: the clock keeps counting and ending needs no early-end confirmation.
  live.clock = { ...live.clock, anchor: new Date(Date.now() - 8.5 * 60_000).toISOString() }
  live.events = live.events.filter((row) => row.id !== 11)
  live.home_goals = 0
  history.push({ id: 90, action: 'event_correction', match_id: 41, created_at: new Date().toISOString(), details: { match_id: 41, event_id: 12 }, undone: false })
  await page.reload()
  await expect(page.getByLabel('Match', { exact: true })).toHaveCount(0)
  await expect(status).toContainText('/ 7:00 reference (+1:')
  await expect(glance).not.toContainText('Goal')
  await expect(glance.locator('li').filter({ hasText: 'Leo Cobra' })).toContainText('Corrected')
  page.on('dialog', () => { dialogs += 1 })
  await page.getByRole('button', { name: 'End second half' }).click()
  await expect.poll(() => posts.length).toBe(3)
  expect(posts[2].body).toMatchObject({ command: 'end_period' })
  expect(dialogs).toBe(1)
})

test('public scoreboard groups goals and cards by team and only animates newly confirmed goals', async ({ page }) => {
  test.setTimeout(60_000)
  const { data, live, event, people } = activeMatchFixture()
  live.state = 'live'
  live.clock = { period: 'first_half', elapsed_seconds: 0, anchor: new Date().toISOString(), paused: false, break_started_at: null }
  live.events.push(event(15, 'own_goal', 7, 1, people.vipersKeeper))
  live.events.push(event(16, 'yellow_card', 8, 2, people.cobrasOutfield, { payload: { second_yellow_dismissal: true } }))
  live.away_goals = 1
  await page.route('**/api/branding/**', (route) => route.fulfill({ status: 404 }))
  await page.route('**/api/cup**', (route) => {
    const path = new URL(route.request().url()).pathname
    const payload = path === '/api/cup' ? { tournaments: [data] }
      : path === '/api/cup/matches/41' ? { match: live }
        : path === '/api/cup/players' ? { players: [] } : { tournament: data }
    return route.fulfill({ json: payload })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const card = page.locator('.cup-home-live a.cup-match-card.is-live')
  await expect(card).toHaveAttribute('href', '/matches/41')
  const homeList = card.getByRole('list', { name: 'Vipers goals and cards' })
  const awayList = card.getByRole('list', { name: 'Cobras goals and cards' })
  await expect(homeList).toContainText('Mia Winger')
  await expect(homeList).not.toContainText('Leo Cobra')
  await expect(awayList).toContainText('Rhea Striker (OG)')
  await expect(awayList.getByRole('listitem')).toHaveCount(3)
  await expect(awayList.getByRole('listitem').filter({ hasText: '8′' })).toContainText('Second yellow, sent off')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.goto('/matches/41')
  const board = page.locator('section.cup-scoreboard')
  await expect(board.getByRole('list', { name: 'Vipers goals and cards' })).toContainText('Mia Winger')
  await expect(board.getByRole('list', { name: 'Cobras goals and cards' })).toContainText('Leo Cobra')
  await page.waitForTimeout(5600)
  await expect(page.getByTestId('cup-goal-burst')).toHaveCount(0)

  live.events.push(event(17, 'shot', 9, 2, people.cobrasOutfield, { outcome: 'saved' }))
  await expect(page.getByRole('listitem').filter({ hasText: 'saved' }).first()).toBeVisible({ timeout: 8000 })
  await expect(page.getByTestId('cup-goal-burst')).toHaveCount(0)

  live.events.push(event(18, 'shot', 10, 2, people.cobrasOutfield, { outcome: 'goal' }))
  live.away_goals = 2
  await expect(page.getByTestId('cup-goal-burst')).toContainText('Leo Cobra · Cobras', { timeout: 8000 })
  await expect(page.getByTestId('cup-goal-burst')).toHaveCount(0, { timeout: 5000 })
  await expect(board.getByRole('list', { name: 'Cobras goals and cards' }).getByRole('listitem').filter({ hasText: '10′' })).toContainText('Leo Cobra')

  live.events = live.events.filter((row) => row.id !== 18)
  live.away_goals = 1
  await expect(board.getByRole('list', { name: 'Cobras goals and cards' }).getByRole('listitem').filter({ hasText: '10′' })).toHaveCount(0, { timeout: 8000 })
  await expect(page.getByTestId('cup-goal-burst')).toHaveCount(0)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  live.events.push(event(19, 'shot', 11, 1, people.vipersOutfield, { outcome: 'goal' }))
  live.home_goals = 2
  const burst = page.getByTestId('cup-goal-burst')
  await expect(burst).toBeVisible({ timeout: 8000 })
  expect(await burst.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
