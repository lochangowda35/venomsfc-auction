import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from './api'
import { credits } from './auction'
import { Results, Stage, TeamBoard, TeamDetail } from './Board'
import { PlayerDialog, SetsBoard } from './Sets'
import { SoldCelebration } from './Celebration'
import { ConfirmDialog, Login } from './components'
import { History, HostControls } from './HostControls'
import { Setup } from './Setup'
import type { SaveProfile } from './Setup'
import type { Player, Team } from './types'
import { useAuction } from './useAuction'
import { AuctionBanner, TvGuide } from './Branding'
import { unlockSound } from './sound'
import { usePreloadImages } from './usePreload'
import './App.css'

function teamFromUrl(): number | null {
  const value = new URLSearchParams(window.location.search).get('team')
  return value && /^\d{1,9}$/.test(value) ? Number(value) : null
}

type Confirmation = { title: string; body: string; confirm: string; perform: () => void; requireText?: string; danger?: boolean }

function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  const host = path === '/host'
  const tv = path === '/display'
  const privateView = host || tv
  const auction = useAuction(host, tv)
  const { state, connected, busy, canMutate, session } = auction
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [playerId, setPlayerId] = useState<number | null>(null)
  const viewMenu = useRef<HTMLDetailsElement>(null)
  const tvSide = useRef<HTMLElement>(null)
  const tvReady = tv && state !== null && session?.authenticated === true
  usePreloadImages(!host && (!privateView || session?.authenticated === true) ? state : null, tv)
  const [soundOn, setSoundOn] = useState(() => {
    try { return localStorage.getItem('venoms-tv-sound') !== 'off' } catch { return true }
  })
  const [soundUnlocked, setSoundUnlocked] = useState(false)
  useEffect(() => {
    if (!tv || !soundOn || soundUnlocked) return
    // Browsers need one click or key press (e.g. F11) on the TV window before sound can play.
    const unlock = () => { void unlockSound().then(setSoundUnlocked) }
    document.addEventListener('pointerdown', unlock)
    document.addEventListener('keydown', unlock)
    return () => {
      document.removeEventListener('pointerdown', unlock)
      document.removeEventListener('keydown', unlock)
    }
  }, [tv, soundOn, soundUnlocked])
  function toggleSound() {
    const next = !soundOn
    setSoundOn(next)
    try { localStorage.setItem('venoms-tv-sound', next ? 'on' : 'off') } catch { /* Preference is optional. */ }
    if (next) void unlockSound().then(setSoundUnlocked)
  }
  useEffect(() => {
    const side = tvSide.current
    if (!tvReady || !side) return
    // Fit Squad Watch exactly between its (sticky) top edge and the bottom of the TV screen.
    const fit = () => side.style.setProperty('--tv-side-height', `${Math.max(320, window.innerHeight - Math.max(12, side.getBoundingClientRect().top) - 12)}px`)
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(document.body)
    window.addEventListener('resize', fit)
    window.addEventListener('scroll', fit, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', fit)
      window.removeEventListener('scroll', fit)
    }
  }, [tvReady])
  const [teamId, setTeamId] = useState<number | null>(() => privateView ? null : teamFromUrl())
  const returnFocus = useRef<number | null>(null)
  useEffect(() => {
    if (privateView) return
    const sync = () => setTeamId(teamFromUrl())
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [privateView])
  useEffect(() => {
    if (teamId !== null || returnFocus.current === null) return
    const id = returnFocus.current
    returnFocus.current = null
    document.querySelector<HTMLButtonElement>(`.team-open[data-team-id="${id}"]`)?.focus()
  }, [teamId])
  const openTeam = useCallback((id: number) => {
    window.history.pushState({ team: id, fromList: true }, '', `/?team=${id}`)
    setTeamId(id)
    window.scrollTo({ top: 0 })
  }, [])
  const switchTeam = useCallback((id: number) => {
    window.history.replaceState({ ...(window.history.state ?? {}), team: id }, '', `/?team=${id}`)
    setTeamId(id)
  }, [])
  const closeTeam = useCallback(() => {
    returnFocus.current = teamId
    setTeamId(null)
    if (window.history.state?.fromList) window.history.back()
    else window.history.replaceState(null, '', '/')
  }, [teamId])
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !viewMenu.current?.contains(event.target) && viewMenu.current) viewMenu.current.open = false
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && viewMenu.current?.open) {
        viewMenu.current.open = false
        viewMenu.current.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])
  const authorized = !privateView || session?.authenticated === true
  const displayLogin = tv || (host && new URLSearchParams(window.location.search).get('next') === 'display')
  useEffect(() => {
    if (host && displayLogin && session?.authenticated) window.location.replace('/display')
  }, [host, displayLogin, session?.authenticated])
  const [light, setLight] = useState(() => {
    try { return localStorage.getItem('venoms-theme') === 'light' } catch { return false }
  })
  const save: SaveProfile = (kind, id, input) => auction.mutate(async (csrf) => {
    let image = input.image
    if (input.file) {
      const body = new FormData()
      body.append('file', input.file)
      const result = await request<{ path: string }>('/api/uploads', { method: 'POST', csrf, body })
      image = result.path
    }
    await request(`/api/${kind}${id === undefined ? '' : `/${id}`}`, {
      method: id === undefined ? 'POST' : 'PUT', csrf,
      body: kind === 'teams'
        ? { name: input.name, logo_path: image }
        : { name: input.name, photo_path: image, position: input.position },
    })
  }, 'Profile saved.')

  function remove(kind: 'teams' | 'players', entity: Team | Player) {
    setConfirmation({
      title: `Delete ${entity.name}?`, body: 'This removes this profile from setup. You can add it again, but profile deletion cannot be undone.',
      confirm: 'Delete profile', perform: () => {
        void auction.mutate(async (csrf) => {
          await request(`/api/${kind}/${entity.id}`, { method: 'DELETE', csrf })
        }, 'Profile deleted.')
      },
    })
  }

  function toggleTheme() {
    const next = !light
    setLight(next)
    try { localStorage.setItem('venoms-theme', next ? 'light' : 'dark') } catch { /* Theme remains usable without storage. */ }
  }

  return <div className={`app ${tv ? 'tv-view' : ''} ${host ? 'host-view' : 'spectator-view'} ${light ? 'light-theme' : ''}`}>
    <header className="site-header">
      <a className="brand" href="/" aria-label="Venoms FC spectator home"><img className="official-crest" src="/api/branding/venoms-fc.jpg" alt="Official Venoms FC logo" /><span>VENOMS <b>FC</b><small><span>INTERNAL CUP ·</span> <span>THIRD EDITION</span></small></span></a>
      <div className="header-actions">
        <button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${light ? 'dark' : 'light'} theme`} title={`Switch to ${light ? 'dark' : 'light'} theme`}>{light ? '◐' : '◑'}</button>
        <details className="view-switch" ref={viewMenu}>
          <summary><span className="view-switch-icon" aria-hidden="true">☰</span><span>{host ? 'Host' : tv ? 'TV' : 'Watch'}</span><span className="view-switch-caret" aria-hidden="true" /></summary>
          <nav aria-label="View">
            <span className="menu-label">Choose your view</span>
            <a href="/" aria-current={!host && !tv ? 'page' : undefined}>Spectator <small>Public · read-only</small></a>
            {privateView && session?.authenticated
              ? <><a href="/host" aria-current={host ? 'page' : undefined}>Host desk <small>Private controls</small></a>
                {tv && <a href="/display" aria-current="page">TV display <small>Private · read-only</small></a>}</>
              : <a href="/host" aria-current={privateView ? 'page' : undefined}>Host sign in <small>Password required</small></a>}
            {privateView && session?.authenticated && <button className="text-button" disabled={busy} onClick={() => {
              if (viewMenu.current) viewMenu.current.open = false
              void auction.authenticate()
            }}>Sign out</button>}
          </nav>
        </details>
      </div>
    </header>
    <main className="page-shell">
      {!tv && (host || teamId === null) && <AuctionBanner />}
      {authorized && <>
      <div className="live-strip">
        <span className={`connection ${connected ? 'online' : 'offline'}`}><i aria-hidden="true" />{connected ? 'Live sync · 1s' : state ? 'Reconnecting…' : 'Connecting…'}</span>
        <div className="live-strip-right">{!host && <span className="readonly-label">READ ONLY {tv ? '/ TV' : '/ SPECTATOR'}</span>}
          {state && <span className={`status-label ${state.status}`}>{state.status}</span>}</div>
      </div>
      {!connected && <div className="connection-warning" role="alert">
        <strong>{state ? 'Connection interrupted. Showing the last known state.' : 'Connecting to your local auction server…'}</strong>
        <p>{auction.connectionError || 'Waiting for the first update.'} All host changes are disabled until live sync returns. Retrying automatically.</p>
        <button className="secondary" disabled={busy} onClick={() => void auction.refresh()}>Reconnect now</button>
      </div>}
      </>}
      {privateView && auction.error && <div className="alert error" role="alert">{auction.error}</div>}
      {host && authorized && auction.notice && <div className="alert success" role="status">{auction.notice}</div>}
      {privateView && auction.sessionError && <div className="alert error" role="alert">Cannot check host access: {auction.sessionError} <button className="text-button" onClick={() => void auction.refreshSession()}>Retry sign-in check</button></div>}
      {privateView && !session && !auction.sessionError && <p className="empty" role="status">Checking host session…</p>}
      {privateView && session && !session.authenticated && <Login disabled={busy || !session.csrf_token} onSubmit={auction.authenticate} tv={displayLogin} />}
      {host && authorized && <TvGuide disabled={!canMutate} />}
      {tv && authorized && <div className="tv-only-note"><span>Private TV display · read-only</span>
        <button type="button" className={`sound-toggle ${soundOn ? 'on' : ''}`} onClick={toggleSound} aria-pressed={soundOn}>
          {soundOn ? (soundUnlocked ? '🔊 Sound on' : '🔈 Click anywhere to enable sound') : '🔇 Sound off'}</button>
        <span>Move this window to the TV, then press F11 for full-screen.</span></div>}
      {!privateView && state && teamId !== null && <TeamDetail state={state} teamId={teamId} onBack={closeTeam} onOpen={switchTeam} onPlayer={setPlayerId} />}
      {authorized && state && (privateView || teamId === null) && <>
        <div className="overview-bar"><p><span className="eyebrow">{host ? 'Matchday operations' : 'Follow every signing'}</span></p>
          <div><span><strong>{state.teams.length}</strong> clubs</span><span><strong>{state.players.filter((p) => p.status === 'sold').length}</strong> signed</span><span><strong>{credits(state.players.filter((p) => p.status === 'sold').reduce((sum, p) => sum + (p.price ?? 0), 0))}</strong> points spent</span></div></div>
        {host && session?.authenticated && state.status === 'setup'
          ? <Setup state={state} disabled={!canMutate} save={save} remove={remove}
            configure={(size) => auction.action('configure', { squad_size: size })}
            setCaptain={(teamId, playerId, price) => auction.action('captain', { team_id: teamId, player_id: playerId, price })}
            removeCaptain={(teamId) => auction.action('remove_captain', { team_id: teamId })}
            start={() => setConfirmation({
              title: 'Ready to start the auction?', body: `This locks profile editing. Five teams will each build a squad of ${state.squad_size}. Make sure all names, positions and uploaded images are correct.`,
              confirm: 'Start auction', perform: () => { void auction.action('start', {}, state.version) },
            })} />
          : !tv && <Stage state={state} />}
        {host && session?.authenticated && state.status !== 'setup' && <HostControls state={state} disabled={!canMutate} action={auction.action}
          undo={() => setConfirmation({
            title: 'Undo the latest action?', body: 'Only the most recent reversible action is restored, including any bid, roster or budget changes. The reversal remains in the host audit trail. Check the latest entry below before continuing.',
            confirm: 'Undo latest action', perform: () => { void auction.action('undo', {}, state.version) },
          })}
          deleteAuction={() => setConfirmation({
            title: 'Delete this auction?',
            body: 'All sales, bids, the unsold list, open sets and auction history are cleared and every team gets its full 1000 points back. Players, photos, team names, logos, squad size and captains are kept, and the app returns to setup so you can start again. A backup of the current auction is saved on the server first.',
            confirm: 'Delete auction', requireText: 'DELETE', danger: true, perform: () => {
              const version = state.version
              void auction.mutate(async (csrf) => {
                await request('/api/auction/delete-auction', { method: 'POST', csrf, body: { confirm: 'DELETE', expected_version: version } })
              }, 'Auction deleted. Players, teams, squad size and captains were kept.')
            },
          })} />}
        {!privateView && <TeamBoard state={state} onOpen={openTeam} />}
        {!(host && session?.authenticated && state.status === 'setup') && !tv && <SetsBoard state={state} onPlayer={setPlayerId} />}
        {tv ? <div className="tv-layout">
          <div className="tv-main">
            <Stage state={state} />
            <SetsBoard state={state} onPlayer={setPlayerId} />
            <Results state={state} onPlayer={setPlayerId} />
          </div>
          <aside className="tv-side" aria-label="Squad watch" ref={tvSide}><TeamBoard state={state} compact /></aside>
        </div> : privateView && <TeamBoard state={state} />}
        {!(host && session?.authenticated && state.status === 'setup') && !tv && <Results state={state} onPlayer={setPlayerId} />}
        {host && session?.authenticated && <History version={state.version} />}
      </>}
      {authorized && !state && <section className="panel waiting-screen"><span className="eyebrow">Venoms FC / Matchday</span><h1>The room is warming up.</h1><p className="muted">Teams, live bids and signings will appear as soon as the local server connects.</p></section>}
    </main>
    <footer className="site-footer"><span>VENOMS FC <b>/</b> INTERNAL CUP · 3RD EDITION</span><span>{privateView ? tv ? 'Host-only TV · read-only' : 'Private host access' : 'Spectator view · no sign-in required'}{authorized && state ? ` · v${state.version}` : ''}</span></footer>
    {authorized && state && playerId !== null && <PlayerDialog state={state} playerId={playerId} onClose={() => setPlayerId(null)} />}
    {!host && authorized && state && <SoldCelebration state={state} sound={tv && soundOn && soundUnlocked} />}
    {host && authorized && confirmation && <ConfirmDialog title={confirmation.title} confirm={confirmation.confirm} onClose={() => setConfirmation(null)}
      requireText={confirmation.requireText} danger={confirmation.danger}
      onConfirm={confirmation.perform}><p>{confirmation.body}</p></ConfirmDialog>}
  </div>
}

export default App
