import fs from 'node:fs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const checks = [
  [html.includes('<option value="idle" selected>请选择日期</option>'), '入口默认应等待用户选择日期'],
  [app.includes("EVENT_COLUMNS='event_key,tid,channel,event_time,event_name,operator_name,reject_reason,import_id'"), '流水查询应只读取业务必需字段'],
  [app.includes("idle=$('periodSelect')?.value==='idle'"), '加载器应识别未选择日期状态'],
  [app.includes('applyEventRange(q.in(\'import_id\',ids))'), '日期范围应下推到 Supabase 查询'],
  [app.includes("q.in('tid',ids),EVENT_COLUMNS"), '范围加载后应补取相关 TID 历史流水'],
  [app.includes('setInterval(syncSharedState,30000)'), '共享状态轮询不得高于每30秒一次'],
  [app.includes('readEventCache(state.workstream)'), '全部累计应优先使用本地流水缓存']
];

const failed = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failed.length) {
  console.error(`Lazy-loading verification failed:\n- ${failed.join('\n- ')}`);
  process.exit(1);
}

console.log('Lazy-loading verification passed: date-scoped entry, TID history completion, reduced polling, and full-range cache are present.');
