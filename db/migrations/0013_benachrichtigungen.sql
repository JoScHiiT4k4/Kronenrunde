-- Benachrichtigungen: Einstellungen je Nutzer, Push-Geräte und ein Protokoll gegen doppelte Hinweise.

create table notification_prefs (
  user_id uuid primary key references users(id) on delete cascade,
  email_enabled boolean not null default false,
  push_enabled boolean not null default false,
  -- So viele Minuten vor dem Tippschluss wird erinnert, wenn Tipps fehlen
  lead_minutes int not null default 120 check (lead_minutes between 5 and 10080),
  updated_at timestamptz not null default now()
);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user on push_subscriptions (user_id);

create table notification_log (
  user_id uuid not null references users(id) on delete cascade,
  league_id uuid not null references leagues(id) on delete cascade,
  lock_at timestamptz not null,
  channel text not null check (channel in ('email', 'push')),
  sent_at timestamptz not null default now(),
  primary key (user_id, league_id, lock_at, channel)
);
