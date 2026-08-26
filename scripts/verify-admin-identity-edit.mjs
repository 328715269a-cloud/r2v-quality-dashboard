import fs from 'node:fs';

const root=new URL('../',import.meta.url);
const read=path=>fs.readFileSync(new URL(path,root),'utf8');
const app=read('app.js');
const html=read('index.html');
const sqlPath='supabase-admin-case-identity-edit.sql';
let sql='';
try{sql=read(sqlPath)}catch(error){
  throw new Error(`${sqlPath} is missing. Deployable SQL is required for password-protected identity edits.`,{cause:error});
}

const failures=[];
const expect=(condition,message)=>{if(!condition)failures.push(message)};
const occurrences=(source,needle)=>source.split(needle).length-1;
function functionSource(source,name){
  const start=source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if(start<0)return '';
  const open=source.indexOf('{',start);
  if(open<0)return '';
  let depth=0,quote='',escaped=false,lineComment=false,blockComment=false;
  for(let i=open;i<source.length;i++){
    const char=source[i],next=source[i+1];
    if(lineComment){if(char==='\n')lineComment=false;continue}
    if(blockComment){if(char==='*'&&next==='/'){blockComment=false;i++}continue}
    if(quote){
      if(escaped){escaped=false;continue}
      if(char==='\\'){escaped=true;continue}
      if(char===quote)quote='';
      continue;
    }
    if(char==='/'&&next==='/'){lineComment=true;i++;continue}
    if(char==='/'&&next==='*'){blockComment=true;i++;continue}
    if(char==='\''||char==='"'||char==='`'){quote=char;continue}
    if(char==='{')depth++;
    if(char==='}'&&--depth===0)return source.slice(start,i+1);
  }
  return '';
}
function containingFunction(source,needle){
  const needleAt=source.indexOf(needle);
  if(needleAt<0)return '';
  const prefix=source.slice(0,needleAt);
  const matches=[...prefix.matchAll(/(?:async\s+)?function\s+([\w$]+)\s*\(/g)];
  return matches.length?functionSource(source,matches.at(-1)[1]):'';
}

const rpcName='r2v_admin_correct_case_identity';
const identitySave=containingFunction(app,rpcName);
const identityOpen=functionSource(app,'openIdentityEdit');
const rebuild=functionSource(app,'rebuild');
const importsView=functionSource(app,'renderImports');
expect(identitySave.includes(`db.rpc('${rpcName}'`)||identitySave.includes(`db.rpc("${rpcName}"`),'TID/annotator save must call the password-validating RPC');
expect(!/\.from\(['"]r2v_quality_feedback['"]\)\.update\s*\(/.test(identitySave),'TID/annotator save must not directly update r2v_quality_feedback');
expect(/c\._feedbackKeys/.test(identityOpen)&&/p_feedback_keys\s*:\s*edit\.keys/.test(identitySave),'Identity edits must target the selected logical Case feedback_keys');
expect(!/state\.feedback\.filter\([^\n]{0,250}?\.tid\s*===/.test(identityOpen),'Opening a Case identity edit must not expand the edit to every record sharing the TID');
const directFeedbackUpdates=[...app.matchAll(/(?:async\s+)?function\s+([\w$]+)\s*\(/g)]
  .map(match=>[match[1],functionSource(app,match[1])])
  .filter(([,source])=>/\.from\(['"]r2v_quality_feedback['"]\)\.update\s*\(/.test(source));
for(const [name,source] of directFeedbackUpdates){
  expect(!/manualAnnotator/.test(source)&&!/\.update\s*\(\s*\{[\s\S]{0,250}?\btid\s*:/.test(source),`${name} must not directly update administrator-only TID/annotator fields`);
}
expect(!/\b6268\b/.test(`${app}\n${html}`),'The administrator PIN must never be embedded in frontend source');

const cases=functionSource(app,'renderCases');
const appeals=functionSource(app,'renderAppeals');
for(const [name,source] of [['Case detail',cases],['Appeal center',appeals]]){
  expect(/\w+Cell\(c\s*,\s*['"]tid['"]\)/.test(source),`${name} must render TID through the shared editable cell helper`);
  expect(/\w+Cell\(c\s*,\s*['"]annotator['"]\)/.test(source),`${name} must render annotator through the shared editable cell helper`);
}
const caseHelpers=[...cases.matchAll(/(\w+Cell)\(c\s*,\s*['"](?:tid|annotator)['"]\)/g)].map(match=>match[1]);
const appealHelpers=[...appeals.matchAll(/(\w+Cell)\(c\s*,\s*['"](?:tid|annotator)['"]\)/g)].map(match=>match[1]);
expect(caseHelpers.some(name=>appealHelpers.includes(name)),'Case detail and Appeal center must share the same identity edit cell helper');

const dialog=html.match(/<(?:dialog|section)\b[^>]*id=['"]identityEditDialog['"][^>]*>[\s\S]*?<\/(?:dialog|section)>/i)?.[0]||'';
expect(Boolean(dialog),'A shared identity-edit dialog is required');
expect(/role=['"]dialog['"]/i.test(dialog)||/^<dialog\b/i.test(dialog),'Identity-edit modal must expose dialog semantics');
expect(/<input\b[^>]*type=['"]password['"]/i.test(dialog),'Identity-edit dialog must ask for the administrator password');
expect(!/\son\w+\s*=/i.test(dialog),'Identity-edit dialog must use addEventListener/property bindings, not inline event handlers');

const preserve=functionSource(app,'preserveOnlineFeedbackTracking');
const activeRows=functionSource(app,'activeFeedbackRows');
const identityTimestampSource=functionSource(app,'identityTrackingAt');
const newestTimestampSource=functionSource(app,'newestTimestamp');
const qualityRoundSource=functionSource(app,'qualityRoundForFeedback');
expect(preserve.includes('manualTid')&&preserve.includes('manualSourceTid'),'Re-upload preservation must retain manualTid and manualSourceTid');
expect(/raw_row->>manualSourceTid/.test(preserve),'Re-upload preservation must query corrected records by manualSourceTid alias');
expect(/row\.tid\s*=/.test(preserve)&&/manualTid/.test(preserve),'Re-upload preservation must restore the corrected TID before upsert');
expect(activeRows.includes('manualTid')&&activeRows.includes('manualSourceTid'),'Logical feedback merging must retain corrected TID aliases');
expect(occurrences(app,'manualTid')>=4&&occurrences(app,'manualSourceTid')>=4,'Corrected TID metadata must be used throughout load, merge, and re-upload paths');
expect(!/tidManual\.manualAnnotator/.test(rebuild),'A Case-level annotator override must not spread to every feedback row sharing the TID');
expect(/manualAnnotatorByRound\s*=\s*new Map/.test(rebuild)&&/qualityRoundForFeedback\(f\s*,\s*state\.qualityRounds\)/.test(rebuild)&&/manualAnnotatorByRound\.set\(q\.key/.test(rebuild),'Annotator overrides must be scoped from the selected feedback Case to its matched quality round');
const acceptanceOverride=rebuild.match(/state\.acceptanceRounds\.forEach\(r=>\{([\s\S]*?)\}\);/)?.[1]||'';
expect(!/manualAnnotator/.test(acceptanceOverride),'A quality feedback annotator override must not spread to acceptance rounds by TID');
expect(/annotator\s*:\s*manual\.manualAnnotator\s*\|\|/.test(rebuild),'Feedback Cases must read their annotator override from their own merged feedback record');

for(const [field,timestamp,tracker] of [
  ['TID','manualTidUpdatedAt','_manualTidTrackingAt'],
  ['annotator','manualAnnotatorUpdatedAt','_manualAnnotatorTrackingAt'],
  ['inspector','manualMatchUpdatedAt','_manualInspectorTrackingAt'],
]){
  expect(activeRows.includes(timestamp),`${field} identity merging must read ${timestamp}`);
  expect(occurrences(activeRows,tracker)>=2,`${field} identity merging must keep an independent ${tracker} maximum timestamp cursor`);
}
expect(!activeRows.includes('_manualTrackingAt'),'TID, annotator, and inspector edits must not share one timestamp cursor');

const identityTrackingAt=Function(`${newestTimestampSource};${identityTimestampSource};return identityTrackingAt;`)();
const at=value=>new Date(value).valueOf();
const domainTimestampScenarios=[
  ['TID domain timestamp wins over newer shared/row timestamps',{raw_row:{manualTid:'NEW',manualTidUpdatedAt:'2026-08-01T00:00:00Z',manualIdentityUpdatedAt:'2026-08-04T00:00:00Z'},updated_at:'2026-08-05T00:00:00Z'},'tid',at('2026-08-01T00:00:00Z')],
  ['annotator domain timestamp wins over newer legacy/shared timestamps',{raw_row:{manualAnnotator:'甲',manualAnnotatorUpdatedAt:'2026-08-02T00:00:00Z',manualMatchUpdatedAt:'2026-08-06T00:00:00Z',manualIdentityUpdatedAt:'2026-08-04T00:00:00Z'},updated_at:'2026-08-07T00:00:00Z'},'annotator',at('2026-08-02T00:00:00Z')],
  ['inspector domain timestamp wins over newer shared timestamp',{raw_row:{manualInspector:'乙',manualMatchUpdatedAt:'2026-08-03T00:00:00Z',manualIdentityUpdatedAt:'2026-08-08T00:00:00Z'},updated_at:'2026-08-09T00:00:00Z'},'inspector',at('2026-08-03T00:00:00Z')],
  ['legacy annotator uses the newest shared fallback only when domain timestamp is absent',{raw_row:{manualAnnotator:'旧',manualMatchUpdatedAt:'2026-08-05T00:00:00Z',manualIdentityUpdatedAt:'2026-08-04T00:00:00Z'},updated_at:'2026-08-10T00:00:00Z'},'annotator',at('2026-08-05T00:00:00Z')],
  ['legacy TID uses shared fallback before generic row timestamp',{raw_row:{manualTid:'LEGACY',manualIdentityUpdatedAt:'2026-08-06T00:00:00Z'},updated_at:'2026-08-11T00:00:00Z'},'tid',at('2026-08-06T00:00:00Z')],
];
for(const [name,row,domain,expected] of domainTimestampScenarios){
  expect(identityTrackingAt(row,domain)===expected,`Identity timestamp scenario failed: ${name}`);
}

const dayValue=value=>String(value||'').slice(0,10);
const roundIncluded=round=>round.firstValid===true;
const round=(tid,date,key,firstValid=true)=>({tid,date,key,firstValid});
const qualityRoundFor=(entries,feedback)=>{
  const state={qualityRoundsByTid:new Map(entries)};
  return Function('state','day','qualityRoundIncluded','FIRST_PASS_QUALITY_START',`${qualityRoundSource};return qualityRoundForFeedback;`)(state,dayValue,roundIncluded,'2026-08-01')(feedback,[...entries.values()].flat());
};
expect(/for\s*\(const\s+tid\s+of\s+candidateTids\)/.test(qualityRoundSource)&&!qualityRoundSource.includes('.find(items=>items.length)'),'Round lookup must evaluate each current/alias TID after date filtering instead of taking the first non-empty history');
const aliasFallback=qualityRoundFor([
  ['CURRENT',[round('CURRENT','2026-08-20','current-future')]],
  ['SOURCE',[round('SOURCE','2026-08-10','source-eligible')]],
],{tid:'CURRENT',feedback_date:'2026-08-15',raw_row:{manualSourceTid:'SOURCE'}});
expect(aliasFallback?.key==='source-eligible','A future-only current TID must fall back to the historical source TID eligible round');
const invalidCurrentFallback=qualityRoundFor([
  ['CURRENT',[round('CURRENT','2026-08-14','current-not-included',false)]],
  ['SOURCE',[round('SOURCE','2026-08-12','source-valid')]],
],{tid:'CURRENT',feedback_date:'2026-08-15',raw_row:{manualSourceTid:'SOURCE'}});
expect(invalidCurrentFallback?.key==='source-valid','A current TID without an included round must not block a valid source-TID round');
const currentPriority=qualityRoundFor([
  ['CURRENT',[round('CURRENT','2026-08-14','current-valid')]],
  ['SOURCE',[round('SOURCE','2026-08-15','source-valid')]],
],{tid:'CURRENT',feedback_date:'2026-08-15',raw_row:{manualSourceTid:'SOURCE'}});
expect(currentPriority?.key==='current-valid','An eligible valid current-TID round must retain priority over the source alias');

expect(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${rpcName}\\b`,'i').test(sql),'SQL must define the admin identity correction RPC');
expect(/security\s+definer/i.test(sql)&&/set\s+search_path\s*=\s*(?:''|pg_catalog\s*,\s*public\s*,\s*private)/i.test(sql),'RPC must be SECURITY DEFINER with a fixed search_path');
expect(/crypt\s*\([\s\S]{0,100}?p_pin[\s\S]{0,100}?[\w.]+pin_hash\s*\)/i.test(sql),'RPC must validate p_pin with PostgreSQL crypt against the stored hash');
expect(/update\s+public\.r2v_quality_feedback[\s\S]*?set[\s\S]*?tid\s*=\s*v_value/i.test(sql),'TID correction must update the selected feedback records');
expect(/update\s+public\.r2v_quality_appeals[\s\S]*?set\s+tid\s*=\s*v_value/i.test(sql),'TID correction must synchronize linked appeal TIDs');
expect(!/\bset\s+feedback_key\s*=/i.test(sql),'Identity correction must preserve feedback_key so appeals and history remain linked');
expect(!/delete\s+from\s+public\.r2v_quality_feedback/i.test(sql),'Identity correction must not delete feedback records');

expect(/current_user/i.test(sql)&&/pg_get_userbyid/i.test(sql),'Protection triggers must verify that identity changes originate from the SECURITY DEFINER RPC owner');
expect(/create\s+(?:or\s+replace\s+)?function\s+(?:public|private)\.\w*(?:guard|protect)\w*identity/i.test(sql),'SQL must define an identity protection trigger function');
expect(/create\s+trigger\s+\w*(?:guard|protect)\w*identity[\s\S]*?before\s+update[\s\S]*?on\s+public\.r2v_quality_feedback/i.test(sql),'SQL must install a BEFORE UPDATE trigger protecting identity fields');
expect(/create\s+trigger\s+\w*(?:guard|protect|normalize)\w*(?:appeal|tid)[\s\S]*?before\s+(?:insert\s+or\s+update|update\s+or\s+insert)[\s\S]*?on\s+public\.r2v_quality_appeals/i.test(sql),'Appeal trigger must normalize both stale INSERT and UPDATE operations');
expect(/where\s+f\.feedback_key\s*=\s*new\.feedback_key/i.test(sql)&&/new\.tid\s*:=/i.test(sql),'Appeal trigger must derive canonical TID from r2v_quality_feedback by feedback_key');
expect(/(?:old\.tid\s+is\s+(?:not\s+)?distinct\s+from\s+new\.tid|new\.tid\s+is\s+(?:not\s+)?distinct\s+from\s+old\.tid)/i.test(sql),'Protection trigger must guard direct TID changes');
expect(/manualAnnotator/i.test(sql),'Protection trigger/RPC must protect administrator-only annotator overrides');
expect(/insert\s+into\s+public\.r2v_quality_admin_audit/i.test(sql),'Every identity correction must be written to the administrator audit log');
expect(/edit_case_identity/i.test(sql),'Identity corrections must use a dedicated audit action');
expect(/r2v_quality_daily_cache[\s\S]*?is_dirty\s*=\s*true/i.test(sql),'Identity corrections must mark affected daily summaries dirty');
expect(/from\s+public\.r2v_quality_events\b/i.test(sql)&&/event_time/i.test(sql),'Identity corrections must include related quality/acceptance event dates when invalidating daily summaries');
expect(/into\s+v_event_tids[\s\S]{0,500}?v_tid_aliases[\s\S]{0,300}?v_field\s*=\s*'tid'[\s\S]{0,200}?v_value/i.test(sql)&&/from\s+public\.r2v_quality_events\s+e[\s\S]{0,500}?e\.tid\s*=\s*any\s*\(\s*v_event_tids\s*\)/i.test(sql),'Cache invalidation must query event dates through an alias set containing both the previous TID chain and corrected TID');
expect(/revoke\s+all\s+on\s+function[\s\S]*?r2v_admin_correct_case_identity/i.test(sql),'RPC execution privileges must be explicitly restricted before grants');
expect(/['"]edit_case_identity['"]\s*:\s*['"]修改 Case TID\/标注人['"]/.test(importsView),'Administrator audit history must display edit_case_identity with a human-readable label');

if(failures.length){
  console.error(`Admin identity edit verification failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('Admin identity edit verification passed: shared PIN-gated UI, atomic RPC, audit/trigger protection, cache invalidation, and re-upload aliases are present.');
