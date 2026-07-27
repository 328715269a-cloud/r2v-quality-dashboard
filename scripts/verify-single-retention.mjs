import fs from 'node:fs/promises';

const config=await fs.readFile(new URL('../config.js',import.meta.url),'utf8');
const url=config.match(/supabaseUrl:\s*"([^"]+)"/)?.[1];
const key=config.match(/supabaseKey:\s*"([^"]+)"/)?.[1];
const headers={apikey:key,Authorization:`Bearer ${key}`};
async function all(table,query=''){
  const rows=[];
  for(let offset=0;;offset+=1000){
    const response=await fetch(`${url}/rest/v1/${table}?select=*${query}&offset=${offset}&limit=1000`,{headers});
    if(!response.ok)throw new Error(`${table}: ${await response.text()}`);
    const page=await response.json();rows.push(...page);
    if(page.length<1000)return rows;
  }
}
const imports=await all('r2v_quality_imports');
const singleIds=new Set(imports.filter(row=>!String(row.file_name||'').startsWith('【多镜头】')).map(row=>row.id));
const oldEvents=(await all('r2v_quality_events','&event_time=gte.2026-06-29T16%3A00%3A00Z&event_time=lt.2026-07-15T16%3A00%3A00Z')).filter(row=>!row.import_id||singleIds.has(row.import_id));
const oldFeedback=(await all('r2v_quality_feedback','&feedback_date=gte.2026-06-30&feedback_date=lte.2026-07-15')).filter(row=>row.raw_row?.workstream!=='multi'&&(!row.import_id||singleIds.has(row.import_id)));
const newEvents=(await all('r2v_quality_events','&event_time=gte.2026-07-15T16%3A00%3A00Z')).filter(row=>!row.import_id||singleIds.has(row.import_id));
if(oldEvents.length||oldFeedback.length)throw new Error(`旧单镜头仍有残留：流水 ${oldEvents.length}，反馈 ${oldFeedback.length}`);
console.log(JSON.stringify({oldEvents:0,oldFeedback:0,singleEventsFromJuly16:newEvents.length}));
