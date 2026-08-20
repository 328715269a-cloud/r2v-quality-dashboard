-- R2V quality dashboard performance sidecar.
-- Additive only: no source rows are changed or deleted.

create index if not exists r2v_quality_imports_created_at_idx
  on public.r2v_quality_imports (created_at desc, id);
create index if not exists r2v_quality_events_import_time_idx
  on public.r2v_quality_events (import_id, event_time, event_key);
create index if not exists r2v_quality_events_channel_time_idx
  on public.r2v_quality_events (channel, event_time, event_key);
create index if not exists r2v_quality_feedback_import_date_idx
  on public.r2v_quality_feedback (import_id, feedback_date, feedback_key);
create index if not exists r2v_quality_feedback_date_source_idx
  on public.r2v_quality_feedback (feedback_date, source, feedback_key);
create index if not exists r2v_quality_feedback_updated_idx
  on public.r2v_quality_feedback (updated_at desc, feedback_key);
create index if not exists r2v_quality_appeals_updated_idx
  on public.r2v_quality_appeals (updated_at desc, id);

create table if not exists public.r2v_quality_daily_cache (
  workstream text not null check (workstream in ('single','multi')),
  stat_date date not null,
  payload jsonb not null default '{}'::jsonb,
  is_dirty boolean not null default true,
  source_version text not null default '',
  refreshed_at timestamptz not null default now(),
  refreshed_by text not null default '系统',
  primary key (workstream, stat_date)
);

create index if not exists r2v_quality_daily_cache_scope_idx
  on public.r2v_quality_daily_cache (workstream, stat_date, is_dirty);

alter table public.r2v_quality_daily_cache enable row level security;
grant select, insert, update on public.r2v_quality_daily_cache to anon, authenticated;

drop policy if exists "r2v shared read daily cache" on public.r2v_quality_daily_cache;
create policy "r2v shared read daily cache"
  on public.r2v_quality_daily_cache for select to anon, authenticated using (true);
drop policy if exists "r2v shared insert daily cache" on public.r2v_quality_daily_cache;
create policy "r2v shared insert daily cache"
  on public.r2v_quality_daily_cache for insert to anon, authenticated with check (true);
drop policy if exists "r2v shared update daily cache" on public.r2v_quality_daily_cache;
create policy "r2v shared update daily cache"
  on public.r2v_quality_daily_cache for update to anon, authenticated using (true) with check (true);

create or replace function public.r2v_quality_active_dates(
  p_workstream text,
  p_start date default null,
  p_end date default null
)
returns table(stat_date date)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with event_dates as (
    select distinct (e.event_time at time zone 'Asia/Shanghai')::date as stat_date
    from public.r2v_quality_events e
    left join public.r2v_quality_imports i on i.id=e.import_id
    where case
      when e.import_id is null then 'single'
      when i.file_name like '【多镜头】%' then 'multi'
      else 'single'
    end = p_workstream
      and e.event_name in ('质检通过','质检不通过','质检打回','验收通过','验收不通过')
  ), feedback_dates as (
    select distinct f.feedback_date as stat_date
    from public.r2v_quality_feedback f
    left join public.r2v_quality_imports i on i.id=f.import_id
    where case
      when f.raw_row->>'workstream'='multi' then 'multi'
      when f.import_id is null then 'single'
      when i.file_name like '【多镜头】%' then 'multi'
      else 'single'
    end = p_workstream
      and f.feedback_date is not null
  )
  select d.stat_date
  from (
    select stat_date from event_dates
    union
    select stat_date from feedback_dates
  ) d
  where (p_start is null or d.stat_date >= p_start)
    and (p_end is null or d.stat_date <= p_end)
  order by d.stat_date;
$$;

grant execute on function public.r2v_quality_active_dates(text,date,date) to anon, authenticated;

