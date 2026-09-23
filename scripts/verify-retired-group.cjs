'use strict';

// Synthetic DOM and storage adapters exercise production functions; no network.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'group-workbench/app.js'),'utf8');
const Reports=require('../group-workbench/reports.js');
const Flow=require('../group-workbench/workflow.js');
const IO=require('../group-workbench/data-io.js');
const Rules=require('../workbench-api/rules.cjs');
function extract(name) {
  const lines=app.split(/\r?\n/),start=lines.findIndex(line=>new RegExp(`^  (?:async )?function ${name}\\(`).test(line));
  assert(start>=0,`${name} exists`);
  if(lines[start].trimEnd().endsWith('}'))return lines[start];
  const end=lines.findIndex((line,index)=>index>start&&/^  }\s*$/.test(line));
  assert(end>start,`${name} closes`);return lines.slice(start,end+1).join('\n');
}
const groupsSource=app.slice(app.indexOf('  const GROUPS = ['),app.indexOf('  const QC_TAGS ='));
const helpers=['escapeHtml','localDateString','groupById','activeGroups','groupLabel','options','canViewAllGroups','canViewGroup','selectedGroup','inCurrentScope','configureScopeGroup','populateIdentityGroups','validWorkerProfile','validProfile','saveIdentity','requireImportAdmin','evaluateTaskImport','dispatchValues','previewDispatch','importReport','dispatchImportContext','commitDispatch','eventsForTask','taskSnapshot','taskWithSnapshot','taskIndex','allTasks','selectedRange','validScopeRange','singleScopeDate','scopeRangeLabel','inDateRange','groupTaskMap','groupDailyRows','canEditGroupDaily','efficiencyText','efficiencyHint','renderGroupProgress'];
const fixture={tasks:[{id:'task_11111111-1111-4111-8111-111111111111',tid:'OLD-G05',movie:'保留历史影片',groupId:'g05',mode:'single',date:'2026-09-20',createdAt:'2026-09-20T01:00:00Z'}],events:[],batches:[]};
const makeHarness=new Function('Reports','Flow','IO','fixture','crypto',`
  ${groupsSource}
  const window={WorkbenchReports:Reports,WorkbenchFlow:Flow};
  let state=fixture,profile={role:'admin',name:'admin'},activeMode='single',dispatchDraft=null,toastTimer=null;
  const snapshotCache=new WeakMap(),eventIndexes=new WeakMap(),STATUS_META=Flow.STATUS_META;
  const nodes=new Map(),toasts=[],commits=[],signIns=[];
  function $(id){if(!nodes.has(id)){const label={textContent:''},node={id,value:'',disabled:false,textContent:'',dataset:{},classList:{add(){},remove(){},toggle(){}},closest:()=>({querySelector:()=>label}),elements:{}};let html='';Object.defineProperty(node,'innerHTML',{get:()=>html,set:value=>{html=value;if(['scopeGroup','identityGroup','dispatchGroup'].includes(id)){node.options=[...value.matchAll(/<option value="([^"]*)">/g)].map(match=>({value:match[1]}));node.value=node.options[0]?.value||'';}}});nodes.set(id,node);}return nodes.get(id);}
  const qsa=()=>[],setText=(id,value)=>{$(id).textContent=String(value);},populateLegacyIdentity=()=>{};
  const showToast=(message,tone)=>toasts.push({message,tone}),store={signIn:async value=>{signIns.push(value);return value;},read:()=>state};
  const enterApp=()=>{},setSharedStatus=()=>{},refreshState=()=>true,renderDispatch=()=>{},renderPersonDaily=()=>{};
  const uid=prefix=>prefix+'_'+crypto.randomUUID(),newEvent=(source,task,type,details)=>({id:uid('event'),taskId:task.id,type,...details});
  const mutate=async builder=>{try{commits.push(builder(state));return true;}catch(error){showToast(error.message,'error');return false;}};
  const counts=Flow.counts,overviewStateLink=()=>'';
  $('dispatchForm').elements={date:{value:'2026-09-23'},group:$('dispatchGroup'),movie:{value:'新影片'},tids:{value:'NEW-TID'},mode:{value:'single'}};
  $('scopeGroup').value='all';$('scopeDateFrom').value='2026-09-20';$('scopeDateTo').value='2026-09-20';
  ${helpers.map(extract).join('\n')}
  return {$,toasts,commits,signIns,groups:()=>GROUPS,activeGroups,groupLabel,validProfile,configureScopeGroup,populateIdentityGroups,saveIdentity,evaluateTaskImport,previewDispatch,commitDispatch,
    setScope(user,mode='single'){profile=user;activeMode=mode;state={...fixture};},
    prepareImport(groupId,mode='single'){profile={role:'admin',name:'admin'};activeMode=mode;$('dispatchForm').elements.group.value=groupId;return dispatchValues();},
    seedPreview(){dispatchDraft={signature:JSON.stringify(dispatchValues()),rows:[{outcome:'success',tid:'NEW-TID',movie:'新影片'}]};},
    progress(valid=true){$('scopeDateFrom').value=valid?'2026-09-20':'2026-09-22';$('scopeDateTo').value='2026-09-20';renderGroupProgress(allTasks());return $('groupProgressBody').innerHTML;},
    dailyRows:()=>groupDailyRows(),state:()=>state
  };
`);

async function main() {
  const h=makeHarness(Reports,Flow,IO,fixture,crypto),before=JSON.stringify(fixture),cases=[];
  const check=(name,actual,wanted)=>{assert.deepEqual(actual,wanted,name);cases.push(name);};
  const optionIds=id=>(h.$(id).options||[]).map(option=>option.value);
  const single=['g01','g02','g03','g04'],multi=['g06','g07','g08','g09','g10','m06','m07','m08','m09','m10','m11','m12'];
  check('active single groups are 1 through 4',h.activeGroups().filter(group=>group.defaultMode==='single').map(group=>group.id),single);
  check('all 12 multi groups retain original IDs/order',h.activeGroups().filter(group=>group.defaultMode==='multi').map(group=>group.id),multi);
  check('full history dictionary retains g05',h.groups().length,17);
  check('historical label remains unchanged',h.groupLabel('g05'),'单镜头5组');
  for(const role of ['annotation','qc','acceptance'])check(`${role} existing g05 profile remains valid`,h.validProfile({name:'旧作业人员',role,mode:'single',groupId:'g05'}),true);
  check('admin profile remains valid',h.validProfile({name:'admin',role:'admin'}),true);
  h.configureScopeGroup('g05');check('admin selector removes g05 and falls back safely',optionIds('scopeGroup'),['all',...single]);check('retired old filter selects all rather than blank',h.$('scopeGroup').value,'all');
  for(const role of ['annotation','qc']) {
    h.setScope({name:'旧作业人员',role,mode:'single',groupId:'g05'});h.configureScopeGroup('all');
    check(`${role} old g05 session still displays only its group`,optionIds('scopeGroup'),['g05']);check(`${role} old group remains locked`,h.$('scopeGroup').disabled,true);
  }
  h.setScope({role:'admin',name:'admin'},'multi');h.configureScopeGroup('all');check('multi selector unchanged',optionIds('scopeGroup'),['all',...multi]);
  h.populateIdentityGroups('single','g05');check('new identity choices omit retired group',optionIds('identityGroup'),single);check('old preferred choice falls back to valid first group',h.$('identityGroup').value,'g01');
  h.populateIdentityGroups('multi','m12');check('new multi identity choices unchanged',optionIds('identityGroup'),multi);check('multi saved choice retained',h.$('identityGroup').value,'m12');
  h.populateIdentityGroups('single');assert.match(h.$('identityModeHelp').textContent,/4个小组/);assert.match(h.$('identityGroupHelp').textContent,/单镜头4组/);
  await h.saveIdentity({name:'新登录人员',role:'annotation',mode:'single',groupId:'g05'},'');check('retired new sign-in is stopped before any API call',h.signIns.length,0);assert.match(h.toasts.at(-1).message,/停用/);
  await h.saveIdentity({name:'新登录人员',role:'annotation',mode:'single',groupId:'g04'},'');check('active group sign-in continues',h.signIns.length,1);

  h.prepareImport('g05');h.previewDispatch();assert.match(h.$('dispatchPreview').textContent,/停用/);check('retired preview disables commit',h.$('dispatchCommitBtn').disabled,true);
  h.seedPreview();await h.commitDispatch();check('a previously prepared retired-group import is rejected again at commit',h.commits.length,0);assert.match(h.toasts.at(-1).message,/停用/);
  for(const [id,mode] of [['g04','single'],['m12','multi']]) {
    const values=h.prepareImport(id,mode);check(`${id} normal validation still succeeds`,h.evaluateTaskImport(values,fixture).map(row=>row.outcome),['success']);
    h.previewDispatch();check(`${id} normal preview enables commit`,h.$('dispatchCommitBtn').disabled,false);await h.commitDispatch();
  }
  check('valid single and multi imports still create their own group transactions',h.commits.map(delta=>delta.tasks[0].groupId),['g04','m12']);
  h.setScope({role:'admin',name:'admin'});h.configureScopeGroup('all');
  for(const valid of [true,false]) {
    const markup=h.progress(valid);check(`overview hides g05 with ${valid?'valid':'invalid'} date range`,[...markup.matchAll(/<tr data-group-id="([^"]+)"/g)].map(match=>match[1]),single);
  }
  h.setScope({role:'admin',name:'admin'},'multi');h.configureScopeGroup('all');check('all multi overview rows preserved',[...h.progress().matchAll(/<tr data-group-id="([^"]+)"/g)].map(match=>match[1]),multi);
  h.setScope({role:'admin',name:'admin'});h.configureScopeGroup('all');h.progress();
  check('historical daily model retains g05 even though overview row is hidden',h.dailyRows().some(row=>row.groupId==='g05'),true);
  const report=Reports.build({state:fixture,tasks:fixture.tasks,groups:h.groups(),mode:'single',statusMeta:Flow.STATUS_META,groupLabel:h.groupLabel});
  check('history task export keeps old group name',report.tasks.rows.find(row=>row.tid==='OLD-G05').group,'单镜头5组');
  check('history group export retains g05',report.groups.rows.some(row=>row.groupId==='g05'),true);
  check('input state is not changed by selectors/import preview/overview',JSON.stringify(fixture),before);

  // Existing server permissions deliberately stay compatible with open pages.
  const oldProfile=Rules.profileInput({name:'旧作业人员',role:'annotation',groupId:'g05',mode:'single'});
  const delta=Rules.normalizeDelta(fixture,{events:[{id:'event_22222222-2222-4222-8222-222222222222',taskId:fixture.tasks[0].id,type:'claim',assignee:oldProfile.name}]},oldProfile,{checkPin(){}});
  check('unchanged API accepts an old g05 page claim',delta.events[0].assignee,'旧作业人员');
  const withClaim={...fixture,events:delta.events};
  const submit=Rules.normalizeDelta(withClaim,{events:[{id:'event_33333333-3333-4333-8333-333333333333',taskId:fixture.tasks[0].id,type:'submit',round:1}]},oldProfile,{checkPin(){}});
  check('unchanged API accepts the old page submission',submit.events[0].type,'submit');
  const unchangedFiles=['group-workbench/reports.js','group-workbench/workflow.js','group-workbench/data-io.js','group-workbench/shared-store.js','workbench-api/rules.cjs','workbench-api/server.cjs'];
  const diff=spawnSync('git',['diff','--exit-code','HEAD','--',...unchangedFiles],{cwd:root,encoding:'utf8'});assert.equal(diff.status,0,'report modules, state transport, workflow and API remain unchanged');
  const regression=[];
  for(const file of ['verify-acceptance-accuracy-ui.cjs','verify-first-qc-date.cjs']) {
    const result=spawnSync(process.execPath,[path.join(__dirname,file)],{cwd:root,encoding:'utf8',env:{...process.env,RESULT_PATH:''}});
    assert.equal(result.status,0,`${file}: ${result.stderr||result.stdout}`);const report=JSON.parse(result.stdout);assert.equal(report.ok,true);regression.push({file,ok:true,checks:report.checks,timezoneRuns:report.timezoneRuns});
  }
  const sourceHashes=Object.fromEntries(['group-workbench/app.js','group-workbench/index.html',...unchangedFiles].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
  const result={ok:true,checks:cases.length,cases,regression,unchangedFiles,sourceHashes};
  if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
