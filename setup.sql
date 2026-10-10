-- Scam or Steal shared backend (Supabase, free tier)
-- 1. supabase.com > New project.  2. SQL Editor > paste this whole file > change YOUR_PASSPHRASE > Run.
-- 3. Project Settings > API: copy the Project URL + the publishable/anon key into config.js.
-- 4. Optional, for accounts: Authentication > Sign In / Providers > Email: switch "Confirm email" OFF (no email is ever sent).
--
-- Safe to run again at any time (after an update, or if something is reported missing): it only creates what is
-- missing and re-applies permissions. An existing admin passphrase is never changed.

create extension if not exists pgcrypto with schema extensions;

-- ---------- shared parts list + default yardstick (readable by everyone) ----------
create table if not exists parts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('cpu','gpu')),
  name text not null check (char_length(name) between 2 and 80),
  score integer not null check (score between 100 and 400000),
  created_at timestamptz default now()
);
create unique index if not exists parts_uq on parts (kind, lower(name));
alter table parts enable row level security;
drop policy if exists "anyone reads parts" on parts;
create policy "anyone reads parts" on parts for select using (true);
drop policy if exists "anyone adds parts" on parts;
create policy "anyone adds parts" on parts for insert with check (true);

create table if not exists app_settings (key text primary key, value jsonb not null, updated_at timestamptz default now());
alter table app_settings enable row level security;
drop policy if exists "anyone reads settings" on app_settings;
create policy "anyone reads settings" on app_settings for select using (true);

-- Newer Supabase projects no longer expose new tables to the API by default, so say it explicitly.
grant select, insert on parts to anon, authenticated;
grant select on app_settings to anon, authenticated;

-- ---------- admin passphrase ----------
create table if not exists admin_secret (hash text not null);
alter table admin_secret enable row level security;  -- no policy = unreachable from the browser
revoke all on admin_secret from anon, authenticated;
-- only written when the table is empty, so running this file again never resets or doubles the passphrase
insert into admin_secret
  select extensions.crypt('YOUR_PASSPHRASE', extensions.gen_salt('bf'))
  where not exists (select 1 from admin_secret);

create or replace function is_admin(p text) returns boolean language sql security definer set search_path = public, extensions as
$$ select exists (select 1 from admin_secret where hash = crypt(p, hash)) $$;

create or replace function admin_check(p text) returns boolean language sql security definer set search_path = public, extensions as
$$ select is_admin(p) $$;

create or replace function admin_set_reference(p text, cpu_name text, cpu_score int, gpu_name text, gpu_score int) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_admin(p) then raise exception 'denied'; end if;
  insert into app_settings(key, value) values ('reference', jsonb_build_object('cpuName',cpu_name,'cpu',cpu_score,'gpuName',gpu_name,'gpu',gpu_score))
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

create or replace function admin_upsert_part(p text, k text, n text, s int) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_admin(p) then raise exception 'denied'; end if;
  insert into parts(kind, name, score) values (k, n, s)
  on conflict (kind, lower(name)) do update set score = excluded.score;
end $$;

create or replace function admin_delete_part(p text, k text, n text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_admin(p) then raise exception 'denied'; end if;
  delete from parts where kind = k and lower(name) = lower(n);
end $$;

grant execute on function admin_check, admin_set_reference, admin_upsert_part, admin_delete_part to anon, authenticated;
revoke execute on function is_admin from public, anon, authenticated;

-- ---------- accounts: one private row of listings per signed-in user ----------
-- The site stores each account's listings as one JSON array. Row-level security means a signed-in user can only ever
-- read or change the row whose user_id is their own. "rev" goes up by one on each save: it is how two devices saving
-- at the same moment are detected (the second one re-reads and merges instead of overwriting).
create table if not exists user_listings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  items jsonb not null default '[]'::jsonb,
  rev bigint not null default 1,
  updated_at timestamptz not null default now(),
  constraint items_is_array check (jsonb_typeof(items) = 'array'),
  constraint items_not_huge check (pg_column_size(items) < 4000000)  -- ~4 MB: far more than any real list, stops abuse
);
alter table user_listings enable row level security;
drop policy if exists "own listings read" on user_listings;
create policy "own listings read" on user_listings for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "own listings insert" on user_listings;
create policy "own listings insert" on user_listings for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "own listings update" on user_listings;
create policy "own listings update" on user_listings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update on user_listings to authenticated;
