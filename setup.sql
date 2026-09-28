-- PC Value Lab shared backend (Supabase, free tier)
-- 1. supabase.com > New project.  2. SQL Editor > paste this whole file > change YOUR_PASSPHRASE > Run.
-- 3. Project Settings > API: copy the Project URL + the publishable/anon key into config.js.

create extension if not exists pgcrypto with schema extensions;

create table parts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('cpu','gpu')),
  name text not null check (char_length(name) between 2 and 80),
  score integer not null check (score between 100 and 400000),
  created_at timestamptz default now()
);
create unique index parts_uq on parts (kind, lower(name));
alter table parts enable row level security;
create policy "anyone reads parts" on parts for select using (true);
create policy "anyone adds parts" on parts for insert with check (true);

create table app_settings (key text primary key, value jsonb not null, updated_at timestamptz default now());
alter table app_settings enable row level security;
create policy "anyone reads settings" on app_settings for select using (true);

create table admin_secret (hash text not null);
alter table admin_secret enable row level security;  -- no policy = unreachable from the browser
insert into admin_secret values (extensions.crypt('YOUR_PASSPHRASE', extensions.gen_salt('bf')));

create function is_admin(p text) returns boolean language sql security definer set search_path = public, extensions as
$$ select exists (select 1 from admin_secret where hash = crypt(p, hash)) $$;

create function admin_check(p text) returns boolean language sql security definer set search_path = public, extensions as
$$ select is_admin(p) $$;

create function admin_set_reference(p text, cpu_name text, cpu_score int, gpu_name text, gpu_score int) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_admin(p) then raise exception 'denied'; end if;
  insert into app_settings(key, value) values ('reference', jsonb_build_object('cpuName',cpu_name,'cpu',cpu_score,'gpuName',gpu_name,'gpu',gpu_score))
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

create function admin_upsert_part(p text, k text, n text, s int) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_admin(p) then raise exception 'denied'; end if;
  insert into parts(kind, name, score) values (k, n, s)
  on conflict (kind, lower(name)) do update set score = excluded.score;
end $$;

create function admin_delete_part(p text, k text, n text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_admin(p) then raise exception 'denied'; end if;
  delete from parts where kind = k and lower(name) = lower(n);
end $$;

grant execute on function admin_check, admin_set_reference, admin_upsert_part, admin_delete_part to anon;
revoke execute on function is_admin from public, anon;
