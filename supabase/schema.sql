-- English по плейлистам — схема Supabase.
-- Не запускайте этот файл напрямую: `node tools/make_setup_sql.mjs` соберёт supabase/setup.local.sql
-- (схема + ваш код приглашения и ключ контента). Его и нужно выполнить в Supabase → SQL Editor.
-- Скрипт можно запускать повторно: он ничего не удаляет из данных.

-- Настройки: код приглашения, ключ контента, часовой пояс. Через API не читаются (RLS без политик).
create table if not exists public.app_config (
  k text primary key,
  v text not null
);

-- Участники: создаётся только через register() с верным кодом приглашения.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  created_at timestamptz not null default now()
);

-- Баллы по дням.
create table if not exists public.points (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  pts integer not null default 0,
  primary key (user_id, day)
);

-- Прогресс обучения (синхронизация между устройствами).
create table if not exists public.progress (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Включаем RLS без политик: прямой доступ к таблицам через API закрыт, всё — только через функции ниже.
alter table public.app_config enable row level security;
alter table public.profiles enable row level security;
alter table public.points enable row level security;
alter table public.progress enable row level security;

create or replace function public.cfg(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select v from app_config where k = p_key
$$;

create or replace function public.local_today() returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce(cfg('tz'), 'UTC'))::date
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid())
$$;

create or replace function public.require_member() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_member() then raise exception 'not_member'; end if;
end $$;

-- Регистрация участника: логин + код приглашения.
create or replace function public.register(p_username text, p_invite text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_invite is null or p_invite is distinct from cfg('invite_code') then raise exception 'bad_invite'; end if;
  if is_member() then return; end if;
  begin
    insert into profiles (id, username) values (auth.uid(), lower(trim(p_username)));
  exception when unique_violation then
    raise exception 'username_taken';
  end;
end $$;

-- Кто я.
create or replace function public.me() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('username', (select username from profiles where id = auth.uid()), 'member', is_member())
$$;

-- Ключ расшифровки уроков — только участникам.
create or replace function public.content_key() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_member();
  return cfg('content_key');
end $$;

-- Начислить баллы за сегодня. Ограничения: до 60 за вызов и 3000 в день.
create or replace function public.add_points(p integer) returns integer
language plpgsql security definer set search_path = public as $$
declare total integer;
begin
  perform require_member();
  if p is null or p < 1 or p > 60 then raise exception 'bad_points'; end if;
  insert into points (user_id, day, pts) values (auth.uid(), local_today(), least(p, 3000))
  on conflict (user_id, day) do update set pts = least(points.pts + excluded.pts, 3000)
  returning pts into total;
  return total;
end $$;

drop function if exists public.leaderboard(integer);
-- Турнирная таблица за неделю (понедельник — воскресенье). p_week = 0 — текущая, 1 — прошлая.
create or replace function public.leaderboard(p_week integer default 0)
returns table (username text, pts bigint, today bigint, streak integer, is_me boolean, week_start date)
language plpgsql stable security definer set search_path = public as $$
declare ws date := (date_trunc('week', local_today()) - make_interval(weeks => greatest(p_week, 0)))::date;
begin
  perform require_member();
  return query
    select pr.username,
           coalesce(sum(pt.pts) filter (where pt.day >= ws and pt.day < ws + 7), 0)::bigint,
           coalesce(sum(pt.pts) filter (where pt.day = local_today()), 0)::bigint,
           coalesce(max(s.streak), 0)::integer,
           pr.id = auth.uid(),
           ws
    from profiles pr
    left join points pt on pt.user_id = pr.id
    left join lateral (
      -- серия жива, если последний день занятий — сегодня, вчера или пропуск покрыт заморозками
      select case
        when g.data->>'lastDay' ~ '^\d{4}-\d{2}-\d{2}$'
         and (g.data->>'lastDay')::date >= local_today() - 1 - least(greatest(coalesce((g.data->>'freezes')::int, 0), 0), 2)
        then coalesce((g.data->>'streak')::int, 0) else 0 end as streak
      from progress g where g.user_id = pr.id
    ) s on true
    group by pr.id, pr.username
    order by 2 desc, 1;
end $$;

create or replace function public.save_progress(p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_member();
  insert into progress (user_id, data, updated_at) values (auth.uid(), p_data, now())
  on conflict (user_id) do update set data = excluded.data, updated_at = now();
end $$;

create or replace function public.load_progress() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_member();
  return (select data from progress where user_id = auth.uid());
end $$;

-- Права: вызывать функции могут только вошедшие пользователи.
do $$
declare f text;
begin
  foreach f in array array['cfg(text)', 'local_today()', 'is_member()', 'require_member()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['register(text, text)', 'me()', 'content_key()', 'add_points(integer)',
                           'leaderboard(integer)', 'save_progress(jsonb)', 'load_progress()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
