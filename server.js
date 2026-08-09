require('dotenv').config();
const express = require('express');
const path = require('path');
const { nanoid } = require('nanoid');
const db = require('./lib/db');
const { runCheck } = require('./lib/checks');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PLAN_LIMITS = { free: 3, solo: 15, agency: 75 };

// Postgres returns snake_case columns; the frontend (and the rest of this
// file) expects the same camelCase shape the old JSON-file version used.
// These two helpers are the only place that translation happens.
function mapDomain(row, lastCheck) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    domain: row.domain,
    group: row.group,
    createdAt: row.created_at,
    lastCheck: lastCheck ? mapCheck(lastCheck) : null,
  };
}

function mapCheck(row) {
  if (!row) return null;
  return {
    id: row.id,
    domainId: row.domain_id,
    checkedAt: row.checked_at,
    domainExpiry: row.domain_expiry,
    sslExpiry: row.ssl_expiry,
    http: row.http,
    alerts: row.alerts || [],
  };
}

// --- tiny auth stub -------------------------------------------------
// Real version: magic-link email auth (Resend + a signed token).
// For now: client sends an email, we find-or-create a user and
// return their id. Good enough to build the rest of the product on;
// swap this function out without touching anything downstream.
async function findOrCreateUser(email) {
  let user = await db.findUserByEmail(email);
  if (!user) {
    user = await db.createUser({ id: nanoid(), email, plan: 'free', createdAt: new Date().toISOString() });
  }
  return user;
}

app.post('/api/signup', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    const user = await findOrCreateUser(email);
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

app.get('/api/domains', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const domains = await db.listDomainsByUser(userId);
    const withStatus = await Promise.all(
      domains.map(async (d) => mapDomain(d, await db.lastCheckForDomain(d.id)))
    );
    res.json({ domains: withStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong loading domains.' });
  }
});

app.post('/api/domains', async (req, res) => {
  try {
    const { userId, domain, group } = req.body;
    if (!userId || !domain) return res.status(400).json({ error: 'userId and domain required' });

    const user = await db.findUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const currentCount = await db.countDomainsByUser(userId);
    const limit = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
    if (currentCount >= limit) {
      return res.status(402).json({ error: `Plan limit reached (${limit} domains). Upgrade to add more.` });
    }

    const cleanDomain = domain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    const record = await db.createDomain({
      id: nanoid(),
      userId,
      domain: cleanDomain,
      group: group || 'Default',
      createdAt: new Date().toISOString(),
    });
    res.json({ domain: mapDomain(record) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong adding that domain.' });
  }
});

app.delete('/api/domains/:id', async (req, res) => {
  try {
    await db.deleteDomain(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong removing that domain.' });
  }
});

// Run a check right now (used for the "aha moment" on first domain add,
// and for a manual "check now" button). Daily checks for everyone else
// come from cron.js, not this route.
app.post('/api/domains/:id/check', async (req, res) => {
  try {
    const domainRecord = await db.findDomainById(req.params.id);
    if (!domainRecord) return res.status(404).json({ error: 'Domain not found' });

    const result = await runCheck(domainRecord.domain);
    const checkRecord = await db.createCheck({ id: nanoid(), domainId: domainRecord.id, ...result });
    res.json({ check: mapCheck(checkRecord) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong running that check.' });
  }
});

// Public client-facing status page for a group of domains.
app.get('/api/status/:userId/:group', async (req, res) => {
  try {
    const { userId, group } = req.params;
    const domains = await db.listDomainsByUserAndGroup(userId, group);
    const status = await Promise.all(
      domains.map(async (d) => {
        const lastCheck = await db.lastCheckForDomain(d.id);
        return { domain: d.domain, lastCheck: mapCheck(lastCheck) };
      })
    );
    res.json({ group, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong loading that status page.' });
  }
});

// Cron trigger routes — for hosts (like Render's free tier) that don't
// offer a free scheduled-job feature. Point an external pinger (e.g.
// cron-job.org, free) at these on a schedule, with the secret as a header.
// If your host DOES have real cron (Railway, a VPS, etc.), ignore these
// and run `node cron.js` / `node cron.js weekly` directly instead.
function requireCronSecret(req, res, next) {
  const secret = req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Missing or invalid x-cron-secret header' });
  }
  next();
}

app.post('/api/cron/daily', requireCronSecret, async (req, res) => {
  try {
    const { checkAllDomains } = require('./cron');
    await checkAllDomains();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Daily check run failed', detail: err.message });
  }
});

app.post('/api/cron/weekly', requireCronSecret, async (req, res) => {
  try {
    const { sendDigests } = require('./cron');
    await sendDigests();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Weekly digest run failed', detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`DomainWatch running on http://localhost:${PORT}`));
}

module.exports = app;
