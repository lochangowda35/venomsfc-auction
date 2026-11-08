# Disposable Railway trial

This test uses a separate **Venoms Cloud Test** project, a new PostgreSQL
database, generated sample players and a temporary Railway URL. Never upload
the real auction database, `backend/uploads`, `backend/backups` or `backend/.env`.
Do not change the production domain or subscribe during the trial check.

Use the repository's root Dockerfile and the existing feature branch containing
it, not `main`. Railway builds React, installs Python requirements, applies
migrations and starts Waitress. No system-wide Docker installation is needed on
the development laptop. The actual image must be built and verified on Railway;
local Python/frontend checks are not proof of a successful container build.

## Project settings

Create a fresh PostgreSQL service and a web service from this repository. Place
both in **Singapore**, with one replica each and **Serverless disabled**.
Keep the database private and use its private connection variables. Confirm its
major PostgreSQL version before any future migration; this disposable test does
not restore a production dump.

Mount a separate web volume at `/data`. Trial volumes are limited to 500 MB.
Railway mounts volumes as root; set `RAILWAY_RUN_UID=0` for this service so the
runtime can write its sample images. The Dockerfile otherwise runs as UID 10001.
Do not assume build-time directory ownership changes Railway volume ownership.

Web service variables:

| Variable | Value |
| --- | --- |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | References to the new Railway database's private variables |
| `HOST_PASSWORD_HASH` | A fresh hash of a separate disposable test password |
| `SECRET_KEY` | A fresh random test signing key |
| `SESSION_COOKIE_SECURE` | `1` |
| `TRUST_PROXY` | `1`, only for Railway's trusted ingress |
| `TRUST_CLOUDFLARE` | `0` |
| `UPLOAD_FOLDER` | `/data/uploads` |
| `BACKUP_FOLDER` | `/data/backups` |
| `ALLOW_MEDIA_RESTORE` | `0` |
| `RAILWAY_RUN_UID` | `0` |

Enter secret values through Railway's variable editor; do not paste them into
chat, commit them, or use the production password/signing key. Generate them
locally with Python's `getpass`, Werkzeug's `generate_password_hash` and
`secrets.token_hex(32)`.

Use `/api/ready` as the deployment health-check path with a 120-second timeout.
Choose restart-on-failure with at most 10 retries where the Trial permits it.
Keep the repository root directory selected, leave build/start command overrides
empty for normal operation, and disable automatic PR environments.
New services should use dashboard settings, not the deprecated `railway.json`.

### Optional image recovery

Keep `ALLOW_MEDIA_RESTORE=0` during the trial and normal operation.
The host-authenticated, CSRF-protected `PUT /api/media-restore/<name>` endpoint
is an opt-in recovery helper for restoring a missing image under its original
filename. It accepts one multipart `file` field, validates JPEG/PNG/WebP data
up to 5 MB and 16 million pixels, and preserves its exact bytes. It publishes
the complete file without overwriting an existing filename; storage failures
return 503. The upload filesystem must support hard links.

Enable it only during an approved recovery, verify restored files against
backup checksums, then disable it again. It is not a database restore endpoint
or a substitute for retained database-and-image backups. Do not use it to upload
real auction images to this disposable trial.

## Sample data and checks

Only for the first deployment of this empty test database, temporarily override
the start command to create clearly named sample players:

```sh
sh -c 'python -m flask --app app db upgrade && python -m flask --app app seed-demo --squad-size 1 --yes && exec python -m waitress --listen=0.0.0.0:$PORT --threads=4 --call app:create_app'
```

The existing seed command refuses to overwrite an auction with players or an
active auction. It creates five teams, seven sample players with generated photos,
and five 10-point captains. Once the first deployment succeeds, **remove this
start-command override and redeploy before using the host controls**. Otherwise,
the seed refusal will prevent later starts. Normal starts use the Dockerfile CMD,
which migrates but never seeds or resets data.

Generate a Railway-provided domain targeting the web service's listening port.
Do not add `venomsfc.in` or any other production hostname. Check:

1. `/api/ready` returns `{"status":"ready"}`, and the page shows only demo players.
2. The host can log in, run bids, complete the sample auction and make corrections.
   Spectators cannot modify auction data.
3. An uploaded sample photo and a profile edit survive a normal redeploy.
4. The URL loads on the laptop and on a phone using mobile data.
5. Railway usage/credit remaining and memory are acceptable for a paid production
   deployment. Stop test workloads after verification to conserve trial credits.

Do not describe the test as passed until the real cloud build, PostgreSQL,
uploads, host controls and redeploy persistence have been verified.

## Trial limitations

The trial provides $5 credit for up to 30 days, ending earlier when credits run
out. Some accounts have outbound network restrictions. Railway documents removal
of trial volumes 30 days after trial-credit expiry: do not keep important data
solely in a trial project.

Hobby is a separate approval after the test, with a $5/month minimum including
$5 of usage. Usage limits can shut down workloads, but do not promise an exact
rupee invoice cap. Production requires retained database-and-photo backups and a
verified restore, independent of this disposable test.
