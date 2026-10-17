import { deflateSync } from 'node:zlib'
import { expect, test } from '@playwright/test'

function testImage(): Buffer {
  function chunk(name: string, data: Buffer) {
    const type = Buffer.from(name)
    let crc = 0xffffffff
    for (const byte of Buffer.concat([type, data])) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    const size = Buffer.alloc(4)
    size.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, type, data, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(4, 0)
  header.writeUInt32BE(4, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.from([0, ...Array.from({ length: 4 }, () => [30, 180, 100]).flat()])
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat([row, row, row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('isolated local server: complete setup, corrections, auction and synced read-only views', async ({ page, context, baseURL }) => {
  test.skip(process.env.AUCTION_E2E_MUTATE !== '1' || !process.env.AUCTION_E2E_PASSWORD, 'Requires explicit isolated-server opt-in and an ephemeral password.')
  test.setTimeout(240000)
  const url = new URL(baseURL!)
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname)
  expect(url.port, 'Never run the destructive fixture against the real 5000 server').not.toBe('5000')
  let initial = await (await context.request.get('/api/auction/state')).json()
  if (process.env.AUCTION_E2E_REUSE_FIXTURE === '1' && initial.teams.length) {
    expect(initial.teams.every((team: { name: string }) => /^(Corrected Club|Test Club [1-5])$/.test(team.name))).toBe(true)
    expect(initial.players.every((player: { name: string }) => /^(Corrected Captain|Test Player [1-6])$/.test(player.name))).toBe(true)
    const session = await (await context.request.get('/api/auth/session')).json()
    const login = await (await context.request.post('/api/auth/login', {
      headers: { 'X-CSRF-Token': session.csrf_token }, data: { password: process.env.AUCTION_E2E_PASSWORD },
    })).json()
    const headers = { 'X-CSRF-Token': login.csrf_token }
    for (let attempt = 0; initial.status !== 'setup' && attempt < 50; attempt++) {
      expect(initial.can_undo).toBe(true)
      const response = await context.request.post('/api/auction/actions', {
        headers, data: { action: 'undo', expected_version: initial.version, request_id: crypto.randomUUID() },
      })
      expect(response.ok()).toBe(true)
      initial = await response.json()
    }
    expect(initial.status).toBe('setup')
    for (const kind of ['players', 'teams']) {
      for (const profile of initial[kind]) {
        expect((await context.request.delete(`/api/${kind}/${profile.id}`, { headers })).ok()).toBe(true)
      }
    }
    await context.request.post('/api/auth/logout', { headers })
    initial = await (await context.request.get('/api/auction/state')).json()
  }
  expect(initial.status).toBe('setup')
  expect(initial.teams).toHaveLength(0)
  expect(initial.players).toHaveLength(0)

  await page.goto('/host')
  await page.getByLabel('Host password').fill(process.env.AUCTION_E2E_PASSWORD!)
  await page.getByRole('button', { name: 'Enter host desk' }).click()
  await expect(page.getByRole('heading', { name: 'Build the matchday.' })).toBeVisible()
  const file = { name: 'test-image.png', mimeType: 'image/png', buffer: testImage() }
  for (let i = 1; i <= 5; i++) {
    await page.getByRole('button', { name: '＋ Add team', exact: true }).click()
    await page.getByLabel('Team name', { exact: true }).fill(`Test Club ${i}`)
    await page.getByLabel(/Team logo/).setInputFiles(file)
    await expect(page.locator('.upload-preview')).toBeVisible()
    await page.getByRole('button', { name: 'Add team', exact: true }).click()
    await expect(page.locator('.setup-team')).toHaveCount(i)
  }
  const firstTeam = page.locator('.setup-team').first()
  await firstTeam.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Team name', { exact: true }).fill('Corrected Club')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(firstTeam).toContainText('Corrected Club')

  for (let i = 1; i <= 6; i++) {
    await page.getByRole('button', { name: '＋ Add player', exact: true }).click()
    await page.getByLabel('Player name', { exact: true }).fill(`Test Player ${i}`)
    await page.getByLabel('Position', { exact: true }).first().selectOption(i === 1 ? 'GK' : i === 2 ? 'DEF' : i === 3 ? 'ST' : 'MID')
    await page.getByLabel(/Player photo/).setInputFiles(file)
    await page.getByRole('button', { name: 'Add player', exact: true }).click()
    await expect(page.locator('.player-card')).toHaveCount(i)
  }
  await page.locator('.player-card').first().getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Player name', { exact: true }).fill('Corrected Captain')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.locator('.player-card').first()).toContainText('Corrected Captain')

  // Exercise confirmation cancellation and correction deletion without losing a required profile.
  await page.locator('.player-card').last().getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.player-card')).toHaveCount(6)
  await page.locator('.player-card').last().getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Delete profile', exact: true }).click()
  await expect(page.locator('.player-card')).toHaveCount(5)
  await page.getByRole('button', { name: '＋ Add player', exact: true }).click()
  await page.getByLabel('Player name', { exact: true }).fill('Test Player 6')
  await page.getByLabel(/Player photo/).setInputFiles(file)
  await page.getByRole('button', { name: 'Add player', exact: true }).click()
  await expect(page.locator('.player-card')).toHaveCount(6)
  await page.getByLabel('Players per team', { exact: true }).fill('2')
  await page.getByRole('button', { name: 'Save size', exact: true }).click()
  await expect(page.getByText(/Saved: 2 per team/)).toBeVisible()
  await page.getByLabel('Players per team', { exact: true }).fill('1')
  await page.getByRole('button', { name: 'Save size', exact: true }).click()
  await expect(page.getByText(/Saved: 1 per team/)).toBeVisible()
  await page.getByRole('button', { name: 'Start auction →', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Start auction', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Run the room.' })).toBeVisible()

  const tv = await context.newPage()
  await tv.setViewportSize({ width: 1920, height: 1080 })
  await tv.goto('/display')
  const spectator = await context.newPage()
  let readOnlyMutations = 0
  for (const readOnlyPage of [tv, spectator]) {
    readOnlyPage.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') readOnlyMutations++
    })
  }
  await spectator.setViewportSize({ width: 375, height: 812 })
  await spectator.goto('/')
  await page.bringToFront()
  await page.getByLabel('Player (6 eligible)', { exact: true }).selectOption({ label: 'Corrected Captain · GK' })
  await page.getByRole('button', { name: 'Bring to floor', exact: true }).click()
  await tv.bringToFront()
  await expect(tv.getByRole('heading', { name: 'Corrected Captain', exact: true, level: 1 })).toBeVisible({ timeout: 15000 })
  await page.bringToFront()
  await page.getByRole('button', { name: /Corrected Club.*\+10/ }).click()
  await expect(page.getByRole('button', { name: /Corrected Club.*Leading bid/ })).toBeDisabled()
  await page.getByRole('button', { name: /Test Club 2.*\+10/ }).click()
  await tv.bringToFront()
  await expect(tv.locator('.bid-number')).toContainText('20', { timeout: 15000 })
  await page.bringToFront()
  await page.getByRole('button', { name: /Ⅱ Pause/ }).click()
  await expect(page.getByRole('button', { name: /SOLD/ })).toBeDisabled()
  await page.getByRole('button', { name: '▶ Resume', exact: true }).click()
  await page.getByRole('button', { name: /✓ SOLD.*20/ }).click()
  await tv.bringToFront()
  await expect(tv.locator('.team-card').filter({ hasText: 'Test Club 2' })).toContainText('Squad full', { timeout: 15000 })
  await spectator.bringToFront()
  await expect(spectator.locator('.team-card').filter({ hasText: 'Test Club 2' })).toContainText('Corrected Captain', { timeout: 15000 })
  await page.bringToFront()
  await page.getByRole('button', { name: '↶ Undo latest', exact: true }).click()
  await page.getByRole('button', { name: 'Undo latest action', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Corrected Captain', exact: true, level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Mark unsold', exact: true }).click()
  await expect(page.locator('.unsold-pool')).toContainText('Corrected Captain')
  await page.locator('.unsold-pool').getByText('Unsold pool', { exact: false }).click()
  await page.getByRole('button', { name: 'Return to pool', exact: true }).click()
  await expect(page.locator('.unsold-pool')).toHaveCount(0)
  await page.getByRole('button', { name: '⤨ Random player', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mark unsold', exact: true })).toBeEnabled()

  await page.getByRole('button', { name: /Corrected Club.*\+10/ }).click()
  await page.getByRole('button', { name: /✓ SOLD.*10/ }).click()
  await expect(page.locator('.team-card').filter({ hasText: 'Corrected Club' })).toContainText('Squad full')
  const soldClub = page.locator('.team-card').filter({ hasText: 'Corrected Club' })
  await expect(soldClub.locator('.team-money > div').filter({ hasText: 'Remaining' }).locator('strong')).toHaveText('990 points')
  await expect(soldClub.locator('.team-footer')).toContainText('Spent 10 / 1,000 points')
  await expect(page.locator('.history-list')).toContainText('REVERSED')
  for (let team = 2; team <= 5; team++) {
    await page.getByRole('button', { name: '⤨ Random player', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(`Test Club ${team}.*\\+10`) }).click()
    await page.getByRole('button', { name: /✓ SOLD.*10/ }).click()
    await expect(page.locator('.team-card').filter({ hasText: `Test Club ${team}` })).toContainText('Squad full')
    await expect(page.locator('.roster-player')).toHaveCount(team)
  }
  await expect(page.getByRole('heading', { name: 'Squads complete.', exact: true })).toBeVisible()
  await expect(page.getByText('All five squads are full.', { exact: false })).toBeVisible()
  await expect(page.locator('.team-bid')).toHaveCount(5)
  for (const button of await page.locator('.team-bid').all()) await expect(button).toBeDisabled()
  await expect(page.getByRole('button', { name: '⤨ Random player', exact: true })).toBeDisabled()
  await expect(page.locator('.result-card')).toHaveCount(6)
  await expect(page.locator('.status-pill.sold')).toHaveCount(5)
  await expect(page.locator('.status-pill.available')).toHaveCount(1)
  const completed = await (await context.request.get('/api/auction/state')).json()
  expect(completed.status).toBe('completed')
  expect(completed.players).toHaveLength(6)
  expect(completed.players.filter((player: { status: string }) => player.status === 'available')).toHaveLength(1)
  expect(completed.teams.every((team: { roster: unknown[]; remaining_slots: number }) => team.roster.length === 1 && team.remaining_slots === 0)).toBe(true)

  for (const readOnlyPage of [tv, spectator]) {
    await readOnlyPage.bringToFront()
    await expect(readOnlyPage.getByRole('heading', { name: 'Squads complete.', exact: true })).toBeVisible({ timeout: 15000 })
    await expect(readOnlyPage.locator('.roster-player')).toHaveCount(5)
    await expect(readOnlyPage.locator('.status-pill.available')).toHaveCount(1)
    const readOnlyClub = readOnlyPage.locator('.team-card').filter({ hasText: 'Corrected Club' })
    await expect(readOnlyClub.locator('.team-money > div').filter({ hasText: 'Remaining' }).locator('strong')).toHaveText('990 points')
    await expect(readOnlyClub.locator('.team-footer')).toContainText('Spent 10 / 1,000 points')
    await expect(readOnlyPage.getByRole('button', { name: /SOLD|Pause|Resume|Undo|Bring to floor|Random player|Add player|Add team|Return to pool|Start auction/ })).toHaveCount(0)
    const dimensions = await readOnlyPage.evaluate(() => ({
      content: document.documentElement.scrollWidth, viewport: window.innerWidth,
    }))
    expect(dimensions.content, `Read-only content must fit the ${dimensions.viewport}px viewport`).toBeLessThanOrEqual(dimensions.viewport)
  }

  const stateRoute = '**/api/auction/state'
  await spectator.route(stateRoute, (route) => route.abort('connectionrefused'))
  await expect(spectator.getByText('Connection interrupted. Showing the last known state.')).toBeVisible({ timeout: 10000 })
  await expect(spectator.getByRole('heading', { name: 'Squads complete.', exact: true })).toBeVisible()
  await expect(spectator.locator('.roster-player')).toHaveCount(5)
  await expect(spectator.getByRole('button', { name: /SOLD|Pause|Resume|Undo|Bring to floor|Random player/ })).toHaveCount(0)
  await spectator.unroute(stateRoute)
  await expect(spectator.getByText('Connection interrupted. Showing the last known state.')).toHaveCount(0, { timeout: 10000 })
  await expect(spectator.locator('.connection')).toHaveClass(/online/)
  await expect(spectator.locator('footer')).toContainText(`v${completed.version}`)
  await expect(spectator.locator('.roster-player')).toHaveCount(5)
  await expect(spectator.locator('.status-pill.available')).toHaveCount(1)
  expect(readOnlyMutations).toBe(0)
  await page.bringToFront()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: '↓ Download CSV', exact: true }).click()
  expect((await downloadEvent).suggestedFilename()).toBe('venoms-auction-results.csv')
  await tv.close()
  await spectator.close()
})
