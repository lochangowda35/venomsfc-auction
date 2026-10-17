import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, request } from './api'
import type { Action, ActionFields, AuctionState, Session } from './types'

export function useAuction(host: boolean, tv = false) {
  const privateView = host || tv
  const [state, setState] = useState<AuctionState | null>(null)
  const latest = useRef<AuctionState | null>(null)
  const [connected, setConnected] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [session, setSession] = useState<Session | null>(null)
  const sessionGeneration = useRef(0)
  const [sessionError, setSessionError] = useState('')
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const accept = useCallback((next: AuctionState) => {
    if (!latest.current || next.version >= latest.current.version) {
      latest.current = next
      setState(next)
    }
  }, [])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (privateView && !session?.authenticated) return
    try {
      const path = tv ? '/api/auction/display-state' : host ? '/api/auction/host-state' : '/api/auction/state'
      const next = await request<AuctionState>(path, { signal })
      if (signal?.aborted) return
      accept(next)
      setConnected(true)
      setConnectionError('')
    } catch (caught) {
      if (signal?.aborted) return
      if (caught instanceof ApiError && caught.status === 401) {
        sessionGeneration.current++
        setSession(null)
        setState(null)
        latest.current = null
        setSessionError('Your host session ended. Sign in again.')
      }
      setConnected(false)
      setConnectionError(caught instanceof Error ? caught.message : 'Connection lost.')
    }
  }, [accept, host, tv, privateView, session?.authenticated])

  const refreshSession = useCallback(async (signal?: AbortSignal) => {
    const generation = ++sessionGeneration.current
    try {
      const next = await request<Session>('/api/auth/session', { signal })
      if (!signal?.aborted && generation === sessionGeneration.current) {
        setSession(next)
        setSessionError('')
      }
    } catch (caught) {
      if (!signal?.aborted && generation === sessionGeneration.current) {
        setSession(null)
        setSessionError(caught instanceof Error ? caught.message : 'Unable to check host session.')
      }
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let timer: number
    const poll = async () => {
      await refresh(controller.signal)
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 1000)
    }
    void poll()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [refresh])

  useEffect(() => {
    if (!privateView) return
    const controller = new AbortController()
    let timer: number
    const poll = async () => {
      await refreshSession(controller.signal)
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 2000)
    }
    void poll()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [privateView, refreshSession])

  const mutate = useCallback(async (operation: (csrf: string) => Promise<void>, success: string) => {
    if (!host || working.current || !connected || !session?.authenticated || !session.csrf_token) return false
    working.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation(session.csrf_token)
      setNotice(success)
      await refresh()
      return true
    } catch (caught) {
      if (caught instanceof ApiError) {
        const details = Object.entries(caught.fields).map(([field, message]) => `${field}: ${message}`).join(' · ')
        setError(caught.status === 409
          ? `${caught.message} State refreshed. Review the current state and try again; nothing was automatically replayed.`
          : caught.status === 401
            ? 'Host session expired. Sign in again. Your action was not replayed.'
            : caught.status === 0
              ? `${caught.message} The outcome is unconfirmed. Reconnect and inspect the state/history before retrying.`
              : `${caught.message}${details ? ` · ${details}` : ''}`)
        if (caught.status === 401 || caught.status === 403) await refreshSession()
      } else setError(caught instanceof Error ? caught.message : 'Action failed.')
      await refresh()
      return false
    } finally {
      working.current = false
      setBusy(false)
    }
  }, [host, connected, session, refresh, refreshSession])

  const action = useCallback((name: Action, fields: ActionFields = {}, confirmedVersion?: number) => mutate(async (csrf) => {
    const current = latest.current
    if (!current) throw new Error('Wait for the auction to connect.')
    if (confirmedVersion !== undefined && current.version !== confirmedVersion) {
      throw new Error('The auction changed while confirmation was open. Review the latest state and confirm again.')
    }
    const next = await request<AuctionState>('/api/auction/actions', {
      method: 'POST', csrf,
      body: { action: name, expected_version: current.version, request_id: crypto.randomUUID(), ...fields },
    })
    accept(next)
  }, `${name === 'undo' ? 'Latest action reversed' : 'Auction updated'}.`), [mutate, accept])

  const authenticate = useCallback(async (password?: string) => {
    if (working.current || !session?.csrf_token) return
    working.current = true
    sessionGeneration.current++
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const next = await request<Session>(`/api/auth/${password === undefined ? 'logout' : 'login'}`, {
        method: 'POST', csrf: session.csrf_token,
        body: password === undefined ? undefined : { password },
      })
      sessionGeneration.current++
      setSession(next)
      // Logout responses need not contain a new token.
      if (!next.csrf_token) await refreshSession()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed.')
      await refreshSession()
    } finally {
      working.current = false
      setBusy(false)
    }
  }, [session, refreshSession])

  return {
    state, connected, connectionError, session, sessionError, busy, notice, error,
    refresh, refreshSession, mutate, action, authenticate,
    canMutate: host && connected && !!session?.authenticated && !!session.csrf_token && !busy,
  }
}
