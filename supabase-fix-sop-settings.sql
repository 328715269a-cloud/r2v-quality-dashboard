do $$
declare
  constraint_name text;
begin
  select conname
    into constraint_name
  from pg_constraint
  where conrelid = 'public.r2v_quality_admin_audit'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%action%';

  if constraint_name is not null then
    execute format(
      'alter table public.r2v_quality_admin_audit drop constraint %I',
      constraint_name
    );
  end if;
end
$$;

alter table public.r2v_quality_admin_audit
  add constraint r2v_quality_admin_audit_action_check
  check (action in ('delete_import', 'change_pin', 'sop_settings_updated'));

create or replace function public.r2v_admin_save_sop_settings(
  p_pin text,
  p_actor text,
  p_enabled boolean,
  p_start_date date,
  p_quality_enabled boolean,
  p_acceptance_enabled boolean
)
returns public.r2v_quality_admin_audit
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  settings private.r2v_quality_admin_settings%rowtype;
  saved public.r2v_quality_admin_audit;
begin
  select *
    into settings
  from private.r2v_quality_admin_settings
  where singleton = true;

  if settings.pin_hash is null
     or extensions.crypt(coalesce(p_pin, ''), settings.pin_hash) <> settings.pin_hash then
    raise exception '管理员密码不正确';
  end if;

  if coalesce(p_enabled, false) and p_start_date is null then
    raise exception '启用新 SOP 统计时必须填写启用日期';
  end if;

  insert into public.r2v_quality_admin_audit (
    action,
    actor,
    detail
  )
  values (
    'sop_settings_updated',
    coalesce(nullif(btrim(p_actor), ''), '管理员'),
    jsonb_build_object(
      'enabled', coalesce(p_enabled, false),
      'startDate', case
        when coalesce(p_enabled, false) then to_char(p_start_date, 'YYYY-MM-DD')
        else ''
      end,
      'qualityEnabled', coalesce(p_quality_enabled, true),
      'acceptanceEnabled', coalesce(p_acceptance_enabled, true)
    )
  )
  returning * into saved;

  return saved;
end;
$$;

revoke all on function public.r2v_admin_save_sop_settings(
  text, text, boolean, date, boolean, boolean
) from public;

grant execute on function public.r2v_admin_save_sop_settings(
  text, text, boolean, date, boolean, boolean
) to anon, authenticated;
