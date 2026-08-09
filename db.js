// Postgres-backed storage (Supabase free tier or any Postgres works).
// Replaces the old JSON-file version: a flat file does not survive
// restarts on any genuinely free host anymore, a real database does.
//
// This module is the ONLY place that talks to the database — server.js
// and cron.js call these functions and never touch SQL directly.
//
// NOTE: written and reviewed carefully, but not exercised against a live
// Postgres instance — this sandbox has no network path to Supabase and
// couldn't install a local Postgres to test against. Run schema.sql
// against your own database and smoke-test signup/add-domain/check
// yourself before trusting it with real users.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL not set — the app will fail on first query. See .env.example.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase')
    ? { rejectUnauthorized: false }
    : undefined,
});

// ---- users -----------------------------------------------------------

async function findUserByEmail(email) {
  const { rows } = await pool.query('select * from users where email = $1', [email]);
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query('select * from users where id = $1', [id]);
  return rows[0] || null;
}

async function createUser({ id, email, plan, createdAt }) {
  const { rows } = await pool.query(
    'insert into users (id, email, plan, created_at) values ($1, $2, $3, $4) returning *',
    [id, email, plan, createdAt]
  );
  return rows[0];
}

async function listUsers() {
  const { rows } = await pool.query('select * from users');
  return rows;
}

// ---- domains -----------------------------------------------------------

async function listDomainsByUser(userId) {
  const { rows } = await pool.query('select * from domains where user_id = $1 order by created_at desc', [userId]);
  return rows;
}

async function countDomainsByUser(userId) {
  const { rows } = await pool.query('select count(*)::int as count from domains where user_id = $1', [userId]);
  return rows[0].count;
}

async function createDomain({ id, userId, domain, group: groupName, createdAt }) {
  const { rows } = await pool.query(
    'insert into domains (id, user_id, domain, "group", created_at) values ($1, $2, $3, $4, $5) returning *',
    [id, userId, domain, groupName, createdAt]
  );
  return rows[0];
}

async function findDomainById(id) {
  const { rows } = await pool.query('select * from domains where id = $1', [id]);
  return rows[0] || null;
}

async function deleteDomain(id) {
  await pool.query('delete from domains where id = $1', [id]);
}

async function listDomainsByUserAndGroup(userId, groupName) {
  const { rows } = await pool.query('select * from domains where user_id = $1 and "group" = $2', [userId, groupName]);
  return rows;
}

async function listAllDomains() {
  const { rows } = await pool.query('select * from domains');
  return rows;
}

// ---- checks -----------------------------------------------------------

async function createCheck({ id, domainId, checkedAt, domainExpiry, sslExpiry, http, alerts }) {
  const { rows } = await pool.query(
    `insert into checks (id, domain_id, checked_at, domain_expiry, ssl_expiry, http, alerts)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [id, domainId, checkedAt, domainExpiry, sslExpiry, http, JSON.stringify(alerts || [])]
  );
  return rows[0];
}

async function lastCheckForDomain(domainId) {
  const { rows } = await pool.query(
    'select * from checks where domain_id = $1 order by checked_at desc limit 1',
    [domainId]
  );
  return rows[0] || null;
}

module.exports = {
  pool,
  findUserByEmail,
  findUserById,
  createUser,
  listUsers,
  listDomainsByUser,
  countDomainsByUser,
  createDomain,
  findDomainById,
  deleteDomain,
  listDomainsByUserAndGroup,
  listAllDomains,
  createCheck,
  lastCheckForDomain,
};
