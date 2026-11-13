import { expect, test } from '@playwright/test'

test('read-only PostgreSQL homepage squads, captains and phone layouts', async ({ page, request }) => {
  test.setTimeout(180_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const url = process.env.CUP_PG_PREVIEW_URL
  test.skip(!url, 'Requires the protected loopback PostgreSQL preview.')
  const tournament = (await (await request.get(`${url}/api/cup/1`)).json()).tournament
  const auction = await (await request.get(`${url}/api/auction/state`)).json()
  const sourceCaptains = auction.players.filter((player: { captain: boolean }) => player.captain)
  expect(sourceCaptains).toHaveLength(5)
  for (const team of tournament.teams) {
    const captain = team.players.find((player: { id: number }) => player.id === team.captain_player_id)
    expect(captain).toBeTruthy()
    const sourceTeam = auction.teams.find((row: { name: string }) => row.name === team.name)
    expect(sourceTeam).toBeTruthy()
    expect(sourceCaptains.some((player: { name: string; team_id: number }) =>
      player.name === captain.name && player.team_id === sourceTeam.id)).toBe(true)
  }
  await page.goto(`${url}/`)
  await expect(page.getByRole('heading', { name: 'Squads' })).toBeVisible({ timeout: 20_000 })
  const announced = ['published', 'running', 'completed'].includes(tournament.lifecycle)
  const states = tournament.matches.map((match: { state: string }) => match.state)
  await expect(page.getByRole('heading', { name: 'Fixtures & results' }))
    .toHaveCount(announced && (states.includes('scheduled') || states.includes('finalized')) ? 1 : 0)
  await expect(page.getByRole('heading', { name: /^Up next/ })).toHaveCount(announced && states.includes('scheduled') ? 1 : 0)
  await expect(page.getByRole('heading', { name: /^Results/ })).toHaveCount(announced && states.includes('finalized') ? 1 : 0)
  await expect(page.locator('.cup-featured-banner')).toHaveCount(announced ? 1 : 0)
  await expect(page.locator('.cup-featured')).toHaveCount(announced ? 0 : 1)
  await expect(page.getByRole('heading', { name: 'Live now' })).toHaveCount(['running', 'completed'].includes(tournament.lifecycle) ? 1 : 0)
  const finalized = tournament.matches.filter((row: { state: string }) => row.state === 'finalized')
  await expect(page.locator('.cup-home-fixture-group').filter({ has: page.getByRole('heading', { name: /^Results/ }) })
    .locator('.cup-match-card')).toHaveCount(Math.min(4, finalized.length))
  for (const match of finalized) {
    const card = page.locator(`.cup-home-fixtures a[href="/matches/${match.id}"] .cup-match-score`)
    if (await card.count()) await expect(card).toHaveText(`${match.home_goals} : ${match.away_goals}`)
  }
  await expect(page.locator('.cup-roster-team')).toHaveCount(5)
  await expect(page.locator('.cup-roster-team .cup-captain')).toHaveCount(5)
  await expect(page.locator('.cup-roster-team li a')).toHaveCount(26)
  for (const team of tournament.teams) {
    const roster = page.locator('.cup-roster-team').filter({ has: page.locator(`a[href="/teams/${team.id}"]`) })
    await expect(roster.locator('li a').first()).toHaveAttribute('href', `/players/${team.captain_player_id}`)
  }
  const missing = await page.locator('.cup-roster-board').evaluate((board, teams) => {
    return teams.flatMap((team: { id: number; players: { id: number; name: string; position: string }[] }) => {
      const card = board.querySelector(`a[href="/teams/${team.id}"]`)?.closest('.cup-roster-team')
      return team.players.filter((player) => {
        const link = card?.querySelector(`a[href="/players/${player.id}"]`)
        return !link || !link.textContent?.includes(player.name) ||
          !link.textContent.includes(player.position) || !link.querySelector('img[src]')
      }).map((player) => player.id)
    })
  }, tournament.teams)
  expect(missing).toEqual([])
  await expect(page.locator('.pitch-ball svg path')).toHaveCount(2)
  for (const width of [390, 430, 800, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const clipped = await page.locator('.cup-main').evaluate((main) =>
      Array.from(main.querySelectorAll('a, button')).some((link) => {
        const rect = link.getBoundingClientRect()
        return rect.left < -1 || rect.right > window.innerWidth + 1
      }))
    expect(clipped).toBe(false)
  }
  await page.goto(`${url}/tournaments/1?section=squads`)
  await expect(page.locator('.cup-roster-team .cup-captain')).toHaveCount(5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.goto(`${url}/tournaments/1?section=table`)
  expect(await page.locator('.cup-table-logo').first().evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(46)
  await page.goto(`${url}/tournaments/1?section=leaders`)
  await expect(page.locator('.cup-leaderboard')).toHaveCount(7)
  await page.goto(`${url}/tournament-host`)
  const login = page.locator('.cup-login')
  await expect(login).toBeVisible()
  const centered = await login.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return Math.abs((rect.left + rect.right) / 2 - window.innerWidth / 2) < 2
  })
  expect(centered).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('local PostgreSQL preview displays decided squads and protects auction writes', async ({ page, request }) => {
  const url = process.env.CUP_PG_PREVIEW_URL
  test.skip(!url, 'Requires the protected loopback PostgreSQL preview.')

  const tournamentResponse = await request.get(`${url}/api/cup/1`)
  expect(tournamentResponse.ok()).toBe(true)
  const tournament = (await tournamentResponse.json()).tournament
  expect(tournament.teams).toHaveLength(5)
  expect(tournament.teams.reduce((total: number, team: { players: unknown[] }) => total + team.players.length, 0)).toBe(26)
  const playersResponse = await request.get(`${url}/api/cup/players`)
  const players = (await playersResponse.json()).players
  expect(players).toHaveLength(28)
  for (const player of players) {
    expect((await request.get(`${url}${player.photo_path}`)).ok()).toBe(true)
  }
  expect((await request.post(`${url}/api/auction/reset`, { data: {} })).status()).toBe(403)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${url}/tournaments/1`)
  await expect(page.getByRole('heading', { name: 'Venoms Internal Cup', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Squads', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Top scorers' })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.goto(`${url}/tournament-host`)
  await expect(page.getByLabel('Host password')).toBeVisible()
  await page.goto(`${url}/host`)
  await expect(page.getByLabel(/password/i)).toBeVisible()
  await page.goto(`${url}/auction`)
  await expect(page.getByRole('note')).toContainText('auction editing is disabled')
})

test('real PostgreSQL fixture rosters populate the host lineup editor without writes', async ({ page, request }) => {
  const url = process.env.CUP_PG_PREVIEW_URL
  test.skip(!url, 'Requires the protected loopback PostgreSQL preview.')
  const tournament = (await (await request.get(`${url}/api/cup/1`)).json()).tournament
  const fixtures = tournament.matches.filter((match: { state: string }) =>
    ['draft', 'scheduled'].includes(match.state))
  test.skip(fixtures.length === 0, 'No pending real Cup fixture to inspect.')
  await page.route('**/api/cup-auth/session', (route) =>
    route.fulfill({ json: { authenticated: true, csrf_token: 'read-only-browser-fixture' } }))
  await page.route('**/api/cup/host/*/history', (route) => route.fulfill({ json: { history: [] } }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${url}/tournament-host`)
  const selector = page.locator('.cup-host-card')
    .filter({ has: page.getByRole('heading', { name: /Match control & scoring$/ }) }).locator('select').first()
  for (const fixture of fixtures.slice(0, 2)) {
    await selector.selectOption(String(fixture.id))
    for (const [index, teamId] of [fixture.home_team_id, fixture.away_team_id].entries()) {
      const team = tournament.teams.find((row: { id: number }) => row.id === teamId)
      const side = page.locator('.cup-lineup-side').nth(index)
      await expect(side.locator('strong').first()).toContainText(team.name)
      await expect(side.locator('.cup-lineup-player')).toHaveCount(team.players.length)
      await expect(side.locator('.cup-lineup-player b')).toHaveText(team.players.map((player: { name: string }) => player.name))
    }
  }
})
