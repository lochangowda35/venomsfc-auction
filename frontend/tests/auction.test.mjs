import { test } from 'node:test'
import assert from 'node:assert/strict'
import { availablePlayers, bidBlockReason, eventDescription, mediaPath, portraitPath, resultsCsv, setupProblems } from '../src/auction.ts'
import { ApiError, request } from '../src/api.ts'

const player = (id, status = 'available') => ({
  id, name: `Player ${id}`, photo_path: `/api/media/player-${id}.png`, position: 'MID',
  status, team_id: null, price: null,
})
const team = (id) => ({
  id, name: `Team ${id}`, logo_path: `/api/media/team-${id}.png`,
  budget: 100, spent: 0, remaining_slots: 1, max_bid: 100, roster: [],
})
const state = (overrides = {}) => ({
  version: 1, status: 'running', squad_size: 1,
  teams: Array.from({ length: 5 }, (_, index) => team(index + 1)),
  players: Array.from({ length: 5 }, (_, index) => player(index + 1)),
  current: { player_id: 1, team_id: null, bid: 0 }, last_event: null, can_undo: false,
  ...overrides,
})

test('only eligible teams can bid exactly the next 10-credit increment', () => {
  assert.equal(bidBlockReason(state(), team(1)), null)
  assert.equal(bidBlockReason(state({ current: { player_id: 1, team_id: 1, bid: 10 } }), team(1)), 'Leading bid')
  assert.equal(bidBlockReason(state(), { ...team(1), remaining_slots: 0 }), 'Squad full')
  assert.equal(bidBlockReason(state({ current: null }), team(1)), 'Choose a player first')
  assert.equal(bidBlockReason(state({ status: 'paused' }), team(1)), 'Auction is not live')
  assert.equal(bidBlockReason(state({ status: 'completed' }), team(1)), 'Auction is not live')
  assert.equal(bidBlockReason(state({ current: { player_id: 1, team_id: 2, bid: 90 } }), team(1)), null)
  assert.equal(bidBlockReason(state({ current: { player_id: 1, team_id: 2, bid: 100 } }), team(1)), 'Reserve / budget limit')
  assert.equal(bidBlockReason(state(), { ...team(1), max_bid: 0 }), 'Reserve / budget limit')
})

const captained = (overrides = {}) => {
  const value = state(overrides)
  value.teams.forEach((club, index) => { club.roster = [{ id: index + 1, name: `Player ${index + 1}`, photo_path: '', position: 'MID', price: 10, captain: true }] })
  return value
}

test('setup enforces exactly five teams, configured pool size, captains and local media', () => {
  assert.deepEqual(setupProblems(captained({ status: 'setup' })), [])
  assert.match(setupProblems(state({ status: 'setup' })).join(' '), /captain and captain price for every team \(0\/5 done\)/)
  assert.match(setupProblems(state({ teams: [] })).join(' '), /exactly five teams/)
  assert.match(setupProblems(state({ squad_size: 2 })).join(' '), /5 more players/)
  assert.match(setupProblems(state({ squad_size: 0 })).join(' '), /between 1 and 100/)
  assert.match(setupProblems(state({ squad_size: 101 })).join(' '), /between 1 and 100/)
  assert.match(setupProblems(state({ teams: [{ ...team(1), logo_path: 'https://example.test/a.png' }] })).join(' '), /Re-upload team logos/)
  assert.match(setupProblems(state({ players: [{ ...player(1), photo_path: '' }] })).join(' '), /Re-upload player photos/)
  assert.ok(mediaPath.test('/api/media/3a09d-1234.webp'))
  assert.ok(!mediaPath.test('/api/media/image.svg'))
  assert.ok(!mediaPath.test('https://example.test/image.png'))
  for (const name of ['blackmambas', 'cobras', 'vipers', 'pythons', 'anacondas']) {
    assert.ok(mediaPath.test(`/api/branding/${name}.jpg`))
  }
  assert.ok(!mediaPath.test('/api/branding/auction-banner.jpg'))
  assert.ok(!mediaPath.test('/api/branding/venoms-fc.jpg'))
  const official = captained({ status: 'setup', fixed_teams: true })
  official.teams.forEach((club) => { club.logo_path = '/api/branding/cobras.jpg' })
  assert.deepEqual(setupProblems(official), [])
})

test('manual selection permits unsold profiles but never sold/current players', () => {
  const auction = state({ players: [player(1), player(2, 'unsold'), player(3, 'current'), player(4, 'sold')] })
  assert.deepEqual(availablePlayers(auction).map((p) => p.id), [1, 2])
})

test('wide official logos use square display crops without changing stored profile paths', () => {
  for (const name of ['blackmambas', 'vipers']) {
    assert.equal(portraitPath(`/api/branding/${name}.jpg`), `/api/branding/${name}-crest.jpg`)
    assert.ok(mediaPath.test(`/api/branding/${name}.jpg`))
  }
  assert.equal(portraitPath('/api/branding/cobras.jpg'), '/api/branding/cobras.jpg')
  assert.equal(portraitPath('/api/media/player-1.png'), '/api/media/player-1.png')
})

test('display banners resolve public names and amounts', () => {
  assert.equal(eventDescription(state({ last_event: { action: 'profile' } })),
    'Auction setup updated. Matchday is getting closer.')
  assert.equal(eventDescription(state({ last_event: { action: 'bid', team_id: 1, amount: 30 } })), 'Team 1 bids 30 points')
  assert.equal(eventDescription(state({ last_event: { action: 'sold', team_id: 2, player_id: 3, amount: 50 } })), 'Player 3 → Team 2 · 50 points')
  assert.match(eventDescription(state({ last_event: { action: 'pause' } })), /paused/)
  assert.match(eventDescription(state({ last_event: { action: 'undo' } })), /reversed/)
})

test('CSV includes unsold and available results, escapes names and neutralizes formulas', () => {
  const csv = resultsCsv([
    { ...player(1, 'sold'), name: 'One, "Captain"', team_id: 1, price: 30 },
    { ...player(2, 'unsold'), name: '  =HYPERLINK("unsafe")' },
    { ...player(3), name: '\u0000+formula' },
    { ...player(4), name: '@formula' },
  ], [team(1)])
  assert.ok(csv.includes('"Price (points)"'))
  assert.ok(!csv.includes('credits'))
  assert.ok(csv.startsWith('\uFEFF"Player"'))
  assert.ok(csv.includes('"One, ""Captain""","MID","sold","Team 1","30"'))
  assert.ok(csv.includes('"\'  =HYPERLINK(""unsafe"")"'))
  assert.ok(csv.includes('"\'' + '\u0000+formula"'))
  assert.ok(csv.includes('"\'@formula"'))
})

// These tests run serially because they replace the process-global fetch.
test('API requests preserve same-origin cookies and CSRF, never retry writes', async () => {
  const originalFetch = globalThis.fetch
  globalThis.window = globalThis
  try {
    const calls = []
    globalThis.fetch = async (path, options) => {
      calls.push({ path, ...options })
      return new Response(JSON.stringify({ error: 'Stale state', fields: { expected_version: 'refresh' } }), { status: 409 })
    }
    await assert.rejects(request('/api/auction/actions', {
      method: 'POST', csrf: 'test-token',
      body: { action: 'bid', team_id: 1, expected_version: 4, request_id: 'unique-request' },
    }), (error) => error instanceof ApiError && error.status === 409 && error.fields.expected_version === 'refresh')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].credentials, 'same-origin')
    assert.equal(calls[0].headers['X-CSRF-Token'], 'test-token')
    assert.equal(calls[0].headers['Content-Type'], 'application/json')
    assert.equal(JSON.parse(calls[0].body).expected_version, 4)
  } finally { globalThis.fetch = originalFetch; delete globalThis.window }
})

test('API uploads allow browser multipart boundaries; failures retain status', async () => {
  const originalFetch = globalThis.fetch
  globalThis.window = globalThis
  try {
    globalThis.fetch = async (_path, options) => {
      assert.equal(options.headers['Content-Type'], undefined)
      assert.ok(options.body instanceof FormData)
      return new Response(JSON.stringify({ path: '/api/media/test.png' }), { status: 201 })
    }
    const form = new FormData()
    form.append('file', new Blob(['image'], { type: 'image/png' }), 'image.png')
    assert.deepEqual(await request('/api/uploads', { method: 'POST', body: form, csrf: 'token' }), { path: '/api/media/test.png' })
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Expired' }), { status: 401 })
    await assert.rejects(request('/api/auction/history'), (error) => error.status === 401)
    globalThis.fetch = async () => { throw new TypeError('Network unavailable') }
    await assert.rejects(request('/api/auction/state'), (error) => error.status === 0)
    globalThis.fetch = async () => new Response('not json')
    await assert.rejects(request('/api/auction/state'), (error) => error.status === 502)
  } finally { globalThis.fetch = originalFetch; delete globalThis.window }
})
