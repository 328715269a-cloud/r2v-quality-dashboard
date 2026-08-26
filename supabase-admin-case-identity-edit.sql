-- R2V 管理员 Case 身份修正（TID / 标注人）。
-- 仅新增函数、约束和保护触发器；不修改任何现有业务数据。

begin;
set local lock_timeout = '3s';
set local statement_timeout = '45s';

-- 审计表原有 action 约束可能来自不同版本。保留原表达式允许的全部值，
-- 只额外放行 edit_case_identity，并保证重复执行不会叠加约束。
do $r2v_audit_constraint$
declare
  v_constraint_count integer := 0;
  v_all_have_action boolean := false;
  v_existing_expression text;
  v_constraint record;
begin
  if to_regclass('public.r2v_quality_admin_audit') is null then
    raise exception '缺少 public.r2v_quality_admin_audit，请先执行基础 schema';
  end if;

  select
    count(*),
    coalesce(bool_and(position('edit_case_identity' in pg_catalog.pg_get_expr(c.conbin, c.conrelid)) > 0), false),
    string_agg(format('(%s)', pg_catalog.pg_get_expr(c.conbin, c.conrelid)), ' and ' order by c.conname)
  into v_constraint_count, v_all_have_action, v_existing_expression
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.r2v_quality_admin_audit'::regclass
    and c.contype = 'c'
    and pg_catalog.pg_get_expr(c.conbin, c.conrelid) ~* '(^|[^a-z_])action([^a-z_]|$)';

  if v_constraint_count = 1 and v_all_have_action then
    return;
  end if;

  for v_constraint in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.r2v_quality_admin_audit'::regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_expr(c.conbin, c.conrelid) ~* '(^|[^a-z_])action([^a-z_]|$)'
  loop
    execute format(
      'alter table public.r2v_quality_admin_audit drop constraint %I',
      v_constraint.conname
    );
  end loop;

  if nullif(v_existing_expression, '') is null then
    v_existing_expression :=
      $$action in ('delete_import', 'change_pin', 'sop_settings_updated')$$;
  end if;

  execute format(
    'alter table public.r2v_quality_admin_audit '
    'add constraint r2v_quality_admin_audit_action_check '
    'check (((%s)) or action = %L)',
    v_existing_expression,
    'edit_case_identity'
  );
end
$r2v_audit_constraint$;

create or replace function public.r2v_admin_correct_case_identity(
  p_feedback_keys text[],
  p_field text,
  p_value text,
  p_pin text,
  p_actor text,
  p_expected_tid text,
  p_expected_versions jsonb,
  p_workstream text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $r2v_identity_rpc$
declare
  v_pin_hash text;
  v_keys text[];
  v_key_count integer := 0;
  v_locked_count integer := 0;
  v_field text := lower(pg_catalog.btrim(coalesce(p_field, '')));
  v_value text := pg_catalog.btrim(coalesce(p_value, ''));
  v_actor text := coalesce(nullif(pg_catalog.btrim(p_actor), ''), '未署名');
  v_min_tid text;
  v_max_tid text;
  v_min_workstream text;
  v_max_workstream text;
  v_tid_aliases text[] := array[]::text[];
  v_event_tids text[] := array[]::text[];
  v_dates date[];
  v_event_dates date[];
  v_dirty_dates date[];
  v_feedback_count integer := 0;
  v_appeal_count integer := 0;
  v_conflict_key text;
  v_audit_id bigint;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_updated_at jsonb := '{}'::jsonb;
begin
  select s.pin_hash
    into v_pin_hash
  from private.r2v_quality_admin_settings s
  where s.singleton = true;

  if v_pin_hash is null
     or extensions.crypt(coalesce(p_pin, ''), v_pin_hash) <> v_pin_hash then
    raise exception '管理员密码错误' using errcode = 'P0001';
  end if;

  if v_field not in ('tid', 'annotator') then
    raise exception '仅支持修改 TID 或标注人' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.array_agg(k order by k), array[]::text[])
    into v_keys
  from (
    select distinct pg_catalog.btrim(raw_key) as k
    from pg_catalog.unnest(coalesce(p_feedback_keys, array[]::text[])) as raw(raw_key)
    where nullif(pg_catalog.btrim(raw_key), '') is not null
  ) normalized;

  v_key_count := pg_catalog.cardinality(v_keys);
  if v_key_count = 0 then
    raise exception '至少需要一条 feedback_key' using errcode = '22023';
  end if;
  if v_key_count > 500 then
    raise exception '单次最多修正 500 条关联反馈' using errcode = '54000';
  end if;

  if v_value = '' then
    raise exception '新值不能为空' using errcode = '22023';
  end if;
  if v_field = 'tid' then
    if pg_catalog.length(v_value) > 512
       or v_value ~ '[[:space:][:cntrl:]]' then
      raise exception 'TID 格式不正确：不得含空白/控制字符且最长 512 位'
        using errcode = '22023';
    end if;
  elsif pg_catalog.length(v_value) > 100
        or v_value ~ '[[:cntrl:]]' then
    raise exception '标注人姓名格式不正确且最长 100 位'
      using errcode = '22023';
  end if;

  -- 全局锁顺序统一为 appeals -> feedback：普通申诉 UPDATE 也会先取得
  -- appeal 行锁，再由下方 canonicalize trigger 对 feedback FOR SHARE。
  -- 管理员采用相同顺序，避免双方形成 appeals/feedback 环形等待。
  perform a.id
  from public.r2v_quality_appeals a
  where a.feedback_key = any(v_keys)
  order by a.id
  for update;

  -- 固定顺序锁定全部目标反馈行，避免两个管理员同时修改同一 Case。
  perform f.feedback_key
  from public.r2v_quality_feedback f
  where f.feedback_key = any(v_keys)
  order by f.feedback_key
  for update;
  get diagnostics v_locked_count = row_count;

  if v_locked_count <> v_key_count then
    raise exception '部分反馈记录不存在，请刷新后重试（期望 % 条，找到 % 条）',
      v_key_count, v_locked_count using errcode = 'P0002';
  end if;

  select
    min(f.tid),
    max(f.tid),
    min(case
      when f.raw_row ->> 'workstream' = 'multi' then 'multi'
      when f.import_id is null then 'single'
      when i.file_name like '【多镜头】%' then 'multi'
      else 'single'
    end),
    max(case
      when f.raw_row ->> 'workstream' = 'multi' then 'multi'
      when f.import_id is null then 'single'
      when i.file_name like '【多镜头】%' then 'multi'
      else 'single'
    end),
    pg_catalog.array_agg(distinct f.feedback_date)
      filter (where f.feedback_date is not null)
  into v_min_tid, v_max_tid, v_min_workstream, v_max_workstream, v_dates
  from public.r2v_quality_feedback f
  left join public.r2v_quality_imports i on i.id = f.import_id
  where f.feedback_key = any(v_keys);

  if v_min_tid is distinct from v_max_tid then
    raise exception '所选反馈不属于同一个当前 TID，请刷新后重试'
      using errcode = '40001';
  end if;
  if v_min_workstream is distinct from v_max_workstream then
    raise exception '所选反馈跨越单/多镜头，禁止合并修改'
      using errcode = '40001';
  end if;
  if lower(pg_catalog.btrim(coalesce(p_workstream, ''))) not in ('single', 'multi') then
    raise exception 'workstream 必须是 single 或 multi'
      using errcode = '22023';
  end if;
  if v_min_tid is distinct from pg_catalog.btrim(coalesce(p_expected_tid, '')) then
    raise exception 'TID 已被其他人修改，请刷新后重试'
      using errcode = '40001';
  end if;
  if nullif(pg_catalog.btrim(coalesce(p_workstream, '')), '') is not null
     and v_min_workstream is distinct from lower(pg_catalog.btrim(p_workstream)) then
    raise exception '当前单/多镜头上下文已变化，请刷新后重试'
      using errcode = '40001';
  end if;

  -- 还原整个身份别名链。manualSourceTid 保留首个来源，manualTidAliases
  -- 在每次 A→B→C 修正时累积中间节点，避免只标脏 B/C 而漏掉 A 的轮次。
  select coalesce(
    pg_catalog.array_agg(distinct tid_alias order by tid_alias),
    array[]::text[]
  )
  into v_tid_aliases
  from (
    select nullif(pg_catalog.btrim(f.tid), '') as tid_alias
    from public.r2v_quality_feedback f
    where f.feedback_key = any(v_keys)

    union all

    select nullif(pg_catalog.btrim(f.raw_row ->> 'manualSourceTid'), '')
    from public.r2v_quality_feedback f
    where f.feedback_key = any(v_keys)

    union all

    select nullif(pg_catalog.btrim(f.raw_row ->> 'manualTid'), '')
    from public.r2v_quality_feedback f
    where f.feedback_key = any(v_keys)

    union all

    select nullif(pg_catalog.btrim(alias_item.tid_alias), '')
    from public.r2v_quality_feedback f
    cross join lateral pg_catalog.jsonb_array_elements_text(
      case
        when pg_catalog.jsonb_typeof(f.raw_row -> 'manualTidAliases') = 'array'
          then f.raw_row -> 'manualTidAliases'
        else '[]'::jsonb
      end
    ) as alias_item(tid_alias)
    where f.feedback_key = any(v_keys)
  ) all_aliases
  where tid_alias is not null;

  select coalesce(
    pg_catalog.array_agg(distinct tid_alias order by tid_alias),
    array[]::text[]
  )
  into v_event_tids
  from pg_catalog.unnest(
    v_tid_aliases
    || case when v_field = 'tid' then array[v_value]::text[] else array[]::text[] end
  ) as aliases(tid_alias)
  where nullif(pg_catalog.btrim(tid_alias), '') is not null;

  -- updated_at 必须覆盖每一个 key；这是防止静默覆盖同事最新修改的硬性检查。
  if p_expected_versions is null
     or pg_catalog.jsonb_typeof(p_expected_versions) <> 'object'
     or p_expected_versions = '{}'::jsonb then
    raise exception '缺少并发校验版本，请刷新页面后重试'
      using errcode = '40001';
  end if;

  select f.feedback_key
    into v_conflict_key
  from public.r2v_quality_feedback f
  where f.feedback_key = any(v_keys)
    and (
      not (p_expected_versions ? f.feedback_key)
      or nullif(p_expected_versions ->> f.feedback_key, '') is null
      or f.updated_at is distinct from
         ((p_expected_versions ->> f.feedback_key)::timestamptz)
    )
  order by f.feedback_key
  limit 1;

  if v_conflict_key is not null then
    raise exception '记录 % 已被其他人更新，请刷新后重试', v_conflict_key
      using errcode = '40001';
  end if;

  if v_field = 'tid' then
    update public.r2v_quality_feedback f
    set
      tid = v_value,
      raw_row = pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(
            pg_catalog.jsonb_set(
              pg_catalog.jsonb_set(
                pg_catalog.jsonb_set(
                  pg_catalog.jsonb_set(
                    coalesce(f.raw_row, '{}'::jsonb),
                    '{manualSourceTid}',
                    pg_catalog.to_jsonb(coalesce(nullif(f.raw_row ->> 'manualSourceTid', ''), f.tid)),
                    true
                  ),
                  '{manualTid}', pg_catalog.to_jsonb(v_value), true
                ),
                '{manualTidUpdatedBy}', pg_catalog.to_jsonb(v_actor), true
              ),
              '{manualTidUpdatedAt}', pg_catalog.to_jsonb(v_now), true
            ),
            '{manualMatchUpdatedBy}', pg_catalog.to_jsonb(v_actor), true
          ),
          '{manualMatchUpdatedAt}', pg_catalog.to_jsonb(v_now), true
        ),
        '{manualTidAliases}', pg_catalog.to_jsonb(v_event_tids), true
      )
    where f.feedback_key = any(v_keys);
    get diagnostics v_feedback_count = row_count;

    update public.r2v_quality_appeals a
    set tid = v_value
    where a.feedback_key = any(v_keys)
      and a.tid is distinct from v_value;
    get diagnostics v_appeal_count = row_count;
  else
    update public.r2v_quality_feedback f
    set raw_row = pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(
            pg_catalog.jsonb_set(
              coalesce(f.raw_row, '{}'::jsonb),
              '{manualAnnotator}', pg_catalog.to_jsonb(v_value), true
            ),
            '{manualAnnotatorUpdatedBy}', pg_catalog.to_jsonb(v_actor), true
          ),
          '{manualAnnotatorUpdatedAt}', pg_catalog.to_jsonb(v_now), true
        ),
        '{manualMatchUpdatedBy}', pg_catalog.to_jsonb(v_actor), true
      ),
      '{manualMatchUpdatedAt}', pg_catalog.to_jsonb(v_now), true
    )
    where f.feedback_key = any(v_keys);
    get diagnostics v_feedback_count = row_count;
  end if;

  -- 身份字段会改变该 TID 与质检/验收轮次的归属。除反馈日期外，
  -- 同步失效当前工作流下旧/新 TID 的全部有效结果流水日期。
  select pg_catalog.array_agg(distinct event_date order by event_date)
    into v_event_dates
  from (
    select (e.event_time at time zone 'Asia/Shanghai')::date as event_date
    from public.r2v_quality_events e
    left join public.r2v_quality_imports i on i.id = e.import_id
    where e.tid = any(v_event_tids)
      and e.event_name in (
        '质检通过', '质检不通过', '质检打回',
        '验收通过', '验收不通过'
      )
      and case
        when e.import_id is null then 'single'
        when i.file_name like '【多镜头】%' then 'multi'
        else 'single'
      end = v_min_workstream
  ) related_events;

  select pg_catalog.array_agg(distinct dirty_date order by dirty_date)
    into v_dirty_dates
  from pg_catalog.unnest(
    coalesce(v_dates, array[]::date[])
    || coalesce(v_event_dates, array[]::date[])
  ) as dirty(dirty_date);

  if pg_catalog.to_regclass('public.r2v_quality_daily_cache') is not null
     and v_dirty_dates is not null then
    execute
      'update public.r2v_quality_daily_cache '
      'set is_dirty = true '
      'where workstream = $1 and stat_date = any($2)'
    using v_min_workstream, v_dirty_dates;
  end if;

  insert into public.r2v_quality_admin_audit(action, actor, detail)
  values (
    'edit_case_identity',
    v_actor,
    pg_catalog.jsonb_build_object(
      'field', v_field,
      'workstream', v_min_workstream,
      'feedbackKeys', pg_catalog.to_jsonb(v_keys),
      'oldValue', case when v_field = 'tid' then v_min_tid else null end,
      'newValue', v_value,
      'feedbackCount', v_feedback_count,
      'appealCount', v_appeal_count,
      'tidAliases', pg_catalog.to_jsonb(v_event_tids),
      'dates', coalesce(pg_catalog.to_jsonb(v_dates), '[]'::jsonb),
      'eventDates', coalesce(pg_catalog.to_jsonb(v_event_dates), '[]'::jsonb),
      'dirtyDates', coalesce(pg_catalog.to_jsonb(v_dirty_dates), '[]'::jsonb)
    )
  )
  returning id into v_audit_id;

  select coalesce(
    pg_catalog.jsonb_object_agg(f.feedback_key, pg_catalog.to_jsonb(f.updated_at)),
    '{}'::jsonb
  )
  into v_updated_at
  from public.r2v_quality_feedback f
  where f.feedback_key = any(v_keys);

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'field', v_field,
    'value', v_value,
    'workstream', v_min_workstream,
    'feedbackKeys', pg_catalog.to_jsonb(v_keys),
    'feedbackCount', v_feedback_count,
    'appealCount', v_appeal_count,
    'updatedAt', v_updated_at,
    'auditId', v_audit_id
  );
end;
$r2v_identity_rpc$;

-- 触发器必须保持 SECURITY INVOKER：
-- 直接 REST UPDATE 时 current_user 是 anon/authenticated，会被拒绝；
-- 只有上述 SECURITY DEFINER RPC 内 current_user 才等于 RPC owner。
create or replace function private.r2v_quality_guard_feedback_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $r2v_feedback_guard$
declare
  v_rpc_owner text;
begin
  if new.tid is not distinct from old.tid
     and (new.raw_row -> 'manualTid') is not distinct from (old.raw_row -> 'manualTid')
     and (new.raw_row -> 'manualSourceTid') is not distinct from (old.raw_row -> 'manualSourceTid')
     and (new.raw_row -> 'manualTidUpdatedBy') is not distinct from (old.raw_row -> 'manualTidUpdatedBy')
     and (new.raw_row -> 'manualTidUpdatedAt') is not distinct from (old.raw_row -> 'manualTidUpdatedAt')
     and (new.raw_row -> 'manualTidAliases') is not distinct from (old.raw_row -> 'manualTidAliases')
     and (new.raw_row -> 'manualAnnotator') is not distinct from (old.raw_row -> 'manualAnnotator')
     and (new.raw_row -> 'manualAnnotatorUpdatedBy') is not distinct from (old.raw_row -> 'manualAnnotatorUpdatedBy')
     and (new.raw_row -> 'manualAnnotatorUpdatedAt') is not distinct from (old.raw_row -> 'manualAnnotatorUpdatedAt') then
    return new;
  end if;

  select pg_catalog.pg_get_userbyid(p.proowner)
    into v_rpc_owner
  from pg_catalog.pg_proc p
  where p.oid =
    'public.r2v_admin_correct_case_identity(text[],text,text,text,text,text,jsonb,text)'::regprocedure;

  if v_rpc_owner is null
     or (current_user::text <> v_rpc_owner and current_user::text <> 'service_role') then
    raise exception 'TID/标注人只能通过管理员身份修正功能修改'
      using errcode = '42501';
  end if;

  return new;
end;
$r2v_feedback_guard$;

create or replace function private.r2v_quality_guard_appeal_tid()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $r2v_appeal_guard$
declare
  v_feedback_tid text;
begin
  select f.tid
    into v_feedback_tid
  from public.r2v_quality_feedback f
  where f.feedback_key = new.feedback_key
  for share;

  if not found then
    raise exception '申诉关联的反馈记录不存在或已变化，请刷新后重试'
      using errcode = '23503';
  end if;

  -- 旧页面可能仍携带修正前的 TID；feedback_key 是稳定身份，始终以其
  -- 当前 feedback.tid 为准，避免产生 feedback/appeal 身份分叉。
  new.tid := v_feedback_tid;
  return new;
end;
$r2v_appeal_guard$;

drop trigger if exists r2v_guard_feedback_identity on public.r2v_quality_feedback;
create trigger r2v_guard_feedback_identity
before update on public.r2v_quality_feedback
for each row execute function private.r2v_quality_guard_feedback_identity();

drop trigger if exists r2v_guard_appeal_tid on public.r2v_quality_appeals;
create trigger r2v_guard_appeal_tid
before insert or update on public.r2v_quality_appeals
for each row execute function private.r2v_quality_guard_appeal_tid();

revoke all on function public.r2v_admin_correct_case_identity(
  text[], text, text, text, text, text, jsonb, text
) from public;
grant execute on function public.r2v_admin_correct_case_identity(
  text[], text, text, text, text, text, jsonb, text
) to anon, authenticated, service_role;

revoke all on function private.r2v_quality_guard_feedback_identity() from public, anon, authenticated;
revoke all on function private.r2v_quality_guard_appeal_tid() from public, anon, authenticated;

-- 让 PostgREST 立即发现新 RPC；只刷新接口元数据，不触碰任何业务行。
notify pgrst, 'reload schema';

commit;
