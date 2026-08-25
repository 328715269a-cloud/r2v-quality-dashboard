-- Emergency safety guard: never physically delete an uploaded batch.
-- The legacy function deleted feedback rows and cascaded into appeals.
create or replace function public.r2v_admin_delete_import(
  p_import_id uuid,
  p_pin text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  raise exception '为保护人工状态、人员匹配和申诉记录，上传批次删除功能已暂停';
end;
$$;

