# API reference

Base URL `http://localhost:5000/api`. JSON in/out. Auth: `Authorization: Bearer <token>` from `POST /auth/login`.
Errors: `{ "error": { "message": "...", "details": [...] } }` with proper HTTP status (400 validation, 401 no/invalid/expired
session, 403 wrong role or suspended, 404 not found **or belongs to another tenant**, 409 conflict, 422 business rule, 429 rate limit).
List endpoints accept `page`, `limit`, `q`/filters and return pagination metadata.

## Auth — `/auth`
| Method | Path | Notes |
|---|---|---|
| POST | /login | `{email,password}` → `{token,user}`; rate limited; suspended accounts refused |
| GET | /me | current user |
| POST | /logout | invalidates the session |
| POST | /change-password | invalidates other sessions |
| POST | /forgot-password | same response for any address (no enumeration) |
| POST | /reset-password | single-use token; invalidates old sessions |

## Admin — `/admin` (role admin)
| Method | Path | Notes |
|---|---|---|
| GET | /stats | platform stats from DB |
| GET | /audit | global audit log |
| GET/PUT | /settings | default limits, mock failure rate, mock delays, QR and Company API pacing |
| GET/PUT | /wa-api | platform-wide Company WhatsApp API configuration; API keys are encrypted and only `hasApiKey` is returned |
| POST | /wa-api/preset/wtap | load sms4power (wtap) defaults without changing the saved key |
| POST | /wa-api/test | send one real test message; requires `ALLOW_REAL_SEND=true`, returns vendor status/body with API-key values masked |
| GET/POST | /resellers | list / create |
| GET/PATCH | /resellers/:id | detail / edit (incl. maxCustomers) |
| POST | /resellers/:id/suspend, /activate, /reset-password | |
| * | /customers/... | customer management (below) with `role=admin` scope (all customers) |

## Reseller — `/reseller` (role reseller)
`GET /stats`, `GET /audit`, and `/customers/...` limited to the reseller's own customers.

## Customers router (mounted under /admin/customers and /reseller/customers)
`GET /`, `POST /`, `GET /:id`, `PATCH /:id` (limits, details), `POST /:id/suspend`, `POST /:id/activate`, `POST /:id/reset-password`.

## Customer workspace — `/c` (roles customer **and reseller**; admin gets 403; every query scoped to the caller)
| Area | Endpoints |
|---|---|
| Dashboard | GET /dashboard, GET /usage, GET /audit, PATCH /account |
| Contacts `/contacts` | GET /, POST /, GET /:id, PATCH /:id, DELETE /:id, POST /bulk, POST /import/preview, POST /import, GET /export, GET /duplicates, POST /merge, GET /groups, PATCH /groups/:name, DELETE /groups/:name |
| Templates `/templates` | GET /, POST /, POST /validate, POST /sync, GET /:id, PUT /:id, POST /:id/submit, DELETE /:id |
| Campaigns `/campaigns` | GET /, POST /, GET /:id, PATCH /:id, POST /:id/validate, /schedule, /unschedule, /start, /pause, /resume, /cancel, /clone, DELETE /:id, GET /:id/messages (report), GET /:id/export (CSV) |
| WhatsApp `/whatsapp` | GET /, PUT / (provider `mock`/`meta`/`qr`/`wa_http`; customer credentials never include the platform API key), POST /connect, POST /disconnect, GET /events, **QR (linked phone):** GET /qr (state + QR image), POST /qr/start, POST /qr/logout |
| Media `/media` | GET / (filter by kind), POST / (multipart; type detected from file bytes; image 5 MB, video/document/audio 16 MB), DELETE /:id (refused while in use) |
| Voice `/voice` | GET / (campaign list + usable CLI numbers), POST /campaigns, PATCH /campaigns/:id (start/pause/resume/cancel/schedule use the normal `/campaigns/:id/...` actions) |
| Credits | GET /credits (balance, per-message and per-call cost, ledger) |

Templates accept the existing `headerType`, `header`, and `mediaId` fields. `attachmentType` (`none`, `image`, `video`, or `document`) is optional for compatibility; when absent, old `headerType=image|video|document` values continue to identify the attachment. An empty `body` is valid only with an image, video, or document attachment. Meta submissions require body text and cannot combine a text header with a media header.

Campaign statuses: `draft → scheduled → queued → running ⇄ paused → completed | cancelled | failed`.
Message statuses in mock mode: `queued, sending, simulated_sent, simulated_delivered, simulated_read, simulated_failed, excluded, cancelled`
(plain `sent/delivered/read/failed` are used only with a real provider).

## Webhooks — `/webhooks/whatsapp` (public, signature-protected)
`GET` verification handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`);
`POST` events with `X-Hub-Signature-256`. Duplicate events are stored once and not re-applied; statuses never regress;
inbound `STOP` opts the contact out.

## Database
Mongoose models in `backend/src/models` (User, Contact, Template, Campaign, CampaignMessage, WhatsAppAccount, WhatsappApiConfig, WebhookEvent,
Usage, AuditLog, PasswordReset, Setting). Indexes (unique phone per tenant, one message per campaign+contact, unique campaign submission key, queue/lock indexes,
unique webhook event id, unique reset-token hash) are declared in the schemas and built on startup.

## Credits (wallet)
| Method | Path | Notes |
|---|---|---|
| POST | /admin/resellers/:id/credits | body `{action: "add"|"deduct", amount, note}`; admin creates/removes credits |
| POST | /admin/customers/:id/credits | same for any customer |
| POST | /reseller/customers/:id/credits | same body; `add` moves credits from the reseller's own wallet to their customer, `deduct` returns them |
| GET | the same paths (`/admin/resellers/:id/credits`, `/admin|reseller/customers/:id/credits`) | balance + ledger of that account |

Mock (simulated) sends are free. Real sends cost `creditsPerMessage` / `creditsPerCall` (Admin → Settings); failed real sends are refunded; a running campaign pauses when credits run out. Balance changes are single atomic conditional updates and every change is written to the ledger.

The `wa_http` provider charges `max(1, media_count) × creditsPerMessage` per message; this panel currently permits one image or one PDF attachment per template, so text-only and one-media messages both cost one unit. It sends vendor-accepted messages as `sent`; it does not synthesize delivered/read receipts or process inbound STOP messages. Add opt-out instructions yourself. Media campaign validation requires a public `PUBLIC_API_URL`; local/private media URLs are rejected.

## Calling and CLI — `/admin/voice` (admin only)
| Method | Path | Notes |
|---|---|---|
| GET / PUT | / | calling settings: mode `mock` or `http`, vendor URL, method, headers/body templates, API key (encrypted), response call-id path, webhook token |
| POST | /test | runs one test call through the configured mode |
| GET / POST | /cli | list / add a CLI (caller-ID) number |
| PATCH / DELETE | /cli/:id | edit (label, status, `assignedToId`: one account or everyone) / remove |

Vendor callbacks for call status arrive on the webhook URL shown on that page.

## Company WhatsApp API — `/admin/wa-api` (admin only)
| Method | Path | Notes |
|---|---|---|
| GET / PUT | / | Platform-wide `off`/`http` config: base URL, GET/POST, query/JSON/form encoding, parameter names, country/mobile format, optional media-only fallback caption and configurable success/message-id paths. API key is encrypted at rest and never serialized. |
| POST | /preset/wtap | Load the sms4power (wtap) defaults without replacing the saved key. |
| POST | /test | One real text message to the supplied number; blocked when `ALLOW_REAL_SEND=false`; response status/body are returned with API-key material masked. |

Customers select **Company WhatsApp API** in their own WhatsApp settings only after the admin has enabled a ready configuration. The connection test checks that configuration; it does not send a vendor request. Campaign sends use the `wa_http` provider and the admin-owned key.

## Public media — `GET /media/:token/:name`
Unguessable-token URLs that Meta / the voice vendor use to fetch an uploaded file. Everything else under `/api` needs a bearer token.
