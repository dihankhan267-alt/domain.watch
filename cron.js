// The daily job. Two ways to run it in production:
//   1. A host with real cron (Railway, a VPS, etc.): schedule
//      `node cron.js` (daily) and `node cron.js weekly` directly.
//   2. A host without free cron (Render free tier): point a free
//      external pinger (cron-job.org) at POST /api/cron/daily and
//      POST /api/cron/weekly on your deployed app, with header
//      x-cron-secret: <your CRON_SECRET>. Those routes call the same
//      two functions exported below.
require('dotenv').config();
const { nanoid } = require('nanoid');
const db = require('./lib/db');
const { runCheck } = require('./lib/checks');
const { sendAlertEmail, sendWeeklyDigest } = require('./lib/email');

async function checkAllDomains() {
  const domains = await db.listAllDomains();
  console.log(`[cron] checking ${domains.length} domains...`);

  const alertsByUser = {};

  for (const d of domains) {
    try {
      const result = await runCheck(d.domain);
      await db.createCheck({ id: nanoid(), domainId: d.id, ...result });

      if (result.alerts.length > 0) {
        alertsByUser[d.user_id] = alertsByUser[d.user_id] || [];
        alertsByUser[d.user_id].push({ domain: d.domain, alerts: result.alerts });
      }
      console.log(`[cron] ${d.domain}: ${result.alerts.length} alert(s)`);
    } catch (err) {
      console.error(`[cron] FAILED checking ${d.domain}:`, err.message);
    }
  }

  for (const [userId, items] of Object.entries(alertsByUser)) {
    const user = await db.findUserById(userId);
    if (user) await sendAlertEmail(user.email, items);
  }

  console.log('[cron] done.');
}

// Weekly digest — run this on a separate weekly schedule (e.g. Monday 9am),
// not on every daily run.
async function sendDigests() {
  const users = await db.listUsers();
  for (const user of users) {
    const domains = await db.listDomainsByUser(user.id);
    if (domains.length === 0) continue;
    const summary = await Promise.all(
      domains.map(async (d) => ({ domain: d.domain, lastCheck: await db.lastCheckForDomain(d.id) }))
    );
    await sendWeeklyDigest(user.email, summary);
  }
}

if (require.main === module) {
  const mode = process.argv[2] || 'daily';
  const run = mode === 'weekly' ? sendDigests() : checkAllDomains();
  run.then(() => process.exit(0)).catch((err) => {
    console.error('[cron] fatal error:', err);
    process.exit(1);
  });
}

module.exports = { checkAllDomains, sendDigests };
