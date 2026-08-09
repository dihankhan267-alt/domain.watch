// This file is the whole product. Everything else is UI around this.
const tls = require('tls');
const whois = require('whois-json');

/**
 * Get domain registration expiry date via WHOIS.
 * WHOIS output format varies wildly by TLD registrar — this is the
 * single most fragile part of the product and the thing you'll patch
 * every few months as registrars change their output format.
 */
async function getDomainExpiry(domain) {
  try {
    const data = await whois(domain);
    const raw =
      data.registryExpiryDate ||
      data.expiryDate ||
      data.expirationDate ||
      data.registrarRegistrationExpirationDate ||
      null;

    if (!raw) return { ok: false, error: 'Could not parse expiry date from WHOIS response' };

    const date = new Date(raw);
    if (isNaN(date.getTime())) return { ok: false, error: `Unparseable date: ${raw}` };

    return { ok: true, expiresAt: date.toISOString() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get SSL certificate expiry by opening a TLS handshake against the domain.
 */
function getSslExpiry(domain, port = 443) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: domain, port, servername: domain, timeout: 8000, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          resolve({ ok: false, error: 'No certificate returned' });
          return;
        }
        resolve({ ok: true, expiresAt: new Date(cert.valid_to).toISOString() });
      }
    );
    socket.on('error', (err) => resolve({ ok: false, error: err.message }));
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, error: 'TLS connection timed out' });
    });
  });
}

/**
 * Check whether the site responds over HTTPS and with what status code.
 */
async function getHttpStatus(domain) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://${domain}`, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(t);
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function daysUntil(isoDate) {
  // Math.ceil, not floor: "6 days and 23 hours left" should read as 7 days
  // left (round up to the nearer whole day still remaining), not 6 —
  // floor was causing threshold alerts (30/14/7/1) to almost never fire
  // on the intended day, and made same-day expiries read as already-expired
  // a day early.
  const ms = new Date(isoDate).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

/**
 * Run all three checks for one domain and figure out what alerts (if any)
 * should fire. Alert thresholds: 30 / 14 / 7 / 1 days before expiry, or
 * immediately if the site is down / cert invalid.
 */
async function runCheck(domain) {
  const [domainExpiry, sslExpiry, http] = await Promise.all([
    getDomainExpiry(domain),
    getSslExpiry(domain),
    getHttpStatus(domain),
  ]);

  const alerts = [];
  const THRESHOLDS = [30, 14, 7, 1];

  if (domainExpiry.ok) {
    const d = daysUntil(domainExpiry.expiresAt);
    if (d <= 0) alerts.push({ level: 'critical', message: `Domain ${domain} has EXPIRED` });
    else if (THRESHOLDS.includes(d)) alerts.push({ level: 'warning', message: `Domain ${domain} expires in ${d} days` });
  }

  if (sslExpiry.ok) {
    const d = daysUntil(sslExpiry.expiresAt);
    if (d <= 0) alerts.push({ level: 'critical', message: `SSL cert for ${domain} has EXPIRED` });
    else if (THRESHOLDS.includes(d)) alerts.push({ level: 'warning', message: `SSL cert for ${domain} expires in ${d} days` });
  } else {
    alerts.push({ level: 'critical', message: `SSL check failed for ${domain}: ${sslExpiry.error}` });
  }

  if (!http.ok) {
    alerts.push({ level: 'critical', message: `${domain} is unreachable: ${http.error}` });
  } else if (http.status >= 500) {
    alerts.push({ level: 'critical', message: `${domain} returned HTTP ${http.status}` });
  } else if (http.status >= 400) {
    alerts.push({ level: 'warning', message: `${domain} returned HTTP ${http.status}` });
  }

  return {
    checkedAt: new Date().toISOString(),
    domainExpiry,
    sslExpiry,
    http,
    alerts,
  };
}

module.exports = { runCheck, getDomainExpiry, getSslExpiry, getHttpStatus, daysUntil };
