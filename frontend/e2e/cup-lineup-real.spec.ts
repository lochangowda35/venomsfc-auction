import { expect, test } from '@playwright/test'

test('real synthetic backend loads, saves and reloads match-specific 4v4 lineups', async ({ page }) => {
  const url = process.env.CUP_LINEUP_E2E_URL
  test.skip(!url, 'Requires the isolated synthetic lineup server.')
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 390, height: 844 })
  const tournament = await (await page.request.get(`${url}/api/cup/1`)).json()
  expect(tournament.tournament.matches[0].home_team.players).toBeUndefined()
  expect(tournament.tournament.teams[0].players).toHaveLength(5)

  await page.goto(`${url}/tournament-host`)
  await page.getByLabel('Host password').fill('synthetic-lineup-password')
  await page.getByRole('button', { name: 'Enter tournament desk' }).click()
  await expect(page.getByRole('heading', { name: 'Cup matchday desk' })).toBeVisible()
  const sides = page.locator('.cup-lineup-side')
  await expect(sides).toHaveCount(2)
  for (const side of [sides.first(), sides.last()]) {
    await expect(side.locator('.cup-lineup-player')).toHaveCount(5)
    for (let index = 0; index < 4; index += 1) {
      await side.getByRole('button', { name: 'Select starter' }).first().click()
    }
    await side.getByRole('button', { name: 'Set as goalkeeper' }).first().click()
    await expect(side).toContainText('1 on the bench automatically')
    await expect(side.getByRole('button', { name: /Bench/ })).toHaveCount(0)
  }
  await page.getByRole('button', { name: 'Save starting lineups' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'saved. It is recorded in host history' })).toBeVisible()
  const saved = (await (await page.request.get(`${url}/api/cup/1`)).json()).tournament.matches[0]
  expect(saved.participations).toHaveLength(10)
  for (const teamId of [1, 2]) {
    const rows = saved.participations.filter((row: { team_id: number }) => row.team_id === teamId)
    expect(rows.filter((row: { status: string }) => row.status === 'starter')).toHaveLength(4)
    expect(rows.filter((row: { status: string }) => row.status === 'bench')).toHaveLength(1)
    expect(rows.find((row: { goalkeeper: boolean }) => row.goalkeeper).player.id).toBe(teamId * 100 + 1)
  }
  await page.reload()
  await expect(sides).toHaveCount(2)
  for (const [index, teamId] of [1, 2].entries()) {
    await expect(sides.nth(index).locator('.cup-lineup-player').filter({ hasText: `Team ${teamId} player 1` })
      .getByRole('button', { name: 'Starting goalkeeper' })).toHaveAttribute('aria-pressed', 'true')
    await expect(sides.nth(index).locator('.cup-lineup-player').nth(4)
      .getByRole('button', { name: 'Select starter' })).toHaveAttribute('aria-pressed', 'false')
  }
  const matchSelector = page.locator('.cup-host-card')
    .filter({ hasText: 'Select any ready league match' }).locator('select').first()
  await matchSelector.selectOption('2')
  await expect(sides.first().locator('.cup-lineup-player')).toHaveCount(5)
  await expect(sides.first().getByRole('button', { name: 'Select starter' })).toHaveCount(5)
  await matchSelector.selectOption('1')
  await sides.first().locator('.cup-lineup-player').nth(3).getByRole('button', { name: 'Starting' }).click()
  await sides.first().locator('.cup-lineup-player').nth(4).getByRole('button', { name: 'Select starter' }).click()
  await sides.first().locator('.cup-lineup-player').nth(4).getByRole('button', { name: 'Set as goalkeeper' }).click()
  await page.getByRole('button', { name: 'Save starting lineups' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'saved. It is recorded in host history' })).toBeVisible()
  const swapped = (await (await page.request.get(`${url}/api/cup/1`)).json()).tournament.matches[0]
  const homeRows = swapped.participations.filter((row: { team_id: number }) => row.team_id === 1)
  expect(homeRows).toHaveLength(5)
  expect(homeRows.find((row: { player: { id: number } }) => row.player.id === 104).status).toBe('bench')
  expect(homeRows.find((row: { player: { id: number } }) => row.player.id === 105).status).toBe('starter')
  await page.reload()
  await expect(sides.first().locator('.cup-lineup-player').nth(4)
    .getByRole('button', { name: 'Starting goalkeeper' })).toHaveAttribute('aria-pressed', 'true')
  await expect(sides.first().locator('.cup-lineup-player').nth(3)
    .getByRole('button', { name: 'Select starter' })).toHaveAttribute('aria-pressed', 'false')
  await expect(sides.last().locator('.cup-lineup-player').nth(3)
    .getByRole('button', { name: 'Starting' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Sign out of tournament' }).click()
  await page.getByLabel('Host password').fill('synthetic-lineup-password')
  await page.getByRole('button', { name: 'Enter tournament desk' }).click()
  await expect(sides.first().locator('.cup-lineup-player').nth(4)
    .getByRole('button', { name: 'Starting goalkeeper' })).toHaveAttribute('aria-pressed', 'true')
  for (const width of [390, 430, 800, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await sides.evaluateAll((elements) => elements.some((side) =>
      Array.from(side.querySelectorAll('button')).some((control) => {
        const bounds = control.getBoundingClientRect()
        return bounds.left < -1 || bounds.right > window.innerWidth + 1
      })))).toBe(false)
  }
})
