-- Namen sind nach der Registrierung gesperrt: Änderungen werden beantragt und vom Spielleiter bestätigt oder abgelehnt.
create table name_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  new_display_name text not null check (char_length(new_display_name) between 1 and 40),
  new_first_name text not null check (char_length(new_first_name) between 1 and 40),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references users(id) on delete set null
);
-- Pro Nutzer nur eine offene Anfrage
create unique index name_requests_one_pending on name_requests (user_id) where status = 'pending';

-- Hier wurden einmalig die Vornamen der damaligen Teilnehmer nachgetragen. Entfernt, weil Namen
-- von Mitspielern nicht in den Code gehören; auf dem laufenden Server ist das längst erledigt.
