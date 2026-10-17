# Venoms FC Auction

A local football-auction demo built with Flask/Python, React/TypeScript/Vite,
and PostgreSQL. It uses the official Venoms FC crest, auction banner and five
team logos in a midnight-blue liquid-glass theme, with restrained cyan, violet,
teal and gold accents and original decorative snake artwork.
It can be published at https://www.venomsfc.in from the laptop through a free
Cloudflare Tunnel (see [Going live](#going-live-on-wwwvenomsfcin)).

## Open the demo

With the development servers running:

| Page | Local URL |
| --- | --- |
| Host login, setup, and auction controls | http://127.0.0.1:5173/host |
| TV display (host password required, read-only) | http://127.0.0.1:5173/display |
| Mobile/spectator view (read-only) | http://127.0.0.1:5173/ |

Use the **host password** you configured, not a PostgreSQL password. There is no
username or public signup. Spectators cannot bid, even if a host session exists
in the same browser. The root URL always opens the public spectator view.
Both `/host` and `/display` require a host session before showing their content;
visiting `/display` while signed out prompts for login and returns to the TV view.
Signing out locks the private windows on their next access check.
The compact view menu in the top-right corner contains Spectator / Host sign-in
(or Host desk and Sign out when signed in). It stays in the header on mobile,
instead of taking a separate full-width row. Press Escape or click outside to
close it. Budgets, bids, sales and CSV exports use **points**, not credits/CR;
the starting budget remains **1000 points per team**.
On the spectator view, click any team card to open its read-only team page
(`/?team=<id>`): logo, remaining/spent/max-bid points, squad progress, position
counts, and every signed player with photo, position and price. It updates live.
Use **← All teams**, Escape, or the browser Back button to return; the chips at the
top switch between teams. Host and TV team cards stay non-clickable.
These loopback URLs work only on this computer; viewing on another physical phone
or TV over Wi-Fi needs a separately reviewed LAN configuration. For the public
site, see [Going live](#going-live-on-wwwvenomsfcin).

## Going live on www.venomsfc.in

The public site runs on this laptop and reaches the internet through a free
**Cloudflare Tunnel**. Visitors open www.venomsfc.in, Cloudflare forwards each
request through the tunnel to the app on the laptop, and the data comes from the
laptop's PostgreSQL database. No data is copied anywhere else.

One-time setup (already done for venomsfc.in):

1. Domain registered at Namecheap, with nameservers pointed to Cloudflare (free plan).
2. `cloudflared` installed (`winget install Cloudflare.cloudflared`).
3. `cloudflared tunnel login`, `cloudflared tunnel create venomsfc`, then
   `cloudflared tunnel route dns venomsfc www.venomsfc.in` (and `venomsfc.in`).
4. `%USERPROFILE%\.cloudflared\config.yml` routes both hostnames to
   `http://127.0.0.1:5000`. The tunnel credentials there are secret and are never
   committed.

To go live, run from the project folder and keep the window open:

```powershell
.\start-public.ps1
```

It builds the frontend, applies migrations, checks the database, starts the
tunnel and serves the app with Waitress (a production web server). Ctrl+C stops
both. In public mode the host cookie is HTTPS-only, so sign in as host at
https://www.venomsfc.in/host (not 127.0.0.1), and login throttling applies to each
visitor separately (`TRUST_CLOUDFLARE=1`).

The site is only online while the laptop is on, awake and connected. On auction
day keep it plugged in with sleep turned off.

### Laptop host desk + HDMI TV

1. Connect HDMI and select that HDMI input on the TV.
2. Press **Windows + P** and choose **Extend**, not Duplicate.
3. Sign in at `/host` on the laptop. Click **Open TV display** (allow this site's
   pop-ups if prompted). This opens a separate read-only window using the same
   browser profile and host session.
4. Move that window onto the TV: drag it, or press **Windows + Shift + Left/Right
   Arrow**. Leave the host desk on the laptop.
5. Press **F11** in the TV window for full-screen. Both views update automatically.
   Move or close the TV window before disconnecting HDMI.

Browsers cannot reliably detect HDMI or force windows onto a physical TV.
The display is available to an authenticated host even without a cable; Windows
controls where the window appears. Duplicate mode would show the host desk on
both screens, so use Extend. An expandable guide is included on the host desk.

The TV display uses the full screen width: the live auction and sets on the left,
and a **Squad Watch** column with all five teams on the right. The column stretches
to fill the full screen height, so there is no empty space below it on big TVs,
and it stays visible without scrolling down to 1280×720. When a player
is sold, the TV and spectator views show a 15 second **SOLD** overlay with the
player photo, buying team logo/name and price. When a player goes unsold, a
5 second **UNSOLD** overlay appears. Tap either to dismiss it early. The host desk
does not show them. Results that already happened before a page loads do not replay.

The TV plays a short fanfare and crowd cheer on SOLD and a soft tone on UNSOLD.
Browsers block sound until you interact with the page, so click the TV window or press
any key once (pressing F11 for full-screen counts). The **Sound on/off** button at the
top of the TV view toggles it. The TV quietly preloads every player photo and team logo
in the background so pictures appear instantly; phones preload only the open set to
save mobile data.

### Official branding and preset teams

**BlackMambas, Cobras, Vipers, Pythons and Anacondas** have fixed official names
and logos. They are not editable/deletable through the host desk or API.
Player creation, uploaded photos, corrections, squad size, and all auction rules
are unchanged. The full original banner is shown without cropping its lettering;
live TV uses a compact version to leave space for the auction.
Desktop uses a balanced introduction/banner layout; mobile stacks the content.
Glass surfaces use translucent fills, highlights and background blur, with
high-opacity readable fills even when blur is unavailable. The bundled snake
illustration is decorative, non-interactive and has no animation or remote
dependency. The official banner artwork itself is unchanged.
BlackMambas and Vipers use tightly framed 800-pixel square display copies to
remove the excess side background from the landscape originals. The complete
crests remain intact, with light contrast/sharpening and larger logo tiles across
setup, spectator, bidding and TV views. Originals and stored team records are
preserved; display copies do not invent missing image detail.

Fonts are bundled locally under `frontend\src\assets\fonts`, so the demo needs no
Google Fonts connection:

| Use | Font | License / source |
| --- | --- | --- |
| VENOMS FC, main titles and on-stage player names | Permanent Marker, a free brush-style alternative | Apache 2.0, Font Diner |
| Section headings, team names and position labels | Bebas Neue | SIL Open Font License 1.1, Dharma Type |
| Descriptions, rules and controls | Montserrat | SIL Open Font License 1.1, The Montserrat Project |

Files come from the [Google Fonts repository](https://github.com/google/fonts)
(`apache/permanentmarker`, `ofl/bebasneue`, `ofl/montserrat`); the unmodified
license texts are included beside each font. Permanent Marker is not Blackhawk
or Brusher and is used as a licensed visual alternative. The exact poster font
cannot be recovered from a JPEG; original banner lettering stays intact.

## Start locally (Windows PowerShell)

Prerequisites: Python 3.10+, Node.js 22 LTS/npm, PostgreSQL 18 running on
`127.0.0.1:5432`. Development used Python 3.13.1 and Node.js 22.13.1.
Run commands from this repository, never the original checkout.

**Existing setup:** run `.\start-demo.ps1` from the repository root. It builds
the frontend, applies migrations, verifies PostgreSQL, safely prepares the five
official teams, and starts the entire demo at **http://127.0.0.1:5000/** with one
terminal. It does not install dependencies, create sample players, or erase data.
Existing unrelated team records cause an explicit stop rather than replacement.
The two-server development alternative is below.

First-time dependencies:

```powershell
python -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
Set-Location frontend
npm ci
```

The Python environment is project-local; activation is unnecessary.

Terminal 1, from the repository root:

```powershell
Set-Location backend
.\.venv\Scripts\python.exe -m flask --app app db upgrade
.\.venv\Scripts\python.exe -m flask --app app db-check
.\.venv\Scripts\python.exe -m flask --app app prepare-official-teams
.\.venv\Scripts\python.exe -m flask --app app run --host 127.0.0.1 --port 5000
```

Terminal 2, from the repository root:

```powershell
Set-Location frontend
npm run dev
```

Stop servers with Ctrl+C. Keep ports 5000 and 5173 unchanged when using Vite.
Vite forwards `/api` to Flask. Alternatively, build with `npm run build` in
`frontend`, then run just Flask and open **http://127.0.0.1:5000/host**,
**http://127.0.0.1:5000/display**, or **http://127.0.0.1:5000/**. Flask serves
the built assets locally. `npm run preview` alone is not a full API server.

## Demo walkthrough

1. Sign in at `/host`. The five official teams and logos are already prepared.
2. Add players with names, uploaded photos, and **GK / DEF / MID / ST** positions.
   Edit or delete setup records to correct mistakes.
3. Set the same squad size for all five teams. At least `5 * squad size`
   players are required.
4. **Captains:** in the Captains panel, pick each team's captain from the
   player pool and enter the captain price (a multiple of 10, from 10 up to
   `1000 - 10 * (squad size - 1)`). The price comes out of that team's 1000
   points and the captain fills one squad slot. Captains are not auctioned.
   All five captains are required before **Start**.
5. **Sets:** players are grouped into Set 1 Goalkeepers, Set 2 Defenders,
   Set 3 Midfielders, Set 4 Strikers, plus a final Unsold set. With no set
   open, TV and spectators see every set. The host opens any set (any order);
   the live auction then sits on top with only that set below it. Sets can be
   switched or closed whenever no player is on the floor.
6. Select the next player from the open set, or draw one at random. Click a team's
   bid control to place the opening **10-point** bid; every subsequent bid is
   **exactly +10**, with no jump bids or consecutive bids by the leading team.
7. Mark **SOLD** to the leading team, or **UNSOLD**. Unsold players can be
   re-listed or selected again. Pause/resume when needed.
8. Each team starts with **1000 points**. The server reserves **10 points per
   remaining slot after a purchase** and prevents bids from full squads.
   There are no position quotas. Team cards label this as
   "10 reserved per open slot" under **Max bid**.
9. Undo reverses the latest dependent auction action first: a sale restores
   its player, bid, budget, and roster; further undos reverse prior bids and
   selection. Actions stay in the host audit history. Unsafe undo conflicts
   are explicit and do not overwrite later setup changes.
10. The auction completes when all five squads are full. Extra profiles can
   remain unauctioned. Results and rosters remain available. Clicking any
   player card opens a popup with every bid of the round that sold them, in order.

Profile edits are locked after start. To correct setup then, unwind dependent
auction actions and the start action first. Reloading or restarting does not reset the auction.

**Delete auction (host desk).** Once an auction has started, the bottom of the host
controls has a red **Delete auction…** button. You must type `DELETE` to confirm.
It clears all sales, bids, the unsold list, open sets and auction history, and gives
every team its 1000 points back. It keeps players, photos, team names, logos, squad
size and captains, and returns to setup so you can start again straight away. A
JSON backup is written to `backend\backups` first. This cannot be undone from the app.

**Download backup (host desk).** The History section has a **Download backup** button
that saves one JSON file with all teams, players, captains, sales, bids and history to
the laptop. Download one before and after auction day as a safety copy and record.

If a test auction was started but nothing has been sold yet, the organiser can
return it to setup from `backend` with
`.\.venv\Scripts\python.exe -m flask --app app return-to-setup`. It asks for
confirmation, refuses once any player is sold, keeps profiles, squad size and
captains, writes a JSON backup to ignored `backend\backups`, and logs the change.

To wipe a finished or test auction completely (sales, bids, unsold list, open
set, history, captains and squad size), run
`.\.venv\Scripts\python.exe -m flask --app app reset-auction` from `backend`.
It asks for confirmation (`--yes` skips it), writes a JSON backup to
`backend\backups` first, and keeps all player profiles/photos, the five teams
and logos, and the host password. Set the squad size and captains again afterwards.

### Optional sample data (never automatic)

For an unused setup with **no players** and either no teams or just the official
five, from `backend`:

```powershell
.\.venv\Scripts\python.exe -m flask --app app seed-demo
```

Confirm the prompt. This preserves/prepares the official teams and adds clearly
named demo players with generated placeholder photos, squad size 2, and two
extra players. `--squad-size 1` makes a shorter five-sale demo. The command refuses
if players or unrelated teams exist, or the auction is not in setup mode.
It does not start the auction or set a password.
No sample players are created by startup, migrations, or opening a page.

## Database and password setup on a fresh computer

Install PostgreSQL Server and Command Line Tools. pgAdmin is optional; skip
Stack Builder downloads. Keep the `postgres` administrator password private.
Open a PostgreSQL administrator session:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d postgres -W
```

Run once inside `psql` (not again if they already exist):

```sql
CREATE ROLE venomsfc_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE venomsfc_auction OWNER venomsfc_app;
```

Set the app password with `\password venomsfc_app`, then exit with `\q`.
From `backend`:

```powershell
.\.venv\Scripts\python.exe -m flask --app app configure-db
.\.venv\Scripts\python.exe -m flask --app app db upgrade
.\.venv\Scripts\python.exe -m flask --app app configure-host
```

`configure-db` privately prompts for the **app database password**, verifies
the connection, and saves settings in ignored `backend\.env`.
`configure-host` prompts for a separate **host password of 12-256 characters**,
stores a scrypt hash and random signing key, and revokes old host sessions.
Restart Flask after changing settings. Existing process environment variables
override `.env`; Flask CLI loads the file when run from `backend`.
Never put `postgres` administrator credentials in app settings.

## What each part does

| Part | Purpose |
| --- | --- |
| `frontend` | React forms and displays; TypeScript catches type mistakes; Vite runs the local UI. |
| `backend/app.py` | Creates Flask and wires routes, settings, and CLI commands. |
| `backend/auth.py` | Single-host password, CSRF checks, cookie sessions, and login throttling. |
| `backend/profiles.py` / `media.py` | Validated team/player setup, corrections, and persistent image uploads. |
| `backend/branding.py` / `assets/branding` | Official bundled images and safe, idempotent team presets. |
| `backend/auction.py` | Server-side auction rules, transactions, version checks, idempotency, and undo. |
| `backend/models.py` | Profile, session, auction-state, and audit-event database records. |
| `backend/migrations` | Versioned database structure changes, applied using `flask db upgrade`. |

State and audit history persist in PostgreSQL. Spectators poll a sanitized public
state endpoint once per second; host and TV views use session-protected endpoints.
All reconnect after interruptions, and private views recheck access regularly. Version checks
reject stale host commands; unique request IDs prevent a retried auction command
from being applied twice. PostgreSQL serializes mutations, including concurrent
bids, start, and profile edits.

### Images and backups

Upload actual JPEG, PNG, or WebP files, at most 5 MB / 16 million pixels each.
The backend validates decoded image contents, strips metadata, resizes to at most
1600 pixels per side, and stores re-encoded JPEGs under ignored `backend\uploads`.
SVGs and arbitrary file paths are rejected. Official team logos are bundled
unchanged in `backend\assets\branding`, not duplicated as uploads. Player names
can repeat; generated IDs identify records. Players have no count cap.

Keep **PostgreSQL backups**, **`backend\uploads`**, and **`backend\.env`** safe.
The database and upload folder belong together; losing an image file cannot be
repaired from its database reference alone. Replacing/deleting profiles does not
delete old image files; automatic orphan cleanup is not implemented.
`.env` is private local configuration, not an encrypted vault. Do not share it,
commit it, display its contents, or put secrets in frontend environment variables.

## API overview

| Access | Endpoint |
| --- | --- |
| Public | `GET /api/auction/state`, `GET /api/media/<generated-name>` |
| Public | `GET /api/branding/<allowlisted-official-file>` |
| Session | `GET /api/auth/session`, `POST /api/auth/login`, `POST /api/auth/logout` |
| Host only | `GET /api/teams`, `GET/POST /api/players`, `PUT/DELETE /api/players/<id>` |
| Host only | `GET /api/auction/host-state`, `GET /api/auction/display-state` |
| Host only | `POST /api/uploads`, `GET /api/auction/history`, `POST /api/auction/actions` |
| Host only | `GET /api/auction/backup` (downloads a full JSON backup) |
| Host only | `POST /api/auction/delete-auction` (body `{"confirm": "DELETE", "expected_version": n}`) |

Cookie-authenticated writes require `X-CSRF-Token` from session/login.
Auction actions require `{action, expected_version, request_id, ...action_fields}`.
The server supports `configure`, `captain`, `remove_captain`, `start`,
`open_set`, `close_set`, `select`, `random`, `bid`, `sold`,
`unsold`, `reauction`, `pause`, `resume`, and `undo`.
Malformed input returns 400, unauthenticated host access 401, CSRF failure 403,
stale/conflicting actions 409, oversized uploads 413, and database failures 503.
Team mutation attempts return 409 because the five official identities are fixed.
Profile errors include field messages. State/auth/host responses are not cached.
Public state does not include password hashes, session tokens, or audit snapshots.

Host sessions expire after eight hours, are not extended by activity, and are
revoked on logout. The five-attempts/minute/IP login throttle is in-memory and
resets on restart. This is a **single-computer local demo**, not production
authentication: public deployment needs HTTPS, `SESSION_COOKIE_SECURE=1`, a
production server, shared rate-limit storage, backups, and deployment review.
No Socket.IO service is required; updates use one-second HTTP polling.

## Checks

From the repository root:

```powershell
backend\.venv\Scripts\python.exe -m unittest discover -s backend -v
Set-Location frontend
npm run build
npm run lint
npm test
```

Opt-in real PostgreSQL suite, from `backend`:

```powershell
$env:RUN_POSTGRES_TESTS='1'
.\.venv\Scripts\python.exe -m unittest test_postgres.PostgreSQLAuctionTests -v
Remove-Item Env:\RUN_POSTGRES_TESTS
```

The integration suite creates uniquely named isolated schemas and temporary
upload folders, applies real migrations, and removes them afterward. It exercises
all five squads, +10 bidding, reserve budgets, capacity, sale/unsold/reauction,
undo, stale/idempotent/concurrent commands, and application restart recovery
without changing real auction records. Do not point generic tests or browser
automation at a live auction.

### Browser checks

From `frontend`, `npm run test:e2e` runs mocked browser tests without changing the
database. On Windows it uses installed Microsoft Edge; on other systems install
Playwright's Chromium with `npx playwright install chromium`.

To check the running UI without modifying auction records, set
`AUCTION_E2E_URL=http://127.0.0.1:5000` and `AUCTION_E2E_PRESENTATION=1` in the
test terminal, then run `npm run test:e2e -- presentation`. This confirms the
square crest images, actual locally loaded fonts, blue/light themes, and layouts
from 320 to 1920 pixels. It also checks that the page makes no external requests.

The opt-in real-browser workflow requires a **disposable** PostgreSQL schema,
never the live auction. In a separate PowerShell terminal, from the repository root:

```powershell
$schema = 'browser_check_' + [guid]::NewGuid().ToString('N').Substring(0,24)
$env:BROWSER_TEST_PASSWORD = [guid]::NewGuid().ToString('N')
$env:BROWSER_TEST_SIGNING_KEY = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
Write-Host "Disposable schema: $schema"
# Copy these ephemeral values privately to the test terminal, not chat or Git.
backend\.venv\Scripts\python.exe backend\browser_test_server.py --schema $schema --port 5001
```

Build the frontend first. In the test terminal, set `AUCTION_E2E_URL` to
`http://127.0.0.1:5001`, `AUCTION_E2E_MUTATE` to `1`, and
`AUCTION_E2E_PASSWORD` to that ephemeral test password; then run
`npm run test:e2e` from `frontend`. The real-server test refuses port 5000 and
requires empty profile tables unless its explicit test-fixture reuse flag is set.
It uploads generated test images, creates only clearly named fixture profiles,
and exercises the UI in separate host/TV/mobile pages.

For the **official branding/private TV** check instead, start a new disposable
schema with `$env:BROWSER_TEST_OFFICIAL_TEAMS = '1'` set in the server terminal.
In the test terminal set `AUCTION_E2E_URL` and `AUCTION_E2E_PASSWORD` as above,
then `$env:AUCTION_E2E_OFFICIAL = '1'` and run
`npm run test:e2e -- official-server`. This checks the real official images,
fixed team controls, spectator default, login return destination, shared-session
TV popup, and logout revocation across windows. It does not start an auction.

Afterward stop the disposable server with Ctrl+C and run, in its original terminal:

```powershell
backend\.venv\Scripts\python.exe backend\browser_test_server.py --schema $schema --cleanup
Remove-Item Env:\BROWSER_TEST_PASSWORD
Remove-Item Env:\BROWSER_TEST_SIGNING_KEY
```

This drops only the explicitly named `browser_check_<24 hex characters>` schema
and its exact temporary upload folder. The test server refuses other schema names.
