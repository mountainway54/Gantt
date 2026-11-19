begin;

create schema if not exists gantt_private;
revoke all on schema gantt_private from public, anon, authenticated;

create table if not exists gantt_private.shared_account (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null references auth.users(id) on delete cascade
);

create table if not exists public.gantt_projects (
  id uuid primary key,
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and jsonb_typeof(payload -> 'project') is not distinct from 'string'
    and jsonb_typeof(payload -> 'start') is not distinct from 'string'
    and jsonb_typeof(payload -> 'tasks') is not distinct from 'array'
  ),
  revision integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.gantt_projects enable row level security;
revoke all on public.gantt_projects from public, anon, authenticated;
grant select on public.gantt_projects to authenticated;

create or replace function public.gantt_access_allowed()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from gantt_private.shared_account where user_id = auth.uid()
  );
$$;

drop policy if exists gantt_shared_read on public.gantt_projects;
create policy gantt_shared_read on public.gantt_projects
for select to authenticated using ((select public.gantt_access_allowed()));

create or replace function gantt_private.validate_project(p_payload jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  date_pattern constant text := '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$';
  task jsonb;
begin
  if jsonb_typeof(p_payload -> 'project') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'start') is distinct from 'string'
    or jsonb_typeof(p_payload -> 'tasks') is distinct from 'array'
    or p_payload ->> 'start' !~ date_pattern then
    raise invalid_parameter_value using message = '專案名稱、開始日期或任務清單無效';
  end if;
  perform (p_payload ->> 'start')::date;

  for task in select value from jsonb_array_elements(p_payload -> 'tasks') loop
    if jsonb_typeof(task -> 'id') is distinct from 'string'
      or task ->> 'id' !~ '^[a-zA-Z0-9_-]+$'
      or jsonb_typeof(task -> 'start') is distinct from 'string'
      or jsonb_typeof(task -> 'end') is distinct from 'string'
      or task ->> 'start' !~ date_pattern
      or task ->> 'end' !~ date_pattern
      or coalesce(jsonb_typeof(task -> 'deps'), 'null') not in ('array', 'null')
      or coalesce(jsonb_typeof(task -> 'name'), 'null') not in ('string', 'null')
      or coalesce(jsonb_typeof(task -> 'owner'), 'null') not in ('string', 'null')
      or coalesce(jsonb_typeof(task -> 'note'), 'null') not in ('string', 'null') then
      raise invalid_parameter_value using message = '任務欄位無效';
    end if;
    if (task ->> 'start')::date > (task ->> 'end')::date then
      raise invalid_parameter_value using message = '任務開始日不可晚於結束日';
    end if;
  end loop;

  if exists (
    select item ->> 'id'
    from jsonb_array_elements(p_payload -> 'tasks') as tasks(item)
    group by item ->> 'id' having count(*) > 1
  ) then
    raise invalid_parameter_value using message = '任務編號重複';
  end if;

  if exists (
    with tasks as (
      select item, item -> 'id' as id
      from jsonb_array_elements(p_payload -> 'tasks') as source_items(item)
    )
    select 1 from tasks as successor
    cross join lateral jsonb_array_elements(
      coalesce(nullif(successor.item -> 'deps', 'null'::jsonb), '[]'::jsonb)
    ) as deps(id)
    left join tasks as predecessor on predecessor.id = deps.id
    where predecessor.id is null
       or (predecessor.item ->> 'end')::date >= (successor.item ->> 'start')::date
  ) then
    raise invalid_parameter_value using message = '前置任務不存在或排程順序無效';
  end if;
end;
$$;

create or replace function public.gantt_save_project(
  p_id uuid, p_revision integer, p_payload jsonb
)
returns setof public.gantt_projects
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.gantt_access_allowed() then
    raise insufficient_privilege using message = 'Gantt access denied';
  end if;
  perform gantt_private.validate_project(p_payload);

  if p_revision is null then
    insert into public.gantt_projects (id, payload) values (p_id, p_payload)
    on conflict (id) do nothing;

    return query select p.* from public.gantt_projects p
    where p.id = p_id and p.revision = 1 and p.payload = p_payload;
  else
    return query update public.gantt_projects p
    set payload = p_payload, revision = p.revision + 1, updated_at = now()
    where p.id = p_id and p.revision = p_revision
    returning p.*;
  end if;
end;
$$;

create or replace function public.gantt_delete_project(p_id uuid, p_revision integer)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.gantt_access_allowed() then
    raise insufficient_privilege using message = 'Gantt access denied';
  end if;

  delete from public.gantt_projects where id = p_id and revision = p_revision;
  return found;
end;
$$;

revoke all on function public.gantt_access_allowed() from public, anon, authenticated;
revoke all on function public.gantt_save_project(uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function public.gantt_delete_project(uuid, integer) from public, anon, authenticated;
grant execute on function public.gantt_access_allowed() to authenticated;
grant execute on function public.gantt_save_project(uuid, integer, jsonb) to authenticated;
grant execute on function public.gantt_delete_project(uuid, integer) to authenticated;

commit;
