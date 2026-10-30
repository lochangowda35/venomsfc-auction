import { expect, test } from '@playwright/test'

test('isolated PostgreSQL: unlimited squads, manual results, edits, completion and read-only popups', async ({ page, context, baseURL }) => {
  test.skip(process.env.AUCTION_E2E_MUTATE !== '1' || !process.env.AUCTION_E2E_PASSWORD, 'Requires an explicit isolated test server.')
  test.setTimeout(240000)
  const url = new URL(baseURL!)
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname)
  expect(url.port, 'Never write to the real server').not.toBe('5000')
  const initial = await (await context.request.get('/api/auction/state')).json()
  expect(initial.players).toHaveLength(0)
  expect(initial.teams).toHaveLength(0)
  const session = await (await context.request.get('/api/auth/session')).json()
  const login = await context.request.post('/api/auth/login', {
    headers: { 'X-CSRF-Token': session.csrf_token }, data: { password: process.env.AUCTION_E2E_PASSWORD },
  })
  expect(login.ok()).toBe(true)
  const headers = { 'X-CSRF-Token': (await login.json()).csrf_token }
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  const upload = await context.request.post('/api/uploads', {
    headers, multipart: { file: { name: 'test.png', mimeType: 'image/png', buffer: image } },
  })
  expect(upload.ok()).toBe(true)
  const photo = (await upload.json()).path
  for (let i = 1; i <= 5; i++) {
    expect((await context.request.post('/api/teams', { headers, data: { name: `Test Club ${i}`, logo_path: photo } })).ok()).toBe(true)
  }
  for (let i = 1; i <= 13; i++) {
    expect((await context.request.post('/api/players', {
      headers, data: { name: `Test Player ${i}`, photo_path: photo, position: 'MID' },
    })).ok()).toBe(true)
  }
  async function action(name: string, fields = {}) {
    const state = await (await context.request.get('/api/auction/state')).json()
    const response = await context.request.post('/api/auction/actions', {
      headers, data: { action: name, ...fields, expected_version: state.version, request_id: crypto.randomUUID() },
    })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  for (let i = 1; i <= 5; i++) await action('captain', { team_id: i, player_id: i, price: 10 })
  // Legacy size must never cap a new or existing auction.
  await action('configure', { squad_size: 4 })
  await action('start')
  await action('open_set', { set_name: 'MID' })
  for (let i = 6; i <= 9; i++) {
    await action('select', { player_id: i })
    await action('bid', { team_id: 1 })
    await action('sold')
  }
  await page.goto('/host')
  const clubOne = page.locator('.team-card').filter({ hasText: 'Test Club 1' })
  await expect(clubOne).toContainText('5 signed')
  await expect(page.getByRole('heading', { name: 'Run the room.' })).toBeVisible()
  await page.getByLabel(/Player \(\d+ waiting in set\)/).selectOption('10')
  await page.getByRole('button', { name: 'Bring to floor', exact: true }).click()
  const bid = page.getByRole('button', { name: /Test Club 1 \+10/ })
  await expect(bid).toBeEnabled()
  await bid.click()
  await page.getByRole('button', { name: /✓ SOLD/ }).click()
  await expect(clubOne).toContainText('6 signed')
  await page.getByRole('button', { name: 'Ⅱ Pause', exact: true }).click()

  // Actual host UI records the manual sale and moves an existing sale.
  await page.getByLabel('Player to assign / move').selectOption('11')
  await page.getByLabel('Destination team').selectOption('2')
  await page.getByLabel('Final price (points)', { exact: true }).fill('80')
  await page.getByRole('button', { name: 'Save assignment…', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save assignment', exact: true }).click()
  await expect(page.locator('.team-card').filter({ hasText: 'Test Club 2' })).toContainText('Test Player 11')
  await page.getByLabel('Player to assign / move').selectOption('6')
  await page.getByLabel('Destination team').selectOption('2')
  await page.getByLabel('Final price (points)', { exact: true }).fill('50')
  await page.getByRole('button', { name: 'Save assignment…', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save assignment', exact: true }).click()
  await expect(clubOne).toContainText('5 signed')
  const clubTwo = page.locator('.team-card').filter({ hasText: 'Test Club 2' })
  await expect(clubTwo).toContainText('860 points')

  await page.getByText('Edit teams and player profiles', { exact: true }).click()
  await page.getByRole('button', { name: 'Edit team Test Club 2', exact: true }).click()
  await page.getByLabel('Team name', { exact: true }).fill('Corrected Club')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.locator('.setup-team').filter({ hasText: 'Corrected Club' })).toBeVisible()
  await page.getByRole('button', { name: 'Edit player Test Player 6', exact: true }).click()
  await page.getByLabel('Player name', { exact: true }).fill('Corrected Player')
  await page.getByLabel('Position', { exact: true }).first().selectOption('DEF')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit player Corrected Player' })).toBeVisible()
  await page.getByText('Edit teams and player profiles', { exact: true }).click()

  // A bid on an unresolved player must not prevent explicit completion.
  await page.getByRole('button', { name: '▶ Resume', exact: true }).click()
  await page.getByLabel(/Player \(\d+ waiting in set\)/).selectOption('12')
  await page.getByRole('button', { name: 'Bring to floor', exact: true }).click()
  await page.getByRole('button', { name: /Test Club 1 \+10/ }).click()
  await page.getByRole('button', { name: 'Complete auction…', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('marked unsold')
  await page.getByRole('dialog').getByRole('button', { name: 'Complete auction', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Auction complete.', exact: true })).toBeVisible()
  await expect(page.locator('.team-bid').first()).toBeDisabled()
  const completed = await (await context.request.get('/api/auction/state')).json()
  expect(completed.status).toBe('completed')
  expect(completed.players.find((p: { id: number }) => p.id === 12).status).toBe('unsold')
  expect(completed.players.find((p: { id: number }) => p.id === 13).status).toBe('available')
  expect(completed.players.find((p: { id: number }) => p.id === 6).bids).toEqual([{ team_id: 1, amount: 10 }])
  expect(completed.teams[0].budget).toBe(950)
  expect(completed.teams[1].budget).toBe(860)

  // Click the logo/card, not just its text, in host, TV and mobile spectator.
  for (const [path, width, height] of [['/host', 1280, 900], ['/display', 1920, 1080], ['/', 375, 812]] as const) {
    const view = path === '/host' ? page : await context.newPage()
    await view.setViewportSize({ width, height })
    await view.goto(path)
    if (path !== '/host') {
      await expect(view.getByRole('button', { name: /Save assignment|Complete auction|Edit team/ })).toHaveCount(0)
    }
    await view.locator('.team-card').filter({ hasText: 'Corrected Club' }).locator('.team-logo').click()
    const popup = view.getByRole('dialog', { name: 'Team squad details' })
    await expect(popup).toBeVisible()
    await expect(popup.getByRole('heading', { name: 'Corrected Club', exact: true })).toBeVisible()
    await expect(popup).toContainText('Corrected Player')
    await expect(popup).toContainText('860 points')
    expect(await popup.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await popup.getByRole('button', { name: 'Corrected Player: view details and bid history' }).click()
    await expect(view.locator('.player-dialog')).toContainText('original recorded bids')
    await view.getByRole('button', { name: 'Close player details', exact: true }).click()
    await view.getByRole('button', { name: 'Close team details', exact: true }).click()
    await expect(popup).toHaveCount(0)
    if (view !== page) await view.close()
  }
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Auction complete.', exact: true })).toBeVisible()
  // Completed auctions still accept manual results without reopening bidding.
  await page.getByLabel('Player to assign / move').selectOption('13')
  await page.getByLabel('Destination team').selectOption('3')
  await page.getByLabel('Final price (points)', { exact: true }).fill('40')
  await page.getByRole('button', { name: 'Save assignment…', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save assignment', exact: true }).click()
  await expect(page.locator('.team-card').filter({ hasText: 'Test Club 3' })).toContainText('950 points')
  await expect(page.getByRole('heading', { name: 'Auction complete.', exact: true })).toBeVisible()
})
