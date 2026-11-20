-- Acceso: servidor OAuth 2.1 propio (para Muse y otros clientes MCP) y tokens de ingesta (reloj, atajos).
-- Solo se guardan hashes SHA-256. Estas tablas no tienen política para `authenticated`:
-- únicamente las toca el servidor con su rol propietario.

create table fit.oauth_clients (
  client_id text primary key,
  client_name text,
  redirect_uris text[] not null,
  grant_types text[] not null default '{authorization_code,refresh_token}',
  token_endpoint_auth_method text not null default 'none',
  client_secret_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table fit.oauth_codes (
  code_hash text primary key,
  client_id text not null references fit.oauth_clients(client_id) on delete cascade,
  user_id uuid not null references fit.athletes(id) on delete cascade,
  redirect_uri text not null,
  scope text not null,
  resource text,
  code_challenge text not null,
  code_challenge_method text not null default 'S256' check (code_challenge_method = 'S256'),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table fit.oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references fit.oauth_clients(client_id) on delete cascade,
  user_id uuid not null references fit.athletes(id) on delete cascade,
  access_hash text not null unique,
  refresh_hash text unique,
  scope text not null,
  resource text,
  expires_at timestamptz not null,
  refresh_expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index oauth_tokens_user on fit.oauth_tokens (user_id) where revoked_at is null;

create table fit.ingest_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade,
  name text not null,                                       -- «Watch 2R», «Atajo móvil»
  token_hash text not null unique,
  scopes text[] not null default '{ingest:health}',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table fit.login_attempts (
  id bigint generated always as identity primary key,
  key text not null,                                        -- hash de ip + email
  ok boolean not null,
  created_at timestamptz not null default now()
);
create index login_attempts_key on fit.login_attempts (key, created_at desc);
