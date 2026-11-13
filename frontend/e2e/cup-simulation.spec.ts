import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { APIResponse } from '@playwright/test'

type VersionedResult = { version: number; match_version?: number; tournament_id?: number; [key: string]: unknown }

test('real SQLite HTTP cup simulation finalizes all league and playoff fixtures with consistent public stats and undo', async ({ page, request }) => {
  const passwordFile = process.env.CUP_E2E_PASSWORD_FILE
  test.skip(!process.env.CUP_SIMULATION_E2E_URL || !passwordFile, 'Requires the isolated controllable-clock Cup simulation server.')
  test.setTimeout(420_000)

  const baseURL = process.env.CUP_SIMULATION_E2E_URL!
  const password = (await readFile(passwordFile!, 'utf8')).trim()
  let version = 0
  let tournamentId = 0
  const matchVersions = new Map<number, number>()

  async function json(response: APIResponse) {
    const body = await response.json()
    expect(response.status(), JSON.stringify(body)).toBeLessThan(300)
    return body
  }

  const session = await json(await request.get(`${baseURL}/api/cup-auth/session`))
  const login = await json(await request.post(`${baseURL}/api/cup-auth/login`, {
    headers: { 'X-CSRF-Token': session.csrf_token },
    data: { password },
  }))
  const headers = { 'X-CSRF-Token': login.csrf_token }

  async function post(path: string, data: Record<string, unknown>, matchId?: number): Promise<VersionedResult> {
    const body = {
      ...data,
      request_id: randomUUID(),
      expected_version: version,
      ...(matchId === undefined ? {} : { expected_match_version: matchVersions.get(matchId) }),
    }
    const result = await json(await request.post(`${baseURL}${path}`, { headers, data: body })) as VersionedResult
    version = result.version
    if (matchId !== undefined && result.match_version !== undefined) {
      matchVersions.set(matchId, result.match_version)
    }
    return result
  }

  async function advanceTo(isoDate: string) {
    const current = await json(await request.get(`${baseURL}/__simulation/clock`))
    const seconds = Math.max(0, Math.ceil((Date.parse(isoDate) - Date.parse(current.now)) / 1000))
    if (seconds > 0) await json(await request.post(`${baseURL}/__simulation/clock`, { data: { advance_seconds: seconds } }))
  }

  const create = await json(await request.post(`${baseURL}/api/cup/host/tournaments`, {
    headers,
    data: { request_id: randomUUID(), name: 'Venoms Internal Cup', edition: 'Full simulation' },
  }))
  tournamentId = create.tournament_id
  version = create.version
  await post(`/api/cup/host/${tournamentId}/import-squads`, {})
  await post(`/api/cup/host/${tournamentId}/settings`, {
    settings: {
      players_per_side: 2,
      half_minutes: 1,
      break_minutes: 0,
      between_match_rest_minutes: 0,
      playoff_rest_minutes: 1,
    },
  })

  const initialClock = await json(await request.get(`${baseURL}/__simulation/clock`))
  const firstKickoff = new Date(Date.parse(initialClock.now) + 60_000).toISOString()
  await post(`/api/cup/host/${tournamentId}/fixtures`, { kickoff: firstKickoff })
  let detail = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))
  const teamPlayers = new Map<number, { keeper: number; field: number; bench: number }>()
  for (const team of detail.tournament.teams) {
    const goalkeeper = team.players.find((row: { position: string }) => row.position.toUpperCase() === 'GK')
      ?? team.players[0]
    const field = team.players.find((row: { id: number; position: string }) =>
      row.id !== goalkeeper?.id && row.position.toUpperCase() !== 'GK')
    const bench = team.players.find((row: { id: number }) =>
      row.id !== goalkeeper?.id && row.id !== field?.id)
    expect(goalkeeper, `${team.name} copied roster must include a goalkeeper`).toBeTruthy()
    expect(field, `${team.name} copied roster must include an outfield player`).toBeTruthy()
    expect(bench, `${team.name} copied roster must include a substitute`).toBeTruthy()
    teamPlayers.set(team.id, { keeper: goalkeeper.id, field: field.id, bench: bench.id })
  }
  for (const match of detail.tournament.matches) matchVersions.set(match.id, match.version)

  for (const match of detail.tournament.matches) {
    const home = teamPlayers.get(match.home_team_id)!
    const away = teamPlayers.get(match.away_team_id)!
    const players = [
      { player_id: home.keeper, team_id: match.home_team_id, status: 'starter', goalkeeper: true },
      { player_id: home.field, team_id: match.home_team_id, status: 'starter', goalkeeper: false },
      { player_id: home.bench, team_id: match.home_team_id, status: 'bench', goalkeeper: false },
      { player_id: away.keeper, team_id: match.away_team_id, status: 'starter', goalkeeper: true },
      { player_id: away.field, team_id: match.away_team_id, status: 'starter', goalkeeper: false },
      { player_id: away.bench, team_id: match.away_team_id, status: 'bench', goalkeeper: false },
    ]
    await post(`/api/cup/host/matches/${match.id}/lineup`, { players }, match.id)
  }
  await post(`/api/cup/host/${tournamentId}/publish`, {})
  await post(`/api/cup/host/${tournamentId}/start`, {})
  detail = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))

  async function recordShot(match: { id: number; clock: { period: string } }, teamId: number, playerId: number,
    outcome: 'goal' | 'saved' | 'blocked', assistId?: number, keeperId?: number) {
    return post(`/api/cup/host/matches/${match.id}/events`, {
      event_type: 'shot',
      minute: 1,
      period: match.clock.period,
      team_id: teamId,
      player_id: playerId,
      outcome,
      assist_player_id: assistId ?? null,
      goalkeeper_id: keeperId ?? null,
    }, match.id)
  }

  async function openFixture(match: { id: number; scheduled_at: string; home_team_id: number; away_team_id: number }) {
    await advanceTo(match.scheduled_at)
    await post(`/api/cup/host/matches/${match.id}/clock`, { command: 'kickoff' }, match.id)
    return (await json(await request.get(`${baseURL}/api/cup/matches/${match.id}`))).match
  }

  async function finishRegulation(match: { id: number }) {
    await json(await request.post(`${baseURL}/__simulation/clock`, { data: { advance_seconds: 60 } }))
    await post(`/api/cup/host/matches/${match.id}/clock`, { command: 'end_period' }, match.id)
    await post(`/api/cup/host/matches/${match.id}/clock`, { command: 'resume' }, match.id)
    await json(await request.post(`${baseURL}/__simulation/clock`, { data: { advance_seconds: 60 } }))
    await post(`/api/cup/host/matches/${match.id}/clock`, { command: 'end_period' }, match.id)
  }

  for (const [index, fixture] of detail.tournament.matches.entries()) {
    let active = await openFixture(fixture)
    const home = teamPlayers.get(fixture.home_team_id)!
    const away = teamPlayers.get(fixture.away_team_id)!
    if (index === 0) {
      const current = await json(await request.get(`${baseURL}/__simulation/clock`))
      await page.clock.install({ time: Date.parse(current.now) })
      await page.goto(`${baseURL}/matches/${fixture.id}`)
      await expect(page.locator('.cup-score-number small')).toContainText(/first half · 0:0[0-4]/)
      await page.clock.runFor(2100)
      await expect(page.locator('.cup-score-number small')).toContainText(/first half · 0:(0[2-9]|[1-5]\d)/)
    }
    await recordShot(active, fixture.home_team_id, home.field, 'goal', home.keeper)
    await recordShot(active, fixture.away_team_id, away.field, 'saved', undefined, home.keeper)
    if (index === 0) {
      const erroneous = await recordShot(active, fixture.away_team_id, away.field, 'blocked')
      const history = await json(await request.get(`${baseURL}/api/cup/host/${tournamentId}/history`))
      const audit = history.history.find((row: { action: string; details: { event_id: number } }) =>
        row.action === 'match_event' && row.details.event_id === erroneous.event_id)
      expect(audit).toBeTruthy()
      const preview = await json(await request.get(
        `${baseURL}/api/cup/host/${tournamentId}/undo-preview?target_audit_id=${audit.id}`,
      ))
      expect(preview.affected).toHaveLength(0)
      const undone = await post(`/api/cup/host/${tournamentId}/undo`, {
        target_audit_id: audit.id, cascade: false,
      })
      matchVersions.set(fixture.id, matchVersions.get(fixture.id)! + 1)
      expect(undone.undone_ids).toContain(audit.id)
      active = (await json(await request.get(`${baseURL}/api/cup/matches/${fixture.id}`))).match
      await post(`/api/cup/host/matches/${fixture.id}/events`, {
        event_type: 'substitution',
        minute: 2,
        period: active.clock.period,
        team_id: fixture.home_team_id,
        player_id: home.field,
        incoming_player_id: home.bench,
      }, fixture.id)
    }
    await finishRegulation(active)
    await post(`/api/cup/host/matches/${fixture.id}/finalize`, {}, fixture.id)
  }

  detail = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))
  expect(detail.tournament.matches.filter((match: { stage: string }) => match.stage === 'league')).toHaveLength(10)
  expect(detail.tournament.matches.every((match: { state: string }) => match.state === 'finalized')).toBe(true)
  const firstPlayed = detail.tournament.matches[0]
  const firstGoal = firstPlayed.events.find((event: { event_type: string; outcome: string }) =>
    event.event_type === 'shot' && event.outcome === 'goal')
  await page.goto(`${baseURL}/tournament-host`)
  await page.getByLabel('Host password').fill(password)
  await page.getByRole('button', { name: 'Enter tournament desk' }).click()
  await page.getByRole('combobox', { name: 'Match', exact: true }).selectOption(String(firstPlayed.id))
  const firstSub = firstPlayed.events.find((event: { event_type: string }) => event.event_type === 'substitution')
  const subRow = page.locator(`.cup-host-event-glance li[data-event-id="${firstSub.id}"]`)
  await subRow.getByRole('button', { name: /^Edit / }).click()
  await subRow.getByLabel('Remove only this event (later events stay)').check()
  page.once('dialog', (dialog) => void dialog.accept())
  await subRow.getByRole('button', { name: 'Remove event' }).click()
  await expect(page.getByText(/Cup action .* saved/)).toBeVisible()
  let edited = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))
  version = edited.tournament.version
  expect(edited.tournament.matches[0].events.some((event: { id: number }) => event.id === firstSub.id)).toBe(false)
  let editHistory = await json(await request.get(`${baseURL}/api/cup/host/${tournamentId}/history`))
  let editAudit = [...editHistory.history].reverse().find((row: { action: string }) => row.action === 'event_correction')
  await post(`/api/cup/host/${tournamentId}/undo`, { target_audit_id: editAudit.id, cascade: false })
  await page.reload()
  await page.getByRole('combobox', { name: 'Match', exact: true }).selectOption(String(firstPlayed.id))
  const eventForm = page.locator('.cup-event-form').filter({ has: page.getByRole('heading', { name: /Record a match event/ }) })
  await eventForm.getByLabel('Played period').selectOption('second_half')
  await eventForm.getByRole('combobox', { name: 'Team', exact: true }).selectOption(String(firstPlayed.home_team_id))
  await eventForm.getByRole('combobox', { name: 'Player', exact: true }).selectOption(String(teamPlayers.get(firstPlayed.home_team_id)!.keeper))
  await eventForm.getByLabel('Minute').fill('3')
  await eventForm.getByRole('combobox', { name: 'Event', exact: true }).selectOption('yellow_card')
  page.once('dialog', (dialog) => void dialog.accept())
  await eventForm.getByRole('button', { name: 'Save event' }).click()
  await expect(page.getByText(/Cup action .* saved/)).toBeVisible()
  edited = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))
  version = edited.tournament.version
  expect(edited.tournament.matches[0].events.some((event: { event_type: string }) => event.event_type === 'yellow_card')).toBe(true)
  editHistory = await json(await request.get(`${baseURL}/api/cup/host/${tournamentId}/history`))
  editAudit = [...editHistory.history].reverse().find((row: { action: string }) => row.action === 'match_event')
  await post(`/api/cup/host/${tournamentId}/undo`, { target_audit_id: editAudit.id, cascade: false })
  await page.reload()
  await page.getByRole('combobox', { name: 'Match', exact: true }).selectOption(String(firstPlayed.id))
  const goalRow = page.locator(`.cup-host-event-glance li[data-event-id="${firstGoal.id}"]`)
  await goalRow.getByRole('button', { name: /^Edit / }).click()
  await goalRow.getByRole('combobox', { name: 'Outcome', exact: true }).selectOption('off_target')
  page.once('dialog', (dialog) => void dialog.accept())
  await goalRow.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText(/Cup action .* saved/)).toBeVisible()
  let corrected = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))
  expect(corrected.tournament.matches[0].home_goals).toBe(0)
  version = corrected.tournament.version
  editHistory = await json(await request.get(`${baseURL}/api/cup/host/${tournamentId}/history`))
  editAudit = [...editHistory.history].reverse().find((row: { action: string }) => row.action === 'event_correction')
  await post(`/api/cup/host/${tournamentId}/undo`, { target_audit_id: editAudit.id, cascade: false })
  corrected = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))
  expect(corrected.tournament.matches[0].home_goals).toBe(1)
  matchVersions.set(firstPlayed.id, corrected.tournament.matches[0].version)

  const originalPlayer = corrected.tournament.teams.flatMap((team: { players: { id: number; photo_path: string }[] }) =>
    team.players).find((player: { id: number }) => player.id === firstGoal.player_id)
  const originalPhoto = await request.get(`${baseURL}${originalPlayer.photo_path}`)
  expect(originalPhoto.ok()).toBe(true)
  await page.reload()
  await page.getByRole('button', { name: 'Squad & settings' }).click()
  await page.getByRole('combobox', { name: 'Profile', exact: true }).selectOption(`player:${originalPlayer.id}`)
  await page.getByLabel('Upload a Cup photo or logo').setInputFiles({
    name: 'profile.jpg', mimeType: 'image/jpeg', buffer: await originalPhoto.body(),
  })
  await page.getByRole('button', { name: 'Upload Cup image' }).click()
  await expect(page.getByText(/Image uploaded to Cup-only storage/)).toBeVisible()
  await page.getByRole('button', { name: 'Save tournament profile' }).click()
  await expect(page.getByText(/Cup action .* saved/)).toBeVisible()
  corrected = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))
  version = corrected.tournament.version
  const uploadedPlayer = await json(await request.get(`${baseURL}/api/cup/players/${originalPlayer.id}`))
  expect(uploadedPlayer.player.photo_path).toMatch(/^\/api\/cup\/media\//)
  expect((await request.get(`${baseURL}${uploadedPlayer.player.photo_path}`)).ok()).toBe(true)
  editHistory = await json(await request.get(`${baseURL}/api/cup/host/${tournamentId}/history`))
  editAudit = [...editHistory.history].reverse().find((row: { action: string }) => row.action === 'cup_profile')
  await post(`/api/cup/host/${tournamentId}/undo`, { target_audit_id: editAudit.id, cascade: false })
  const restoredPlayer = await json(await request.get(`${baseURL}/api/cup/players/${originalPlayer.id}`))
  expect(restoredPlayer.player.photo_path).toBe(originalPlayer.photo_path)
  detail = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))
  const tiedRanks = new Map<number, number[]>()
  for (const row of detail.tournament.standings) {
    tiedRanks.set(row.rank, [...(tiedRanks.get(row.rank) ?? []), row.id])
  }
  const tieGroups = [...tiedRanks.values()].filter((group) => group.length > 1)
  if (tieGroups.length) {
    await post(`/api/cup/host/${tournamentId}/tie-resolution`, { team_orders: tieGroups })
  }

  const latestFinish = Math.max(...detail.tournament.matches.map((match: { finalized_at: string }) =>
    Date.parse(match.finalized_at)))
  const thirdPlaceKickoff = new Date(latestFinish + 60_000).toISOString()
  await page.goto(`${baseURL}/tournament-host`)
  await page.getByRole('button', { name: 'Match desk', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Playoff qualification' })).toContainText('Your playoff line-up is set')
  await expect(page.getByRole('button', { name: 'Finish tournament', exact: true })).toBeDisabled()
  const playoffDate = new Date(thirdPlaceKickoff)
  await page.getByLabel('Third-place kickoff', { exact: true }).fill(
    new Date(playoffDate.getTime() - playoffDate.getTimezoneOffset() * 60_000).toISOString().slice(0, 16))
  await page.getByRole('button', { name: 'Add final & third-place match', exact: true }).click()
  await expect(page.getByText(/Cup action .* saved/)).toBeVisible()
  detail = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))
  version = detail.tournament.version
  const third = detail.tournament.matches.find((match: { stage: string }) => match.stage === 'third_place')
  const final = detail.tournament.matches.find((match: { stage: string }) => match.stage === 'final')
  await page.goto(`${baseURL}/tournament-host`)
  await page.getByRole('button', { name: 'Match desk' }).click()
  await page.getByRole('combobox', { name: 'Match', exact: true }).selectOption(String(final.id))
  const updatedFinalTime = new Date(Date.parse(final.scheduled_at) + 60_000)
  const localFinalTime = new Date(updatedFinalTime.getTime() - updatedFinalTime.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16)
  await page.getByLabel('New kickoff').fill(localFinalTime)
  await page.getByRole('button', { name: 'Save playoff kickoff' }).click()
  await expect(page.getByText(/Cup action .* saved/)).toBeVisible()
  detail = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))
  version = detail.tournament.version
  const rescheduledFinal = detail.tournament.matches.find((match: { id: number }) => match.id === final.id)
  expect(Date.parse(rescheduledFinal.scheduled_at)).toBe(updatedFinalTime.getTime())
  Object.assign(final, rescheduledFinal)
  for (const match of [third, final]) matchVersions.set(match.id, match.version)
  for (const match of [third, final]) {
    const home = teamPlayers.get(match.home_team_id)!
    const away = teamPlayers.get(match.away_team_id)!
    const players = [
      { player_id: home.keeper, team_id: match.home_team_id, status: 'starter', goalkeeper: true },
      { player_id: home.field, team_id: match.home_team_id, status: 'starter', goalkeeper: false },
      { player_id: home.bench, team_id: match.home_team_id, status: 'bench', goalkeeper: false },
      { player_id: away.keeper, team_id: match.away_team_id, status: 'starter', goalkeeper: true },
      { player_id: away.field, team_id: match.away_team_id, status: 'starter', goalkeeper: false },
      { player_id: away.bench, team_id: match.away_team_id, status: 'bench', goalkeeper: false },
    ]
    await post(`/api/cup/host/matches/${match.id}/lineup`, { players }, match.id)
    await post(`/api/cup/host/matches/${match.id}/playoff-rules`, {
      draw_method: 'direct_penalties', shootout_kicks: 1, shootout_taker_rule: 'rotate_active_players',
    }, match.id)
  }

  const activeThird = await openFixture(third)
  const thirdHome = teamPlayers.get(third.home_team_id)!
  const thirdAway = teamPlayers.get(third.away_team_id)!
  await recordShot(activeThird, third.home_team_id, thirdHome.field, 'goal', thirdHome.keeper)
  await recordShot(activeThird, third.away_team_id, thirdAway.field, 'saved', undefined, thirdHome.keeper)
  await finishRegulation(activeThird)
  await post(`/api/cup/host/matches/${third.id}/finalize`, {}, third.id)

  const activeFinal = await openFixture(final)
  const finalHome = teamPlayers.get(final.home_team_id)!
  const finalAway = teamPlayers.get(final.away_team_id)!
  await recordShot(activeFinal, final.home_team_id, finalHome.field, 'goal', finalHome.keeper)
  await recordShot(activeFinal, final.away_team_id, finalAway.field, 'saved', undefined, finalHome.keeper)
  await json(await request.post(`${baseURL}/__simulation/clock`, { data: { advance_seconds: 60 } }))
  await post(`/api/cup/host/matches/${final.id}/clock`, { command: 'end_period' }, final.id)
  await post(`/api/cup/host/matches/${final.id}/clock`, { command: 'resume' }, final.id)
  await recordShot({ ...activeFinal, clock: { period: 'second_half' } }, final.away_team_id,
    finalAway.field, 'goal', finalAway.keeper)
  await recordShot({ ...activeFinal, clock: { period: 'second_half' } }, final.home_team_id,
    finalHome.field, 'saved', undefined, finalAway.keeper)
  await json(await request.post(`${baseURL}/__simulation/clock`, { data: { advance_seconds: 60 } }))
  await post(`/api/cup/host/matches/${final.id}/clock`, { command: 'end_period' }, final.id)

  await post(`/api/cup/host/matches/${final.id}/shootout`, {
    team_id: final.home_team_id, player_id: finalHome.field, scored: true,
  }, final.id)
  await post(`/api/cup/host/matches/${final.id}/shootout`, {
    team_id: final.away_team_id, player_id: finalAway.field, scored: false,
  }, final.id)
  await post(`/api/cup/host/matches/${final.id}/finalize`, {}, final.id)
  const history = await json(await request.get(`${baseURL}/api/cup/host/${tournamentId}/history`))
  const finalizationAudit = history.history.find((row: { action: string; match_id: number }) =>
    row.action === 'match_finalize' && row.match_id === final.id)
  expect(finalizationAudit).toBeTruthy()
  const undoPreview = await json(await request.get(
    `${baseURL}/api/cup/host/${tournamentId}/undo-preview?target_audit_id=${finalizationAudit.id}`,
  ))
  expect(undoPreview.affected).toHaveLength(0)
  await post(`/api/cup/host/${tournamentId}/undo`, {
    target_audit_id: finalizationAudit.id, cascade: false,
  })
  matchVersions.set(final.id, matchVersions.get(final.id)! + 1)
  const afterUndo = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))
  expect(afterUndo.tournament.lifecycle).toBe('running')
  expect(afterUndo.tournament.matches.find((match: { id: number }) => match.id === final.id).state).toBe('review')
  await post(`/api/cup/host/matches/${final.id}/finalize`, {}, final.id)
  await page.goto(`${baseURL}/tournament-host`)
  await page.getByRole('button', { name: 'Match desk', exact: true }).click()
  const finishTournament = page.getByRole('button', { name: 'Finish tournament', exact: true })
  await expect(finishTournament).toBeEnabled()
  page.once('dialog', (dialog) => { void dialog.accept() })
  await finishTournament.click()
  await expect(page.getByRole('heading', { name: 'Tournament finished' })).toBeVisible()

  const cup = await json(await request.get(`${baseURL}/api/cup/${tournamentId}`))
  expect(cup.tournament.lifecycle).toBe('completed')
  expect(cup.tournament.matches).toHaveLength(12)
  expect(cup.tournament.matches.every((match: { state: string }) => match.state === 'finalized')).toBe(true)
  expect(cup.tournament.standings.every((row: { played: number }) => row.played === 4)).toBe(true)
  expect(cup.tournament.leaderboards.goals[0].total).toBeGreaterThan(0)
  expect(cup.tournament.leaderboards.assists[0].total).toBeGreaterThan(0)
  expect(cup.tournament.leaderboards.saves[0].total).toBeGreaterThan(0)
  expect(Date.parse(cup.tournament.updated_at)).toBeGreaterThanOrEqual(Math.max(
    ...cup.tournament.matches.map((match: { finalized_at: string }) => Date.parse(match.finalized_at)),
  ))

  const publicMatch = await json(await request.get(`${baseURL}/api/cup/matches/${final.id}`))
  expect(publicMatch.match.home_goals).toBe(1)
  expect(publicMatch.match.away_goals).toBe(1)
  expect(publicMatch.match.shootout).toEqual({ home: 1, away: 0 })
  expect(publicMatch.match.events.some((event: { event_type: string; payload: { scored?: boolean } }) =>
    event.event_type === 'shootout' && event.payload.scored === false)).toBe(true)
  const firstFixture = cup.tournament.matches.find((match: { stage: string }) => match.stage === 'league')
  expect(firstFixture.events.some((event: { event_type: string; voided?: boolean }) =>
    event.event_type === 'shot' && event.voided)).toBe(false)
  expect(firstFixture.events.some((event: { event_type: string }) => event.event_type === 'substitution')).toBe(true)

  await page.goto(`${baseURL}/tournaments/${tournamentId}`)
  await expect(page.getByRole('table', { name: 'Internal Cup league standings' })).toBeVisible()
  await expect(page.locator('.cup-table tbody tr')).toHaveCount(5)
  await expect(page.getByText('Live / provisional standings')).toBeVisible()
  await expect(page.getByText(/Host ranking decision pending/)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Top scorers' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Top assists' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Top saves' })).toBeVisible()
  await expect(page.getByText(/Cup host activity last recorded/)).toBeVisible()

  await page.goto(`${baseURL}/matches/${final.id}`)
  await expect(page.locator('.cup-score-number')).toContainText(`${publicMatch.match.home_goals}:${publicMatch.match.away_goals}`)
  await expect(page.getByText('Penalty shoot-out')).toBeVisible()
  await expect(page.getByText(`${final.home_team.name} win on penalties.`)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Line-ups & participation' })).toBeVisible()
  await expect(page.getByText('Penalty scored')).toBeVisible()
  await expect(page.getByText('Penalty missed')).toBeVisible()

  const scorer = cup.tournament.leaderboards.goals[0].player
  const scorerProfile = await json(await request.get(`${baseURL}/api/cup/players/${scorer.id}`))
  expect(scorerProfile.player.statistics.goals).toBe(cup.tournament.leaderboards.goals[0].total)
  expect(scorerProfile.player.matches).toHaveLength(scorerProfile.player.statistics.appearances)
  await page.goto(`${baseURL}/players/${scorer.id}`)
  await expect(page.getByRole('heading', { name: scorer.name })).toBeVisible()
  await expect(page.getByText('Goals', { exact: true })).toBeVisible()
  await expect(page.locator('.cup-player-stats')).toContainText(String(scorer.statistics?.goals ?? cup.tournament.leaderboards.goals[0].total))

  const substitution = firstFixture.events.find((event: { event_type: string }) => event.event_type === 'substitution')
  await page.goto(`${baseURL}/matches/${firstFixture.id}`)
  await expect(page.getByRole('heading', { name: 'Line-ups & participation' })).toBeVisible()
  await expect(page.getByText('Substitutes on')).toBeVisible()
  await expect(page.getByText(/On: /)).toBeVisible()
  expect(substitution).toBeTruthy()

  await page.goto(`${baseURL}/auction`)
  await expect(page.getByRole('note')).toContainText('reconstructed test roster')
  await expect(page.getByRole('note')).toContainText('original auction prices and history were not copied')
})
