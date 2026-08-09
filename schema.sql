-- Run this once in Supabase → SQL Editor (or any Postgres instance)
-- before starting the app against DATABASE_URL.

create table if not exists users (
  id text primary key,
  email text unique not null,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);

create table if not exists domains (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  domain text not null,
  "group" text not null default 'Default',
  created_at timestamptz not null default now()
);

create table if not exists checks (
  id text primary key,
  domain_id text not null references domains(id) on delete cascade,
  checked_at timestamptz not null default now(),
  domain_expiry jsonb,
  ssl_expiry jsonb,
  http jsonb,
  alerts jsonb not null default '[]'
);

create index if not exists idx_domains_user on domains(user_id);
create index if not exists idx_checks_domain on checks(domain_id);
create index if not exists idx_checks_checked_at on checks(checked_at);
