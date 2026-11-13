import { expect, test } from '@playwright/test'

test('synthetic HTTP tied league lets the host choose qualification places without crashing', async ({ page }) => {
  const baseURL = process.env.CUP_TIE_E2E_URL
  test.skip(!baseURL, 'Requires the isolated synthetic completed-league fixture.')
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(`${baseURL}/tournament-host`)
  await page.getByLabel('Host password').fill('synthetic-lineup-password')
  await page.getByRole('button', { name: 'Enter tournament desk' }).click()
  const tie = page.locator('.cup-tie-resolution')
  await expect(tie).toBeVisible()
  const save = tie.getByRole('button', { name: 'Save host ranking decisions' })
  await expect(save).toBeDisabled()
  await tie.getByRole('combobox', { name: 'Place 1', exact: true }).selectOption('5')
  await expect(tie.getByRole('combobox', { name: 'Place 2', exact: true }).locator('option[value="5"]'))
    .toHaveJSProperty('disabled', true)
  await expect(save).toBeDisabled()
  for (const [index, teamId] of [5, 4, 3, 2, 1].entries()) {
    await tie.getByRole('combobox', { name: `Place ${index + 1}`, exact: true }).selectOption(String(teamId))
  }
  for (const width of [390, 430, 800]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await expect(save).toBeEnabled()
  page.once('dialog', (dialog) => { void dialog.dismiss() })
  await save.click()
  const before = await (await page.request.get(`${baseURL}/api/cup/host/1/history`)).json()
  expect(before.history).toHaveLength(0)
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('1. Synthetic team 5')
    expect(dialog.message()).toContain('5. Synthetic team 1')
    void dialog.accept()
  })
  await save.click()
  await expect(tie).toHaveCount(0)
  const detail = (await (await page.request.get(`${baseURL}/api/cup/1`)).json()).tournament
  expect(detail.standings.map((row: { id: number }) => row.id)).toEqual([5, 4, 3, 2, 1])
  expect(detail.unresolved_tie).toBeNull()
  await expect(page.getByRole('button', { name: 'Add final & third-place match' })).toBeEnabled()
  const history = (await (await page.request.get(`${baseURL}/api/cup/host/1/history`)).json()).history
  expect(history).toHaveLength(1)
  expect(history[0].action).toBe('tie_resolution')
  const publicPage = await page.context().newPage()
  await publicPage.goto(`${baseURL}/`)
  const banner = publicPage.getByRole('status', { name: 'Playoff qualification' })
  await expect(banner).toContainText('Synthetic team 5 vs Synthetic team 4')
  await expect(banner).toContainText('Synthetic team 3 vs Synthetic team 2')
  await publicPage.close()
  await page.getByText('Host activity & undo', { exact: true }).click()
  page.once('dialog', (dialog) => { void dialog.accept() })
  await page.locator('.cup-history li').filter({ hasText: 'tie resolution' }).getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(tie).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add final & third-place match' })).toBeDisabled()
  expect(errors).toEqual([])
})

test('synthetic HTTP host desk safely reconciles a late request and restores a live match after relogin', async ({ page, request }) => {
  const baseURL = process.env.CUP_LINEUP_E2E_URL
  test.skip(!baseURL, 'Requires the isolated synthetic Cup host server.')
  test.setTimeout(240_000)

  const clockResponse = await request.get(`${baseURL}/__simulation/clock`)
  expect(clockResponse.ok()).toBe(true)
  const initialClock = await clockResponse.json() as { now: string }
  await page.clock.install({ time: Date.parse(initialClock.now) })
  async function advanceBrowserClock(seconds: number) {
    const now = await page.evaluate(() => Date.now())
    await page.clock.setSystemTime(now + seconds * 1000)
    await page.clock.runFor(1000)
    await page.waitForLoadState('networkidle')
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${baseURL}/tournament-host`)
  await page.getByLabel('Host password').fill('synthetic-lineup-password')
  await page.getByRole('button', { name: 'Enter tournament desk' }).click()
  await expect(page.getByRole('heading', { name: 'Cup matchday desk' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start tournament' })).toBeEnabled()
  await page.getByRole('button', { name: 'Start tournament' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'saved. It is recorded in host history' })).toBeVisible()

  const detailResponse = await request.get(`${baseURL}/api/cup/1`)
  const detail = await detailResponse.json() as {
    tournament: {
      matches: Array<{
        id: number
        home_team_id: number
        away_team_id: number
        home_goals: number
        away_goals: number
        version: number
        state: string
        events: Array<{ id: number; event_type: string; outcome: string; assist_player_id: number | null }>
        participations: Array<{ player_id: number; team_id: number; status: string }>
      }>
    }
  }
  const match = detail.tournament.matches[1]
  expect(match.state).toBe('scheduled')
  const matchPicker = page.getByRole('combobox', { name: 'Match', exact: true })
  await matchPicker.selectOption(String(match.id))
  const sides = page.locator('.cup-lineup-side')
  await expect(sides).toHaveCount(2)
  for (const side of [sides.first(), sides.last()]) {
    for (let index = 0; index < 4; index += 1) {
      await side.getByRole('button', { name: 'Select starter' }).first().click()
    }
    await side.getByRole('button', { name: 'Set as goalkeeper' }).first().click()
  }
  await page.getByRole('button', { name: 'Save starting lineups' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'saved. It is recorded in host history' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Kick off' })).toBeEnabled()
  const savedLineups = await request.get(`${baseURL}/api/cup/matches/${match.id}`)
  const savedMatch = (await savedLineups.json()).match
  expect(savedMatch.participations.filter((row: { status: string }) => row.status === 'starter')).toHaveLength(8)
  expect(savedMatch.participations.filter((row: { status: string }) => row.status === 'bench')).toHaveLength(2)

  const browserTime = await page.evaluate(() => Date.now())
  const alignedTime = browserTime + 10_000
  await page.clock.pauseAt(alignedTime)
  const advanceToAlignedTime = Math.max(1, Math.ceil((alignedTime - Date.parse(initialClock.now)) / 1000))
  const alignResponse = await request.post(`${baseURL}/__simulation/clock`, {
    data: { advance_seconds: advanceToAlignedTime },
  })
  expect(alignResponse.ok()).toBe(true)
  await page.getByRole('button', { name: 'Kick off' }).click()
  await expect(page.getByRole('button', { name: 'Pause clock' })).toBeVisible()
  await expect(page.locator('.cup-readiness-details')).not.toHaveAttribute('open')
  await expect(page.getByRole('button', { name: 'Finish tournament', exact: true })).toBeDisabled()
  for (const width of [390, 430, 800]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.locator('.cup-host-score-line')).toContainText('Synthetic team')
    const sizes = await page.locator('.cup-host-score-line').evaluate((score) => ({
      name: parseFloat(getComputedStyle(score.querySelector('b')!).fontSize),
      logos: score.querySelectorAll('.cup-host-score-team > span').length,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }))
    expect(sizes.logos).toBe(2)
    expect(sizes.name).toBeGreaterThanOrEqual(14)
    expect(sizes.overflow).toBe(false)
  }
  page.once('dialog', (dialog) => { void dialog.accept() })
  await page.getByRole('button', { name: 'Pause tournament', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume tournament', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume clock', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Save event', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Resume tournament', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume clock', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Resume clock', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause clock', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('combobox', { name: 'Team', exact: true }).selectOption(String(match.home_team_id))
  await page.getByRole('combobox', { name: 'Player', exact: true }).selectOption(String(match.home_team_id * 100 + 2))
  await expect(page.getByLabel('Minute', { exact: true })).toHaveCount(0)
  await expect(page.locator('.cup-host-actions').first().locator('xpath=following::h4[contains(., "Record a match event")]')).toHaveCount(1)
  await page.getByRole('combobox', { name: 'Event', exact: true }).selectOption('goal')
  await page.getByRole('combobox', { name: 'Assist (optional)' }).selectOption(String(match.home_team_id * 100 + 3))

  let delayedPath = ''
  const delayedRequests: Array<{ path: string; body: Record<string, unknown> }> = []
  const eventPath = `**/api/cup/host/matches/${match.id}/events`
  await page.route(eventPath, async (route) => {
    const path = new URL(route.request().url()).pathname
    const body = route.request().postDataJSON() as Record<string, unknown>
    delayedRequests.push({ path, body })
    delayedPath = path
    await route.abort('failed')
  })
  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'safely cancelled' })).toBeVisible()
  const delayed = delayedRequests.at(0)
  expect(delayed).toBeTruthy()
  const canceledRequest = delayed!.body
  expect(typeof canceledRequest.request_id).toBe('string')
  expect(canceledRequest.minute).toBeUndefined()
  await page.unroute(eventPath)

  const csrfResponse = await page.evaluate(async () => {
    const response = await fetch('/api/cup-auth/session')
    return response.json()
  }) as { csrf_token: string }
  const lateResponse = await page.evaluate(async ({ path, body, csrf }) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body),
    })
    return { status: response.status, payload: await response.json() }
  }, { path: delayedPath, body: canceledRequest, csrf: csrfResponse.csrf_token })
  expect(lateResponse.status).toBe(409)
  expect(lateResponse.payload.error).toContain('already used')
  const unchanged = (await (await request.get(`${baseURL}/api/cup/matches/${match.id}`)).json()).match
  expect(unchanged.home_goals).toBe(0)
  expect(unchanged.events).toHaveLength(0)

  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'saved. It is recorded in host history' })).toBeVisible()
  const scored = (await (await request.get(`${baseURL}/api/cup/matches/${match.id}`)).json()).match
  expect(scored.home_goals).toBe(1)
  expect(scored.events.some((event: { outcome: string; assist_player_id: number }) =>
    event.outcome === 'goal' && event.assist_player_id === match.home_team_id * 100 + 3)).toBe(true)
  const goalEvent = scored.events.find((event: { outcome: string }) => event.outcome === 'goal')
  expect(goalEvent.minute).toBe(1)

  // Edit the assist and time directly from the recorded-events glance.
  const goalRow = page.locator(`.cup-host-event-glance li[data-event-id="${goalEvent.id}"]`)
  await goalRow.getByRole('button', { name: /^Edit / }).click()
  await goalRow.getByRole('combobox', { name: 'Assist' }).selectOption(String(match.home_team_id * 100 + 4))
  await goalRow.getByLabel('Minute').fill('2')
  await goalRow.getByRole('button', { name: 'Save changes' }).click()
  await expect(goalRow).toContainText('2′')
  await expect(goalRow).toContainText(`assist Team ${match.home_team_id} player 4`)
  await expect(goalRow).toContainText('Corrected')
  const editedGoal = (await (await request.get(`${baseURL}/api/cup/matches/${match.id}`)).json()).match
    .events.find((event: { id: number }) => event.id === goalEvent.id)
  expect(editedGoal.minute).toBe(2)
  expect(editedGoal.assist_player_id).toBe(match.home_team_id * 100 + 4)

  // Undo the goal from the glance: the preview lists the later correction, which is reversed too.
  let undoPrompt = ''
  page.once('dialog', (dialog) => { undoPrompt = dialog.message(); void dialog.accept() })
  await goalRow.getByRole('button', { name: /^Undo / }).click()
  await expect(page.locator('.cup-host-score')).toContainText('0 – 0')
  expect(undoPrompt).toContain('1 later host action')
  const undone = (await (await request.get(`${baseURL}/api/cup/matches/${match.id}`)).json()).match
  expect(undone.home_goals).toBe(0)
  expect(undone.events).toHaveLength(0)

  await page.getByRole('button', { name: 'Pause clock' }).click()
  await expect(page.getByRole('button', { name: 'Resume clock' })).toBeEnabled()
  await page.getByRole('button', { name: 'Sign out of tournament' }).click()
  await expect(page.getByLabel('Host password')).toBeVisible()
  await page.reload()
  await page.getByLabel('Host password').fill('synthetic-lineup-password')
  await page.getByRole('button', { name: 'Enter tournament desk' }).click()
  await expect(page.getByText(/is on the pitch\. Other fixtures unlock after it is finalized\./)).toBeVisible()
  await expect(matchPicker).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resume clock' })).toBeEnabled()
  const restored = (await (await request.get(`${baseURL}/api/cup/matches/${match.id}`)).json()).match
  expect(restored.state).toBe('paused')
  expect(restored.clock.period).toBe('first_half')

  // Halves and the break are reference times: end the first half early and start the second half during the break.
  await page.getByRole('button', { name: 'Resume clock' }).click()
  await expect(page.getByRole('button', { name: 'Pause clock' })).toBeVisible()
  await request.post(`${baseURL}/__simulation/clock`, { data: { advance_seconds: 20 } })
  await advanceBrowserClock(20)
  await expect(page.locator('.cup-clock-status')).toContainText(/first half · 0:(19|2\d) \//)
  page.once('dialog', (dialog) => { expect(dialog.message()).toContain('of the 1:00 reference time is left'); void dialog.accept() })
  await page.getByRole('button', { name: 'End first half' }).click()
  await expect(page.locator('.cup-clock-status')).toContainText('reference break left')
  await request.post(`${baseURL}/__simulation/clock`, { data: { advance_seconds: 5 } })
  await advanceBrowserClock(5)
  await expect(page.getByRole('button', { name: 'Start second half' })).toBeEnabled()
  await page.getByRole('button', { name: 'Start second half' }).click()
  await expect(page.getByRole('button', { name: 'Pause clock' })).toBeVisible()
  const secondHalf = (await (await request.get(`${baseURL}/api/cup/matches/${match.id}`)).json()).match
  expect(secondHalf.state).toBe('live')
  expect(secondHalf.clock.period).toBe('second_half')

  // Rolling substitutions through the dedicated panel, including a re-entry.
  const homeName = `Synthetic team ${match.home_team_id}`
  const offName = `Team ${match.home_team_id} player 2`
  const benchName = `Team ${match.home_team_id} player 5`
  await page.getByRole('group', { name: 'Substitution team' }).getByRole('button', { name: homeName }).click()
  await page.getByRole('group', { name: 'Player coming off' }).getByRole('button', { name: offName, exact: true }).click()
  await page.getByRole('group', { name: 'Player coming on' }).getByRole('button', { name: benchName, exact: true }).click()
  await page.getByRole('button', { name: 'Make substitution' }).click()
  await expect(page.locator('.cup-host-event-glance')).toContainText(`${benchName} on · ${offName} off`)
  await page.getByRole('group', { name: 'Player coming off' }).getByRole('button', { name: benchName, exact: true }).click()
  await page.getByRole('group', { name: 'Player coming on' }).getByRole('button', { name: `${offName} · re-entry` }).click()
  await page.getByRole('button', { name: 'Make substitution' }).click()
  await expect(page.locator('.cup-host-event-glance')).toContainText(`${offName} on · ${benchName} off`)
  const subbed = (await (await request.get(`${baseURL}/api/cup/matches/${match.id}`)).json()).match
  expect(subbed.events.filter((event: { event_type: string }) => event.event_type === 'substitution')).toHaveLength(2)
  const statusOf = (id: number) => subbed.participations.find((row: { player_id?: number; player?: { id: number } }) =>
    (row.player_id ?? row.player?.id) === id)?.status
  expect(statusOf(match.home_team_id * 100 + 2)).toBe('entered')
  expect(statusOf(match.home_team_id * 100 + 5)).toBe('substituted')

  // The half may run past its reference length; the host ends it without an early-end prompt.
  await request.post(`${baseURL}/__simulation/clock`, { data: { advance_seconds: 90 } })
  await advanceBrowserClock(90)
  await expect(page.locator('.cup-clock-status')).toContainText('/ 1:00 reference (+0:')
  const overtime = (await (await request.get(`${baseURL}/api/cup/matches/${match.id}`)).json()).match
  expect(overtime.state).toBe('live')
  await page.getByRole('button', { name: 'End second half' }).click()
  await expect(page.getByRole('button', { name: 'Finalize as a draw' })).toBeVisible()
  const finishedRegulation = (await (await request.get(`${baseURL}/api/cup/matches/${match.id}`)).json()).match
  expect(finishedRegulation.state).toBe('review')
  expect(finishedRegulation.clock.period).toBe('full_time')

  // The user's real path: finalize as a draw, then settle that finalized draw by penalties.
  page.once('dialog', (dialog) => { void dialog.accept() })
  await page.getByRole('button', { name: 'Finalize as a draw' }).click()
  await expect.poll(async () => (await (await request.get(`${baseURL}/api/cup/matches/${match.id}`)).json()).match.state).toBe('finalized')
  const settleFinalized = page.getByRole('button', { name: 'Settle this draw by penalties' })
  await expect(settleFinalized).toBeEnabled()
  page.once('dialog', (dialog) => { expect(dialog.message()).toContain('winner gets 3 league points'); void dialog.accept() })
  await settleFinalized.click()
  const panel = page.locator('.cup-shootout-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.cup-shootout-score')).toContainText('0 – 0')
  await expect(panel.locator('.cup-shootout-progress')).toContainText(`Round 1 of 5 · ${homeName} to kick`)
  await expect(page.getByRole('button', { name: 'Back to a draw (no penalties)' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finalize after a decisive shootout' })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '⚽ Scored' })).toBeDisabled()
  const finishShootout = panel.getByRole('button', { name: 'Finish shootout', exact: true })
  await expect(finishShootout).toBeDisabled()
  await panel.getByLabel('Winner awarded by host').selectOption(String(match.away_team_id))
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('after 0 kicks')
    expect(dialog.message()).toContain('No successful kicks will be invented')
    void dialog.accept()
  })
  await finishShootout.click()
  await expect(panel).toContainText('Winner explicitly awarded by the host')
  await expect(panel.locator('.cup-shootout-attempts li')).toHaveCount(0)
  const zeroFinal = page.getByRole('button', { name: `Finalize · Synthetic team ${match.away_team_id} win on pens` })
  page.once('dialog', (dialog) => { void dialog.accept() })
  await zeroFinal.click()
  const zeroPublic = await page.context().newPage()
  await zeroPublic.goto(`${baseURL}/matches/${match.id}`)
  await expect(zeroPublic.locator('.cup-shootout-summary')).toContainText('winner explicitly awarded by the host')
  await expect(zeroPublic.locator('.cup-shootout-summary')).toContainText(`Synthetic team ${match.away_team_id} win on penalties`)
  await zeroPublic.goto(`${baseURL}/`)
  await expect(zeroPublic.locator(`.cup-home-fixtures a[href="/matches/${match.id}"] .cup-match-decision`))
    .toHaveText(`Synthetic team ${match.away_team_id} win on penalties`)
  await zeroPublic.close()
  // Undo the explicit finish and its finalization using the same dependency-aware HTTP API as the desk.
  const historyAfterAward = (await (await page.request.get(`${baseURL}/api/cup/host/1/history`)).json()).history
  const closure = historyAfterAward.findLast((row: { action: string }) => row.action === 'shootout_finish')
  const afterAward = (await (await request.get(`${baseURL}/api/cup/1`)).json()).tournament
  const currentSession = await (await page.request.get(`${baseURL}/api/cup-auth/session`)).json()
  const undoAward = await page.request.post(`${baseURL}/api/cup/host/1/undo`, {
    headers: { 'X-CSRF-Token': currentSession.csrf_token },
    data: { request_id: 'browser-undo-zero-award', expected_version: afterAward.version, target_audit_id: closure.id, cascade: true },
  })
  expect(undoAward.ok()).toBe(true)
  await page.reload()
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('group', { name: `Synthetic team ${match.home_team_id} penalty taker` }).getByRole('button')).toHaveCount(5)
  let kicks = 0
  const awayId = match.away_team_id
  const homeId = match.home_team_id
  for (let round = 1; round <= 3; round += 1) {
    for (const [teamId, scoredKick] of [[homeId, true], [awayId, false]] as const) {
      const taker = `Team ${teamId} player ${round === 1 ? 5 : round}`
      await expect(panel.getByRole('group', { name: `Synthetic team ${teamId} penalty taker` })).toBeVisible()
      await panel.getByRole('button', { name: taker, exact: true }).click()
      await panel.getByRole('button', { name: scoredKick ? '⚽ Scored' : '✕ Missed / saved' }).click()
      kicks += 1
      await expect(panel.locator('.cup-shootout-attempts li')).toHaveCount(kicks)
      await expect(panel.locator('.cup-shootout-attempts li').last()).toContainText(`${taker}Synthetic team ${teamId}${scoredKick ? 'Scored' : 'Missed'}`)
    }
  }
  await expect(panel.locator('.cup-shootout-score')).toContainText('3 – 0')
  await expect(panel.locator('.cup-shootout-progress')).toContainText(`${homeName} win 3–0 on penalties`)
  for (const width of [390, 430]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  const finalizePens = page.getByRole('button', { name: `Finalize · ${homeName} win on pens` })
  await expect(finalizePens).toBeEnabled()
  page.once('dialog', (dialog) => { expect(dialog.message()).toContain('on penalties'); void dialog.accept() })
  await finalizePens.click()
  await expect.poll(async () => (await (await request.get(`${baseURL}/api/cup/matches/${match.id}`)).json()).match.state).toBe('finalized')
  const settled = (await (await request.get(`${baseURL}/api/cup/1`)).json())
  const settledMatch = settled.tournament.matches.find((row: { id: number }) => row.id === match.id)
  expect(settledMatch.state).toBe('finalized')
  expect([settledMatch.home_goals, settledMatch.away_goals]).toEqual([0, 0])
  expect(settledMatch.shootout_winner_team_id).toBe(homeId)
  const table = new Map(settled.tournament.standings.map((row: { id: number }) => [row.id, row]))
  const homeRow = table.get(homeId) as { points: number; won: number; goals_for: number; goals_against: number }
  const awayRow = table.get(awayId) as { points: number; lost: number }
  expect(homeRow.points).toBe(3)
  expect(homeRow.goals_for).toBe(0)
  expect(homeRow.goals_against).toBe(0)
  expect(awayRow.points).toBe(0)
  for (const width of [390, 430, 800]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await page.goto(`${baseURL}/matches/${match.id}`)
  await expect(page.locator('.cup-scoreboard')).toContainText('pens 3–0')
  await expect(page.locator('.cup-shootout-summary')).toContainText('win on penalties')
  await page.goto(`${baseURL}/`)
  const results = page.locator('.cup-home-fixture-group').filter({ has: page.getByRole('heading', { name: /Results/ }) })
  await expect(results.locator(`a[href="/matches/${match.id}"]`)).toContainText('0 : 0')
  await expect(results.locator(`a[href="/matches/${match.id}"] .cup-match-pens`)).toContainText('3–0')

  for (const width of [390, 430, 800, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})
