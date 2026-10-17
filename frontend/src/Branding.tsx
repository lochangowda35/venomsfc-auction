import { useState } from 'react'

export function AuctionBanner({ compact = false }: { compact?: boolean }) {
  return <section className={`auction-hero ${compact ? 'compact' : ''}`} aria-label="Official auction banner">
    <div className="hero-intro">
      <span className="eyebrow">Venoms FC / Internal Cup 03</span>
      <h2>Five teams.<br /><span>One legacy.</span></h2>
      <p>The rivalries start here. Follow every bid, every signing and the squads taking shape.</p>
      <div className="hero-pills"><span>1,000 points per team</span><span>One club. Five rivals.</span></div>
    </div>
    <div className="official-banner">
    <img src="/api/branding/auction-banner.jpg"
      alt="Venoms FC Internal Cup, 3rd edition — Welcome to the Auction. Vipers, Cobras, Pythons, Black Mambas and Anacondas."
      fetchPriority="high" />
    <div className="banner-caption"><span>Official auction night</span><strong>Third edition</strong></div>
    </div>
  </section>
}

export function TvGuide({ disabled }: { disabled: boolean }) {
  const [message, setMessage] = useState('')
  function openDisplay() {
    const popup = window.open('/display', 'venoms-private-tv', 'popup,width=1440,height=900')
    if (!popup) {
      setMessage('Your browser blocked the TV window. Allow pop-ups for this site and try again.')
      return
    }
    popup.focus()
    setMessage('TV window opened. Move it onto your TV using Windows + Shift + Left/Right Arrow, then press F11 in that window.')
  }
  return <section className="tv-guide panel" aria-labelledby="tv-guide-title">
    <div><span className="eyebrow">Host only / second screen</span>
      <h2 id="tv-guide-title">Your desk. Their big screen.</h2>
      <p className="muted">Keep auction controls on the laptop and the read-only display on your TV.</p></div>
    <button disabled={disabled} onClick={openDisplay}>Open TV display ↗</button>
    <details><summary>How to connect the TV with HDMI</summary>
      <ol>
        <li>Connect the HDMI cable and select the matching HDMI input on the TV.</li>
        <li>Press <kbd>Windows</kbd> + <kbd>P</kbd> and choose <strong>Extend</strong>, not Duplicate.</li>
        <li>Click <strong>Open TV display</strong>. Use the same browser profile so the window shares your host login.</li>
        <li>Move only the TV window with <kbd>Windows</kbd> + <kbd>Shift</kbd> + <kbd>Left/Right Arrow</kbd>, or drag it onto the TV. Keep the host desk on the laptop.</li>
        <li>Press <kbd>F11</kbd> in the TV window for full-screen. Both windows stay synchronized automatically.</li>
      </ol>
      <p>The website cannot detect your HDMI cable or force a window onto a physical display. Use Windows Display settings if the TV is not detected. When finished, move or close the TV window before unplugging HDMI.</p>
      <p>Signing out or session expiry locks both private views. The TV stays read-only even while you are signed in.</p>
    </details>
    {message && <p className="tv-window-message" role="status">{message}</p>}
  </section>
}
