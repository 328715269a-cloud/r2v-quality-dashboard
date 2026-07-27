import fs from 'node:fs/promises';
import path from 'node:path';

const config=await fs.readFile(new URL('../config.js',import.meta.url),'utf8');
const url=config.match(/supabaseUrl:\s*"([^"]+)"/)?.[1];
const key=config.match(/supabaseKey:\s*"([^"]+)"/)?.[1];
if(!url||!key)throw new Error('无法读取 Supabase 配置');
const headers={apikey:key,Authorization:`Bearer ${key}`};
async function all(table,query=''){
  const rows=[];
  for(let offset=0;;offset+=1000){
    const response=await fetch(`${url}/rest/v1/${table}?select=*${query}&offset=${offset}&limit=1000`,{headers});
    if(!response.ok)throw new Error(`${table}: ${await response.text()}`);
    const page=await response.json();
    rows.push(...page);
    if(page.length<1000)return rows;
  }
}
const imports=await all('r2v_quality_imports');
const singleImportIds=new Set(imports.filter(row=>!String(row.file_name||'').startsWith('【多镜头】')).map(row=>row.id));
const eventCandidates=await all('r2v_quality_events','&event_time=gte.2026-06-29T16%3A00%3A00Z&event_time=lt.2026-07-15T16%3A00%3A00Z');
const events=eventCandidates.filter(row=>!row.import_id||singleImportIds.has(row.import_id));
const feedbackCandidates=await all('r2v_quality_feedback','&feedback_date=gte.2026-06-30&feedback_date=lte.2026-07-15');
const feedback=feedbackCandidates.filter(row=>row.raw_row?.workstream!=='multi'&&(!row.import_id||singleImportIds.has(row.import_id)));
const feedbackKeys=new Set(feedback.map(row=>row.feedback_key));
const appeals=(await all('r2v_quality_appeals')).filter(row=>feedbackKeys.has(row.feedback_key));
const target=path.resolve('../backups/single-before-2026-07-16-20260727.json');
await fs.mkdir(path.dirname(target),{recursive:true});
await fs.writeFile(target,JSON.stringify({
  exported_at:new Date().toISOString(),
  range:'single 2026-06-30 through 2026-07-15',
  counts:{events:events.length,feedback:feedback.length,appeals:appeals.length},
  events,feedback,appeals
},null,2));
console.log(JSON.stringify({target,events:events.length,feedback:feedback.length,appeals:appeals.length,singleImports:singleImportIds.size}));
