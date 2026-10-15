# WA Campaign Panel

Multi-tenant WhatsApp + voice-call campaign panel with three roles — **Admin → Reseller → Customer** — built with
React (Vite) + Express + MongoDB (Mongoose).

```
wa-panel/
├─ backend/    Express API, Mongoose models, queue worker, providers, tests, live e2e script
├─ frontend/   React + Vite app (the API also serves frontend/dist in production)
└─ docs/API.md API reference
```

## 1. Who can do what

| | Admin | Reseller | Customer (final client) |
|---|---|---|---|
| Create resellers | yes | – | – |
| Create customers | yes (directly, or under a reseller) | yes (always under themselves, up to their limit) | – |
| Add / reclaim credits | creates credits for anyone | moves credits from own wallet to own customers | – |
| Own campaign workspace (contacts, templates, media, WhatsApp, campaigns, voice calls) | **no** (management only) | **yes**, same panel as a customer | **yes** |
| Calling settings + CLI (caller-ID) numbers | yes | – | uses the CLI numbers given to them |
| Platform settings, audit log | yes | own activity | own activity |

Every workspace query is scoped to the signed-in user, so one tenant never sees another's contacts, campaigns, media or credits.

## 2. Requirements

- Node.js 20+ (tested on 22)
- MongoDB 6/7 locally **or** a free MongoDB Atlas connection string

## 3. Run (development)

```bash
# --- Backend (terminal 1) ---
cd backend
cp .env.example .env          # Windows: copy .env.example .env
# edit .env: MONGODB_URI, JWT_SECRET, ENCRYPTION_KEY (>= 32 chars each)
npm install                   # also installs the optional QR library (@whiskeysockets/baileys)
npm run seed:demo             # admin + demo reseller + demo customer
npm start                     # API on http://localhost:5000

# --- Frontend (terminal 2) ---
cd frontend
npm install
npm run dev                   # UI on http://localhost:5173
```

If you see `querySrv ECONNREFUSED` with an Atlas `mongodb+srv://` URI, add `DNS_SERVERS=8.8.8.8,8.8.4.4` to `.env`.

| Role | Email | Password | Opens |
|---|---|---|---|
| Admin | `ADMIN_EMAIL` from `.env` | `ADMIN_PASSWORD` from `.env` | `/admin` |
| Reseller (demo) | `reseller@demo.test` | `Demo@12345` | `/reseller` |
| Customer (demo) | `customer@demo.test` | `Demo@12345` | `/app` |

Everybody signs in on the same login page; the panel opens by role.

## 4. Updating an older copy

1. Copy the new `backend/` and `frontend/` folders over the old ones (keep your own `backend/.env`).
2. `cd backend && npm install` and `cd ../frontend && npm install` (new libraries: multer, qrcode, sharp, baileys).
3. Compare your `.env` with `.env.example` and add any new keys (see section 6).
4. Restart the backend and the frontend. Existing database records keep working.

## 5. Features and how to check them (about 15 minutes)

1. **Admin → Resellers → + New reseller**; **Admin → Customers → + New customer** (pick "None" or a reseller). **Credits** button on any row adds credits.
2. **Reseller** (sign in with the new account): **My customers → + New customer**, then **Credits** to move credits to that customer. The sidebar section **My campaigns** is the reseller's own workspace.
3. **Customer / reseller → WhatsApp**: Mock (simulation, free), Meta Cloud API (official), or **Linked phone — scan a QR code**.
4. **Media library / Templates**: upload an image (5 MB), video, PDF or audio (16 MB). In **Templates**, set optional header text separately, write a body/caption, then choose **None / Image / Video / Document** under **Attachment** and upload or pick a library file. A media-only template may leave the body empty for Mock/QR; Meta requires body text.
5. **Contacts** (CSV import with preview, groups, duplicates, opt-out) → **Templates → Submit for review → Sync status** → **Campaigns → + New campaign → Check campaign → Start now**. In mock mode statuses are `simulated_*` and credits are not used. Numbers ending `0000` always fail in mock mode.
6. **Voice calls → + New call campaign**: choose contacts, audio/text, CLI number; runs on the mock voice provider until the admin plugs in an API.
7. **Admin → Calling & CLI**: add CLI (caller-ID) numbers (validated, unique, available to everyone or reserved for one account); configure the voice API: URL, method, headers and body templates with placeholders (`{{to}} {{cli}} {{audio_url}} {{text}} {{name}} {{message_id}}`), API key (stored encrypted), response path for the call id, and the vendor's webhook URL. **Run mock test** exercises the flow without a vendor.
8. **Credits** page (customer/reseller): balance and ledger. Mock campaigns are free; real WhatsApp messages cost `creditsPerMessage` and real calls `creditsPerCall` (Admin → Settings). Failed real sends are refunded; a campaign pauses when credits run out.
9. **Usage**, **Activity log**, **My account**, password reset, suspension (blocks sign-in immediately), responsive layout on phones.

## 6. Environment (`backend/.env`)

| Key | Meaning |
|---|---|
| `NODE_ENV`, `PORT` | Runtime mode (`development`, `test`, or `production`) and API listen port (local default `5000`; Render provides `PORT`) |
| `MONGODB_URI` | MongoDB / Atlas connection string (with database name, e.g. `.../wa_panel`) |
| `JWT_SECRET`, `ENCRYPTION_KEY` | ≥ 32 random characters each. Do not change `ENCRYPTION_KEY` later — saved API keys/tokens become unreadable |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | First admin bootstrap only; changing these later does not change an existing account |
| `CLIENT_URL` | Explicit permitted browser origins for CORS; comma-separated if needed. First origin is used for password-reset links |
| `PUBLIC_API_URL` | Public API origin used to construct webhook and media URLs |
| `ALLOW_REAL_SEND` | Master switch for **real** sending (QR phone, Meta, voice API). `false` = only the mock providers work |
| `DATA_DIR` | Where uploaded media and linked-phone sessions are stored (default `backend/data`). Use a persistent disk in production |
| `DNS_SERVERS` | Optional, e.g. `8.8.8.8,8.8.4.4` when your DNS refuses Atlas SRV lookups |
| `WORKER_*`, `TRUST_PROXY`, `SMTP_*`, … | See `.env.example` |

## 7. Production

```bash
cd frontend && npm install && npm run build
cd ../backend && NODE_ENV=production npm start     # serves the built UI too
```
Use strong secrets, `PUBLIC_API_URL` = your https URL, `TRUST_PROXY=1` behind a proxy, SMTP for reset emails, a persistent `DATA_DIR`,
and run **one** API instance (the queue worker and linked-phone sessions live inside the API process).

### Deploy the frontend on Vercel and keep the API on Render

- In Vercel, import this repository and set the **Root Directory** to `frontend`.
- Use the Vite framework preset, build command `npm run build`, and output directory `dist`.
- Add the Vercel project environment variable `VITE_API_URL=https://wa-panel-1.onrender.com` (backend origin only; do not include `/api`). This value is public in the frontend bundle; never put credentials or secrets in a `VITE_*` variable.
- In Render's backend service, set `NODE_ENV=production`, `CLIENT_URL=https://wa-panel-five.vercel.app`, and `PUBLIC_API_URL=https://wa-panel-1.onrender.com`. Do not add localhost to the production allowlist. `CLIENT_URL` is also used to build password-reset links. CORS preflight is handled before routes and explicitly permits GET, POST, PUT, PATCH, DELETE, OPTIONS, and the Content-Type/Authorization headers.
- Keep `MONGODB_URI`, `JWT_SECRET`, `ENCRYPTION_KEY`, `ADMIN_PASSWORD`, and any WhatsApp/SMTP credentials exclusively in Render's backend environment settings. Use unique strong values, never example or local values. Set `RESET_RETURN_LINK=false` and `TRUST_PROXY=1` on Render. Render supplies `PORT`; the server reads it automatically.
- Local development uses `backend/.env` with `CLIENT_URL=http://localhost:5173` and `PUBLIC_API_URL=http://localhost:5000`. Leave `VITE_API_URL` unset in local frontend development: Vite sends relative `/api` requests through its development proxy to `http://localhost:5000`. `frontend/.env.example` documents the production-only Vercel value.
- Backend dotenv loading resolves `backend/.env` from the source location, so `npm start` works whether launched from the repository root or `backend/`. Production startup rejects missing/non-HTTPS frontend and public API origins, localhost origins, and example secrets.
- `frontend/vercel.json` rewrites app routes to the Vite entry point so direct visits and refreshes on React Router routes work.

### Secret rotation after exposure

Treat previously shared database credentials, the admin password, `JWT_SECRET`, and `ENCRYPTION_KEY` as exposed. Rotate the database password/provider credential, update `MONGODB_URI` in Render, and change the existing admin password through the application (the `ADMIN_PASSWORD` environment variable only bootstraps a new admin). Changing `JWT_SECRET` invalidates existing login tokens, so users must sign in again. Do **not** simply replace `ENCRYPTION_KEY`: saved WhatsApp/provider credentials are encrypted with it. Back up the database, re-encrypt stored credentials from the old key to the new key with a deliberate migration, verify decryption, and only then switch the Render value. The existing encryption key is intentionally not changed automatically.

## 8. Automated verification

```bash
cd backend
npm run lint
npm test                         # integration suite needs local MongoDB (TEST_MONGODB_URI overrides the local default)
npm start                        # terminal 1
node scripts/e2e-live.js         # terminal 2: 110 live HTTP checks (workflows 1-12)
# restart the API, then:
node scripts/e2e-live.js --after-restart
cd ../frontend && npm run lint && npm run build
```

## 9. Status report

## 10. Company WhatsApp API (HTTP) go-live checklist

The generic HTTP provider is configured once at **Admin → WhatsApp API**. The ready-made sms4power (wtap) preset uses GET and its documented `apikey`, `mobile`, `msg`, `pdf`, `img1`, `img2`, and `country` parameters. Its provided URL uses plain HTTP, so the key, number and message are not encrypted in transit; use the vendor's HTTPS endpoint if they offer one. The admin enters the vendor key in the password field; it is encrypted in the database and never returned to customer accounts.

This provider sends text or a caption plus one image or one PDF per template. Video/audio are unsupported. If a vendor rejects an empty `msg` for media-only sends, configure the optional fallback caption; it is blank by default. A message costs `max(1, media count) × creditsPerMessage`; because this panel currently supports one template attachment, text-only, image and PDF sends each cost one `creditsPerMessage`. The worker pauses between messages (default 1 second; configurable at **Admin → Settings**). The provider reports `sent` after vendor acceptance only: there are no delivery/read receipts or inbound STOP replies, so include your own opt-out instruction and manage opt-outs manually.

The vendor must be able to download media from a public HTTPS `PUBLIC_API_URL`. A localhost/private address blocks media campaign validation; text-only sending does not require a public media URL. To expose local media, install/run cloudflared or ngrok as described below, confirm the HTTPS URL, then set `PUBLIC_API_URL` in `backend/.env` and restart the API. Free tunnel URLs can change on restart, so update the setting when they do.

The smoke script uses the admin session and sends one **real** text test message. Set credentials only in your terminal environment; never put API keys or login values in this file. It prints the test endpoint response with API-key values redacted. `E2E_WA_HTTP_TEST_URL` can override the default endpoint.

```powershell
# Set E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, and TEST_NUMBER in this terminal without echoing their values.
# Optional variables: TEST_MESSAGE, E2E_API_URL, E2E_WA_HTTP_TEST_URL.
node backend/scripts/wa-http-smoke.js
```

### Go-live checklist

- [ ] Admin → WhatsApp API → **Use sms4power (wtap) preset** → enter the API key in the admin screen → Save.
- [ ] Use **Send test message** with your own number and text only.
- [ ] Review the raw test response; share its body with the operator if success detection needs adjustment. The smoke script redacts API-key fields.
- [ ] Sign in as the demo customer → WhatsApp → choose **Company WhatsApp API** → **Test connection**.
- [ ] Add a small credit balance and create 2–3 contacts that are your own numbers.
- [ ] Run a small campaign with text only, then try one image. Media delivery requires `PUBLIC_API_URL` to be reachable by the vendor over a public HTTPS URL.
- [ ] Confirm credits: text and one image/PDF each cost 1 × `creditsPerMessage`. Campaign messages should show `sent`; this provider has no delivered/read receipts.
- [ ] Test a number you control that the vendor will reject; confirm the failed send is refunded.

If cloudflared or ngrok is not installed, install one with `winget install Cloudflare.cloudflared` or `winget install ngrok`. After the API starts, run `cloudflared tunnel --url http://localhost:5000` or `ngrok http 5000` in another terminal. Only after confirming the generated HTTPS address should you set `PUBLIC_API_URL` to it and restart the backend. Free tunnel URLs can change after a restart, so update `PUBLIC_API_URL` each time. Without a public tunnel, text-only sends can work; media cannot be downloaded by the vendor.

**Implemented and tested** (automated tests, live e2e over real HTTP/DB, and real-browser checks of the admin/reseller/customer screens):
roles and permissions; admin/reseller creating customers; credits (add, deduct, reseller→customer transfer, ledger, refunds); media upload and image/video/document template headers carried into campaigns;
mock WhatsApp campaigns end to end; mock voice campaigns; CLI number management; Meta webhooks (signature, dedupe, ordering, STOP opt-out); limits, audit log, password reset, persistence across restarts.

**Implemented but NOT verified against the real service** (no credentials or internet to those services in the development environment — test with your own accounts and one authorised number first):
- **Linked phone (QR)**: uses the unofficial WhatsApp Web protocol through Baileys. The QR screen, session storage, pacing and sending code exist, but a real QR scan and real delivery could not be tested here.
  WhatsApp can restrict or ban numbers that send bulk or unsolicited messages this way. Use a dedicated number you can afford to lose, message only people who expect it, and keep volumes modest.
- **Meta Cloud API** (connection test, template submit/sync, real sends).
- **Voice vendor API**: the generic HTTP adapter is tested against a local fake vendor (request building, credits per call, refunds, vendor callbacks) but not against a live voice provider.
- **Company WhatsApp API (HTTP)**: the generic adapter and sms4power preset are implemented and tested against a local fake vendor. No real vendor request has been made. Real sends need an administrator-configured API key and `ALLOW_REAL_SEND=true`.
- SMTP delivery of reset emails.
