import { useEffect, useRef } from 'react'
import { portraitPath, setPool } from './auction'
import type { AuctionState } from './types'

/**
 * Quietly downloads player photos and team logos in the background so cards and the
 * SOLD overlay appear instantly. The TV loads every photo; phones only load the open set
 * to save mobile data.
 */
export function usePreloadImages(state: AuctionState | null, everything: boolean) {
  const done = useRef(new Set<string>())
  const keep = useRef<HTMLImageElement[]>([])
  useEffect(() => {
    if (!state) return
    const players = everything ? state.players : state.open_set ? setPool(state, state.open_set) : []
    const paths = [...state.teams.map((t) => t.logo_path), ...players.map((p) => p.photo_path)]
      .filter((path) => path && !done.current.has(path))
    if (!paths.length) return
    const run = () => paths.forEach((path) => {
      done.current.add(path)
      const image = new Image()
      image.decoding = 'async'
      image.src = portraitPath(path)
      keep.current.push(image)
    })
    const idle = window.requestIdleCallback
    if (idle) {
      const id = idle(run, { timeout: 2000 })
      return () => window.cancelIdleCallback(id)
    }
    const timer = window.setTimeout(run, 300)
    return () => window.clearTimeout(timer)
  }, [state, everything])
}
