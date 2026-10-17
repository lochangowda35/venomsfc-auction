import { expect, test } from '@playwright/test'
import type { AuctionState } from '../src/types'

const picture = '/api/media/00000000-0000-0000-0000-000000000001.png'
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
function sampleState(): AuctionState {
  return {
    version: 1, status: 'running', squad_size: 1, can_undo: true, open_set: 'MID',
    current: { player_id: 1, team_id: null, bid: 0 }, last_event: null,
    teams: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `Club ${i + 1}`, logo_path: picture, budget: 100, spent: 0, remaining_slots: 1, max_bid: 100, roster: [] })),
    players: [{ id: 1, name: 'Demo Captain', photo_path: picture, position: 'MID', status: 'current', team_id: null, price: null, captain: false, bids: [] }],
  }
}

test('spectator and TV never expose mutations, even with an authenticated host cookie', async ({ page }) => {
  let mutations = 0
  const state = sampleState()
  state.teams[0].budget = 990
  state.teams[0].spent = 10
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== 'GET') mutations++
    if (path.includes('/media/')) return route.fulfill({ body: pixel, contentType: 'image/png' })
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true, csrf_token: 'fixture' } })
    return route.fulfill({ json: state })
  })
  for (const path of ['/', '/display']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'Demo Captain', exact: true, level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: /SOLD|Undo|Pause|Bring to floor|Add player|Add team|Enter host/ })).toHaveCount(0)
    await expect(page.getByText(/READ ONLY/)).toBeVisible()
    const soldClub = page.locator('.team-card').filter({ hasText: 'Club 1' })
    await expect(soldClub.locator('.team-money > div').filter({ hasText: 'Remaining' }).locator('strong')).toHaveText('990 points')
    if (path === '/') await expect(soldClub.locator('.team-footer')).toContainText('Spent 10 / 1,000 points')
    expect(await page.locator('body').innerText()).not.toMatch(/\bCR\b|credits/i)
    await expect(page.getByRole('button', { name: /Switch to light/ })).toBeVisible()
    await page.getByRole('button', { name: /Switch to light/ }).click()
    await expect(page.getByRole('button', { name: /Switch to dark/ })).toBeVisible()
    await page.getByRole('button', { name: /Switch to dark/ }).click()
  }
  expect(mutations).toBe(0)
})

test('host disables controls offline and refreshes conflicts without replaying', async ({ page }) => {
  const state = sampleState()
  let posts = 0
  let offline = false
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.includes('/media/')) return route.fulfill({ body: pixel, contentType: 'image/png' })
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true, csrf_token: 'fixture' } })
    if (path.endsWith('/history')) return route.fulfill({ json: { events: [] } })
    if (path.endsWith('/actions')) {
      posts++
      const body = route.request().postDataJSON()
      expect(body).toMatchObject({ action: 'bid', expected_version: 1, team_id: 1 })
      expect(body).not.toHaveProperty('amount')
      expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/)
      state.version++
      state.current = { player_id: 1, team_id: 2, bid: 10 }
      return route.fulfill({ status: 409, json: { error: 'State changed' } })
    }
    if (offline) return route.abort('connectionrefused')
    return route.fulfill({ json: state })
  })
  await page.goto('/host')
  const bid = page.getByRole('button', { name: /Club 1 \+10/ })
  await expect(bid).toBeEnabled()
  await bid.click()
  await expect(page.getByRole('alert').filter({ hasText: /nothing was automatically replayed/ })).toBeVisible()
  expect(posts).toBe(1)
  await expect(page.getByRole('button', { name: /Club 2 Leading bid/ })).toBeDisabled()
  offline = true
  await expect(page.getByText('Connection interrupted. Showing the last known state.')).toBeVisible({ timeout: 10000 })
  await expect(bid).toBeDisabled()
  offline = false
  await expect(bid).toBeEnabled({ timeout: 10000 })
  expect(posts).toBe(1)
})

test('undo confirmation refuses to reverse a different newly-polled action', async ({ page }) => {
  const state = sampleState()
  let posts = 0
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.includes('/media/')) return route.fulfill({ body: pixel, contentType: 'image/png' })
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true, csrf_token: 'fixture' } })
    if (path.endsWith('/history')) return route.fulfill({ json: { events: [] } })
    if (route.request().method() === 'POST') posts++
    return route.fulfill({ json: state })
  })
  await page.goto('/host')
  await page.getByRole('button', { name: '↶ Undo latest' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  state.version = 2
  await expect(page.locator('footer')).toContainText('v2')
  await page.getByRole('button', { name: 'Undo latest action', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('auction changed while confirmation was open')
  expect(posts).toBe(0)
})

test('expired host sessions are refreshed after 401 without replaying the action', async ({ page }) => {
  let authenticated = true
  let posts = 0
  let sessionReads = 0
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.includes('/media/')) return route.fulfill({ body: pixel, contentType: 'image/png' })
    if (path.endsWith('/session')) {
      sessionReads++
      return route.fulfill({ json: { authenticated, csrf_token: authenticated ? 'signed-in' : 'new-session-token' } })
    }
    if (path.endsWith('/history')) return route.fulfill({ json: { events: [] } })
    if (path.endsWith('/actions')) {
      posts++
      authenticated = false
      return route.fulfill({ status: 401, json: { error: 'Session expired' } })
    }
    return route.fulfill({ json: sampleState() })
  })
  await page.goto('/host')
  await page.getByRole('button', { name: /Club 1 \+10/ }).click()
  await expect(page.getByRole('alert')).toContainText('Host session expired')
  await expect(page.getByLabel('Host password')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Run the room.' })).toHaveCount(0)
  expect(sessionReads).toBeGreaterThanOrEqual(2)
  expect(posts).toBe(1)
})

test('mobile spectator has no horizontal overflow and broken images have a fallback', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.route('**/api/**', async (route) => {
    if (route.request().url().includes('/media/')) return route.fulfill({ status: 404, body: '' })
    const state = sampleState()
    state.players[0].name = 'Very long player name to exercise small-screen layouts'
    return route.fulfill({ json: state })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Very long player name/ }).first()).toBeVisible()
  await expect(page.getByLabel(/image unavailable/).first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('anonymous private views show only login, without reading the private or public board', async ({ page }) => {
  let boardReads = 0
  let authenticated = false
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.includes('/branding/')) return route.fulfill({ body: pixel, contentType: 'image/png' })
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated, csrf_token: 'fixture' } })
    if (path.endsWith('/login')) {
      authenticated = true
      return route.fulfill({ json: { authenticated, csrf_token: 'signed-in' } })
    }
    if (path.endsWith('/history')) return route.fulfill({ json: { events: [] } })
    boardReads++
    return route.fulfill({ json: sampleState() })
  })
  for (const path of ['/host', '/display']) {
    await page.goto(path)
    await expect(page.getByLabel('Host password')).toBeVisible()
    await expect(page.locator('.stage, .team-card, .host-controls')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'TV display', exact: true })).toHaveCount(0)
  }
  expect(boardReads).toBe(0)
  await page.getByLabel('Host password').fill('fixture-only')
  await page.getByRole('button', { name: 'Unlock TV display', exact: false }).click()
  await expect(page.getByRole('heading', { name: 'Demo Captain', exact: true, level: 1 })).toBeVisible()
  await expect(page.locator('.host-controls')).toHaveCount(0)
  expect(boardReads).toBeGreaterThan(0)
})

test('TV polling is authenticated and removes its board after logout elsewhere', async ({ page }) => {
  let authenticated = true
  const boardPaths: string[] = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.includes('/branding/') || path.includes('/media/')) return route.fulfill({ body: pixel, contentType: 'image/png' })
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated, csrf_token: 'fixture' } })
    boardPaths.push(path)
    return authenticated ? route.fulfill({ json: sampleState() })
      : route.fulfill({ status: 401, json: { error: 'Host access required' } })
  })
  await page.goto('/display')
  await expect(page.getByRole('heading', { name: 'Demo Captain', exact: true, level: 1 })).toBeVisible()
  authenticated = false
  await expect(page.getByLabel('Host password')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.stage, .team-card')).toHaveCount(0)
  expect(boardPaths.every((path) => path === '/api/auction/display-state')).toBe(true)
})

test('official setup locks team identities and explains the separate HDMI window', async ({ page }) => {
  const state = sampleState()
  state.status = 'setup'
  state.current = null
  state.fixed_teams = true
  const names = ['BlackMambas', 'Cobras', 'Vipers', 'Pythons', 'Anacondas']
  state.teams.forEach((team, i) => {
    team.name = names[i]
    team.logo_path = `/api/branding/${names[i].toLowerCase()}.jpg`
  })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.includes('/branding/') || path.includes('/media/')) return route.fulfill({ body: pixel, contentType: 'image/png' })
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true, csrf_token: 'fixture' } })
    if (path.endsWith('/history')) return route.fulfill({ json: { events: [] } })
    return route.fulfill({ json: state })
  })
  await page.goto('/host')
  await expect(page.locator('.setup-team')).toHaveCount(5)
  await expect(page.locator('.setup-team button')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Add team/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Add player/ })).toBeVisible()
  for (const name of names) await expect(page.locator('.setup-team').filter({ hasText: name }).locator('img')).toBeVisible()
  await page.getByText('How to connect the TV with HDMI').click()
  await expect(page.locator('.tv-guide')).toContainText('Extend')
  await expect(page.locator('.tv-guide')).toContainText('cannot detect your HDMI cable')
  await page.evaluate(() => { window.open = () => null })
  await page.getByRole('button', { name: /Open TV display/ }).click()
  await expect(page.getByRole('status').filter({ hasText: 'blocked the TV window' })).toBeVisible()
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('spectators can open a read-only team page with live squad details', async ({ page }) => {
  const state = sampleState()
  state.squad_size = 3
  state.teams.forEach((team) => { team.remaining_slots = 3; team.budget = 1000; team.max_bid = 980 })
  state.teams[1] = { ...state.teams[1], budget: 940, spent: 60, remaining_slots: 2, max_bid: 930, roster: [{ id: 9, name: 'Signed Keeper', photo_path: picture, position: 'GK', price: 60, captain: false }] }
  let mutations = 0
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== 'GET') mutations++
    if (path.includes('/media/')) return route.fulfill({ body: pixel, contentType: 'image/png' })
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: false, csrf_token: 'fixture' } })
    return route.fulfill({ json: state })
  })
  await page.goto('/')
  const open = page.getByRole('button', { name: 'View Club 2 squad and details' })
  await open.click()
  await expect(page).toHaveURL(/\?team=2$/)
  const title = page.getByRole('heading', { name: 'Club 2', level: 1 })
  await expect(title).toBeFocused()
  await expect(page.locator('.team-detail-stats')).toContainText('940 points')
  await expect(page.locator('.team-detail-stats')).toContainText('60 / 1,000')
  await expect(page.locator('.squad-player').filter({ hasText: 'Signed Keeper' })).toContainText('60 points')
  await expect(page.locator('.open-slot')).toHaveCount(2)
  await expect(page.locator('.position-counts')).toContainText('1 GK')
  await page.getByRole('button', { name: 'Club 3' }).click()
  await expect(page).toHaveURL(/\?team=3$/)
  await expect(page.getByText(/No signings yet/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('button', { name: 'View Club 3 squad and details' })).toBeFocused()
  await page.goto('/?team=2')
  await expect(page.getByRole('heading', { name: 'Club 2', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: /All teams/ }).click()
  await expect(page.locator('.team-card')).toHaveCount(5)
  await page.goto('/display?team=2')
  await expect(page.locator('.team-detail')).toHaveCount(0)
  expect(mutations).toBe(0)
})


test('sets show every player, open set sits below the stage, and sold cards reveal bid history', async ({ page }) => {
  const state = sampleState()
  state.squad_size = 3
  state.current = null
  state.open_set = null
  const player = (id: number, name: string, position: 'GK' | 'DEF' | 'MID' | 'ST', extra: Partial<AuctionState['players'][number]> = {}) =>
    ({ id, name, photo_path: picture, position, status: 'available' as const, team_id: null, price: null, captain: false, bids: [], ...extra })
  state.players = [
    player(1, 'Keeper Waiting', 'GK'),
    player(2, 'Defender Sold', 'DEF', { status: 'sold', team_id: 3, price: 30, bids: [{ team_id: 3, amount: 10 }, { team_id: 2, amount: 20 }, { team_id: 3, amount: 30 }] }),
    player(3, 'Mid Waiting', 'MID'),
    player(4, 'Striker Waiting', 'ST'),
    player(5, 'Skipper One', 'MID', { status: 'sold', team_id: 1, price: 50, captain: true }),
  ]
  state.teams[0].roster = [{ id: 5, name: 'Skipper One', photo_path: picture, position: 'MID', price: 50, captain: true }]
  state.teams[2].roster = [{ id: 2, name: 'Defender Sold', photo_path: picture, position: 'DEF', price: 30, captain: false }]
  let mutations = 0
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== 'GET') mutations++
    if (path.includes('/media/') || path.includes('/branding/')) return route.fulfill({ body: pixel, contentType: 'image/png' })
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true, csrf_token: 'fixture' } })
    return route.fulfill({ json: state })
  })
  await page.goto('/')
  const board = page.locator('.sets-board')
  for (const title of ['Set 1 · Goalkeepers', 'Set 2 · Defenders', 'Set 3 · Midfielders', 'Set 4 · Strikers']) {
    await expect(board.getByRole('heading', { name: title })).toBeVisible()
  }
  await expect(board.getByText('Skipper One')).toHaveCount(0)
  await expect(board.locator('.set-tile.is-sold')).toContainText('Club 3 · 30')
  await expect(page.locator('.team-card').filter({ hasText: 'Club 1' }).locator('.captain-badge')).toBeVisible()
  await page.getByRole('button', { name: /Defender Sold.*View details/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Defender Sold' })).toBeVisible()
  await expect(dialog.locator('.bid-history li')).toHaveCount(3)
  await expect(dialog.locator('.bid-history li').first()).toContainText('Club 3')
  await expect(dialog.locator('.bid-history li').nth(1)).toContainText('Club 2')
  await expect(dialog.locator('.bid-history li.winning')).toContainText('Club 3')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  state.open_set = 'DEF'
  state.players.push(player(6, 'Defender Live', 'DEF', { status: 'current' }))
  state.current = { player_id: 6, team_id: 4, bid: 40, bids: [] }
  await page.goto('/display')
  await expect(page.locator('.auction-hero')).toHaveCount(0)
  await expect(page.locator('.leader .leader-logo')).toBeVisible()
  await expect(page.locator('.leader')).toContainText('Club 4')
  await expect(page.locator('.sets-board .set-section')).toHaveCount(1)
  await expect(page.locator('.sets-board')).toContainText('Set 2 · Defenders')
  await expect(page.locator('.set-tile.is-current')).toContainText('Defender Live')
  const stageBox = await page.locator('.stage').boundingBox()
  const setsBox = await page.locator('.sets-board').boundingBox()
  expect(setsBox!.y).toBeGreaterThan(stageBox!.y)
  await page.setViewportSize({ width: 360, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(mutations).toBe(0)
})


test('TV uses the full width with Squad Watch beside the live auction, and a new sale plays the SOLD moment', async ({ page }) => {
  const state = sampleState()
  state.squad_size = 4
  state.players.push({ id: 2, name: 'Already Signed', photo_path: picture, position: 'MID', status: 'sold', team_id: 2, price: 40, captain: false, bids: [] })
  state.teams[1].roster = [{ id: 2, name: 'Already Signed', photo_path: picture, position: 'MID', price: 40, captain: false }]
  let current = state
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.includes('/media/') || path.includes('/branding/')) return route.fulfill({ body: pixel, contentType: 'image/png' })
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true, csrf_token: 'fixture' } })
    return route.fulfill({ json: current })
  })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/display')
  await expect(page.locator('.sound-toggle')).toContainText('Click anywhere to enable sound')
  await page.keyboard.press('Shift')
  await expect(page.locator('.sound-toggle')).toContainText('Sound on')
  const side = page.locator('.tv-side')
  await expect(side.getByRole('heading', { name: 'Squad watch' })).toBeVisible()
  await expect(side.locator('.team-card')).toHaveCount(5)
  await expect(side.locator('.roster-chips')).toHaveCount(5)
  const stage = await page.locator('.tv-main .stage').boundingBox()
  const sideBox = await side.boundingBox()
  expect(sideBox!.x).toBeGreaterThan(stage!.x + stage!.width - 1)
  expect(sideBox!.x + sideBox!.width).toBeGreaterThan(1920 - 60)
  await expect.poll(async () => {
    const box = await side.locator('.team-card').last().boundingBox()
    return box!.y + box!.height
  }).toBeGreaterThan(1080 - 60)
  const lastCard = await side.locator('.team-card').last().boundingBox()
  expect(lastCard!.y + lastCard!.height).toBeLessThanOrEqual(1080)
  await expect(page.locator('.sold-celebration')).toHaveCount(0)

  const sold = sampleState()
  sold.version = 2
  sold.squad_size = 4
  sold.current = null
  sold.last_event = { action: 'sold', player_id: 1, team_id: 3, amount: 70 }
  sold.players = [{ ...state.players[0], status: 'sold', team_id: 3, price: 70, bids: [{ team_id: 3, amount: 70 }] }, state.players[1]]
  sold.teams[1].roster = state.teams[1].roster
  sold.teams[2].roster = [{ id: 1, name: 'Demo Captain', photo_path: picture, position: 'MID', price: 70, captain: false }]
  current = sold
  const overlay = page.locator('.sold-celebration')
  await expect(overlay).toBeVisible({ timeout: 5000 })
  await expect(overlay).toContainText('SOLD')
  await expect(overlay).toContainText('Demo Captain')
  await expect(overlay).toContainText('Club 3')
  await expect(overlay).toContainText('70')
  await page.waitForTimeout(6000)
  await expect(overlay).toBeVisible()
  await overlay.click()
  await expect(overlay).toHaveCount(0)

  const unsold = structuredClone(sold)
  unsold.version = 3
  unsold.last_event = { action: 'unsold', player_id: 3 }
  unsold.players.push({ id: 3, name: 'Passed Player', photo_path: picture, position: 'DEF', status: 'unsold', team_id: null, price: null, captain: false, bids: [] })
  current = unsold
  const passed = page.locator('.sold-celebration.is-unsold')
  await expect(passed).toBeVisible({ timeout: 5000 })
  await expect(passed).toContainText('UNSOLD')
  await expect(passed).toContainText('Passed Player')
  await expect(passed).toHaveCount(0, { timeout: 7000 })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.waitForTimeout(1500)
  await expect(page.locator('.sold-celebration')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
test('host can delete a started auction only after typing DELETE', async ({ page }) => {
  let current = sampleState()
  const posts: { path: string; body: unknown; csrf: string | null }[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.includes('/media/') || path.includes('/branding/')) return route.fulfill({ body: pixel, contentType: 'image/png' })
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true, csrf_token: 'fixture' } })
    if (path.endsWith('/history')) return route.fulfill({ json: { events: [] } })
    if (request.method() === 'POST') {
      posts.push({ path, body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] ?? null })
      current = { ...sampleState(), status: 'setup', current: null, version: current.version + 1 }
    }
    return route.fulfill({ json: current })
  })
  await page.goto('/host')
  await expect(page.getByRole('link', { name: '⤓ Download backup' })).toHaveAttribute('href', '/api/auction/backup')
  await page.getByRole('button', { name: 'Delete auction…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Players, photos, team names, logos, squad size and captains are kept')
  const confirm = dialog.getByRole('button', { name: 'Delete auction', exact: true })
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel('Type DELETE to confirm').fill('delete')
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel('Type DELETE to confirm').fill('DELETE')
  await confirm.click()
  await expect(page.getByRole('status').filter({ hasText: 'Auction deleted' })).toBeVisible()
  expect(posts).toEqual([{ path: '/api/auction/delete-auction', body: { confirm: 'DELETE', expected_version: 1 }, csrf: 'fixture' }])
  await expect(page.getByRole('button', { name: 'Delete auction…' })).toHaveCount(0)
})