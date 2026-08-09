// Email sending, wired for Resend (resend.com — free tier: 3,000 emails/mo).
// Swap RESEND_API_KEY into your .env and this starts sending for real.
// Until then, it just logs to console so you can develop without an API key.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'alerts@domainwatch.app';

async function send(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.log(`\n[email:DRYRUN] To: ${to}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, ' ')}\n`);
    return { ok: true, dryRun: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('[email] send failed:', text);
    return { ok: false, error: text };
  }
  return { ok: true };
}

async function sendAlertEmail(to, items) {
  const rows = items
    .map(
      (item) =>
        `<h3>${item.domain}</h3><ul>` +
        item.alerts.map((a) => `<li><strong>${a.level.toUpperCase()}</strong>: ${a.message}</li>`).join('') +
        `</ul>`
    )
    .join('');
  return send(to, `⚠️ DomainWatch alert: ${items.length} domain(s) need attention`, `
    <h2>Heads up</h2>
    <p>Here's what needs your attention today:</p>
    ${rows}
  `);
}

async function sendWeeklyDigest(to, summary) {
  const rows = summary
    .map((item) => {
      const c = item.lastCheck;
      const status = !c ? 'Not yet checked' : c.alerts.length ? `${c.alerts.length} issue(s)` : 'All healthy';
      return `<li><strong>${item.domain}</strong>: ${status}</li>`;
    })
    .join('');
  return send(to, `Your weekly DomainWatch digest`, `
    <h2>This week's summary</h2>
    <ul>${rows}</ul>
    <p>No action needed unless noted above.</p>
  `);
}

module.exports = { sendAlertEmail, sendWeeklyDigest };
