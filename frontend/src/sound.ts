/** Synthesised stadium sounds (no audio files). Browsers only allow sound after a click or key press on the page. */
let context: AudioContext | null = null

function audio() {
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    context = new Ctor()
  }
  return context
}

export function soundReady() {
  return context?.state === 'running'
}

/** Call from a click/key handler to unlock sound for the rest of the session. */
export async function unlockSound() {
  const ctx = audio()
  if (ctx && ctx.state !== 'running') await ctx.resume().catch(() => undefined)
  return soundReady()
}

function crowd(ctx: AudioContext, start: number, length: number, peak: number) {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * length), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const noise = ctx.createBufferSource()
  noise.buffer = buffer
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = 1100
  band.Q.value = 0.6
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.5)
  gain.gain.setValueAtTime(peak, start + length * 0.55)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length)
  noise.connect(band).connect(gain).connect(ctx.destination)
  noise.start(start)
  noise.stop(start + length)
}

function horn(ctx: AudioContext, start: number, frequency: number, length: number, volume: number) {
  const osc = ctx.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.value = frequency
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 1800
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.04)
  gain.gain.setValueAtTime(volume, start + length - 0.08)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length)
  osc.connect(tone).connect(gain).connect(ctx.destination)
  osc.start(start)
  osc.stop(start + length)
}

/** Short brass fanfare plus a crowd roar (~3s). */
export function playSold() {
  const ctx = audio()
  if (!ctx || ctx.state !== 'running') return
  const t = ctx.currentTime + 0.05
  ;[[392, 0, 0.16], [523, 0.17, 0.16], [659, 0.34, 0.16], [784, 0.51, 0.7]].forEach(([f, at, len]) => {
    horn(ctx, t + at, f, len, 0.09)
    horn(ctx, t + at, f * 1.5, len, 0.035)
  })
  crowd(ctx, t + 0.4, 2.8, 0.35)
}

/** Soft descending two-note tone for UNSOLD. */
export function playUnsold() {
  const ctx = audio()
  if (!ctx || ctx.state !== 'running') return
  const t = ctx.currentTime + 0.05
  horn(ctx, t, 330, 0.28, 0.05)
  horn(ctx, t + 0.3, 247, 0.5, 0.05)
}
