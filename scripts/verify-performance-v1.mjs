import fs from 'node:fs';

const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const sql=fs.readFileSync(new URL('../supabase-performance-v1.sql',import.meta.url),'utf8');

const checks=[
  [html.includes('<option value="idle" selected>请选择日期</option>'),'首次进入未设置为空载日期状态'],
  [app.includes("if($('periodSelect')?.value==='idle'&&state.view!=='imports')"),'空载模式仍可能读取业务表'],
  [app.includes("if(!forceDetail&&await loadDailyCache())return"),'总览未优先读取每日云端汇总'],
  [app.includes("pageSize:100"),'Case/申诉未限制为每页100条'],
  [app.includes('function renderPager(type,info)'),'Case/申诉分页器缺失'],
  [app.includes('r2v_quality_daily_cache'),'每日汇总缓存未接入前端'],
  [app.includes('页面不会自动全量重载'),'上传后仍会触发所有在线页面全量重载'],
  [sql.includes('create table if not exists public.r2v_quality_daily_cache'),'Supabase每日汇总表迁移缺失'],
  [sql.includes('create or replace function public.r2v_quality_active_dates'),'按日期范围查询函数缺失'],
  [!/(?:truncate|drop\s+table|delete\s+from)\s+public\.r2v_quality_(?:events|feedback|appeals|imports)/i.test(sql),'性能迁移包含原始业务数据删除'],
];

for(const [ok,message] of checks)if(!ok)throw new Error(message);
console.log('性能改造校验通过：空载进入、云端日汇总、100条分页、增量同步和无损迁移均已启用。');
