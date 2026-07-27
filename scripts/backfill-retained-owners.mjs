import fs from 'node:fs/promises';

const apply=process.argv.includes('--apply');
const config=await fs.readFile(new URL('../config.js',import.meta.url),'utf8');
const url=config.match(/supabaseUrl:\s*"([^"]+)"/)?.[1];
const key=config.match(/supabaseKey:\s*"([^"]+)"/)?.[1];
const headers={apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'return=representation'};
const backup=JSON.parse(await fs.readFile(new URL('../../backups/single-before-2026-07-16-20260727.json',import.meta.url),'utf8'));
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
const events=(await all('r2v_quality_events','&event_time=gte.2026-07-15T16%3A00%3A00Z')).filter(row=>!row.import_id||singleIds.has(row.import_id));
const feedback=(await all('r2v_quality_feedback','&feedback_date=gte.2026-07-16')).filter(row=>row.raw_row?.workstream!=='multi'&&(!row.import_id||singleIds.has(row.import_id)));
const currentAnnotations=new Map(),oldAnnotations=new Map();
for(const row of events){
  if(row.event_name!=='标注'||!row.operator_name)continue;
  const list=currentAnnotations.get(row.tid)||[];list.push(row);currentAnnotations.set(row.tid,list);
}
for(const row of backup.events||[]){
  if(row.event_name!=='标注'||!row.operator_name)continue;
  const list=oldAnnotations.get(row.tid)||[];list.push(row);oldAnnotations.set(row.tid,list);
}
const normalize=value=>String(value||'').trim().replace(/^[a-zA-Z][a-zA-Z0-9._-]*(?=[\u4e00-\u9fff])/,'').trim();
const before=(rows,date)=>(rows||[]).filter(row=>String(row.event_time||'')<=`${date}T23:59:59+08:00`).sort((a,b)=>new Date(a.event_time)-new Date(b.event_time)).at(-1);
const candidates=[];
for(const row of feedback){
  if(row.raw_row?.manualAnnotator)continue;
  if(before(currentAnnotations.get(row.tid),row.feedback_date))continue;
  const anchor=before(oldAnnotations.get(row.tid),row.feedback_date),name=normalize(anchor?.operator_name);
  if(name&&name!=='待匹配')candidates.push({row,name,anchor});
}
console.log(JSON.stringify({mode:apply?'apply':'dry-run',candidates:candidates.length,sample:candidates.slice(0,12).map(x=>({tid:x.row.tid,date:x.row.feedback_date,annotator:x.name,anchor:x.anchor.event_time}))},null,2));
if(!apply)process.exit(0);
let updated=0;
for(const {row,name,anchor} of candidates){
  const raw={...(row.raw_row||{}),manualAnnotator:name,manualMatchUpdatedBy:'系统历史归属回填',manualMatchUpdatedAt:new Date().toISOString(),retentionBackfill:{source:'pre-2026-07-16 backup',anchorEventTime:anchor.event_time}};
  const response=await fetch(`${url}/rest/v1/r2v_quality_feedback?feedback_key=eq.${encodeURIComponent(row.feedback_key)}`,{method:'PATCH',headers,body:JSON.stringify({raw_row:raw})});
  if(!response.ok)throw new Error(`${row.feedback_key}: ${await response.text()}`);
  updated++;
}
console.log(JSON.stringify({updated}));
