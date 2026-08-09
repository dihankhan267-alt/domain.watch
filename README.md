# DomainWatch

Domain expiry, SSL cert expiry, and uptime monitoring for agencies and
freelancers managing multiple client websites.

## What's actually here

```
domainwatch/
├── server.js          Express app: signup, add/list/delete domains, run checks
├── cron.js            Daily check-all-domains job + weekly digest job
├── schema.sql          Postgres schema — run this once against your database
├── lib/
│   ├── checks.js        The core product: WHOIS expiry, SSL expiry, HTTP status
│   ├── email.js          Resend integration (dry-runs to console with no API key)
│   └── db.js              Postgres queries — the only file that talks to the DB
└── public/
    ├── index.html          Landing page
    └── app.html               Dashboard (sign in, add domains, see status)
```

## Why this uses Postgres now, not a JSON file

The first version of this stored data in a flat JSON file on disk, on the
theory that any host would do. That stopped being true sometime in the
last two years: Render's free web services have an **ephemeral
filesystem** — anything written to disk is wiped on every restart,
redeploy, or spin-down after 15 minutes idle. Fly.io and Railway killed
their free tiers outright. There is currently no mainstream host where
"free + always has a writable disk" both hold at once.

The fix is to stop needing a writable disk on the app host at all.
Supabase's free Postgres tier is genuinely free, persists data
indefinitely, and lives independently of wherever you run the app —
so the app itself can restart, redeploy, or spin down as much as it
wants without losing anything.

**Caveat, stated plainly:** I validated `schema.sql` and every query in
`lib/db.js` against a real embedded Postgres engine and they all pass —
inserts, lookups, JSONB round-tripping, cascade deletes. I could not run
the full server against a live Supabase instance from this environment
(no network path to it here). Smoke-test signup → add domain → check
yourself once you're wired up, before you trust it with real users.

## Getting it live — step by step

### 1. Create a free Postgres database (Supabase)

1. Sign up at supabase.com, create a new project (no credit card required).
2. Go to the SQL Editor and paste in the contents of `schema.sql`, then run it.
3. Go to Project Settings → Database → Connection string → URI. Copy the
   "Session pooler" connection string (it looks like
   `postgresql://postgres.xxxx:[password]@...pooler.supabase.com:5432/postgres`).

One thing to know: Supabase free projects **pause after 7 days with no
database activity**. Since you'll have a daily cron job hitting this
database anyway (step 3), that alone keeps it awake — you don't need to
do anything extra as long as the cron job is actually running.

### 2. Deploy the app (Render)

1. Push this project to a GitHub repo.
2. On render.com, create a new Web Service, connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under Environment, add:
   - `DATABASE_URL` — the connection string from step 1
   - `CRON_SECRET` — any long random string you make up
   - `RESEND_API_KEY` / `FROM_EMAIL` — once you're ready for real emails
5. Deploy. You'll get a live `https://your-app.onrender.com` URL.

Render's free tier spins down after 15 minutes of no traffic and takes
about a minute to wake back up on the next request. Fine for an early
product; if that cold start becomes a problem, Render's Starter tier
($7/mo) removes it — you do not need to migrate anything else to upgrade.

### 3. Set up the daily check (cron-job.org — free)

Render's free tier doesn't include scheduled jobs. Instead:

1. Sign up at cron-job.org (free, no card).
2. Create a job that sends a `POST` request once a day to
   `https://your-app.onrender.com/api/cron/daily`
   with header `x-cron-secret: <the CRON_SECRET you set above>`.
3. Create a second job, once a week, pointed at `/api/cron/weekly` with
   the same header, for the digest email.

If you end up on a host with real scheduled jobs (a VPS, Railway, etc.)
instead, skip this and just schedule `node cron.js` / `node cron.js weekly`
directly — the HTTP routes and the CLI script call the exact same functions.

### 4. Turn on real email

Sign up at resend.com (free, 3,000 emails/month), drop the API key into
Render's environment variables. Nothing else changes.

### 5. Stripe, when you have paying users

Create three Prices in Stripe matching the plan tiers. The plan-limit
logic in `server.js` already expects `user.plan` to be `free`, `solo`,
or `agency` — you're adding a checkout route and a webhook that flips
that field, not restructuring anything.

## Local development

```bash
cp .env.example .env
# fill in DATABASE_URL at minimum
npm install
npm start
```

## What I did NOT build, on purpose

- **Real auth.** `findOrCreateUser` in `server.js` trusts whatever email is
  posted to it. Replace with actual magic-link verification before
  letting strangers sign up.
- **Stripe checkout wiring.** Needs live keys to test against, so it's
  not included — the plan-limit logic is ready for it.
- **Team accounts, roles, integrations, uptime history graphs.** Cut on
  purpose to keep the maintenance surface small.

## The honest maintenance burden

**WHOIS response formats vary by registrar and drift over time.**
`getDomainExpiry()` in `lib/checks.js` tries a few common field names;
when a registrar changes format, that domain's checks fail silently
(`domainExpiry.ok: false`) until you notice and patch it. Budget an hour
or two a quarter. SSL and HTTP checks are protocol-level and don't rot
the same way.
