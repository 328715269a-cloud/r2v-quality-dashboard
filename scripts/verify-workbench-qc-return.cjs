'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID,createHash}=require('node:crypto');
const Flow=require('../group-workbench/workflow.js');
const {normalizeDelta,snapshot}=require('../workbench-api/rules.cjs');
const sourceFile=path.resolve(__dirname,'../group-workbench/app.js');
const source=fs.readFileSync(sourceFile,'utf8');
const uid=prefix=>`${prefix}_${randomUUID()}`;
const clone=value=>JSON.parse(JSON.stringify(value));
const defaultProfile={name:'测试组长',role:'qc',groupId:'g01',mode:'single'};

// Extract the production functions themselves; only browser DOM and transport
// are adapted below. Assertions therefore exercise the shipped routing logic.
function extract(name){
  const match=new RegExp(`^  (?:async )?function ${name}\\(`,'m').exec(source);assert(match,`production function ${name} must exist`);
  const lineEnd=source.indexOf('\n',match.index),line=source.slice(match.index,lineEnd<0?undefined:lineEnd);
  if(line.trimEnd().endsWith('}'))return line;
  const end=source.indexOf('\n  }',lineEnd);assert(end>match.index,`function ${name} closing boundary must exist`);
  return source.slice(match.index,end+4);
}
const functionNames=['escapeHtml','uid','canViewAllGroups','canViewGroup','roleLabel','currentUserName','requireRole','eventsForTask','taskSnapshot','taskWithSnapshot','findTask','assertFresh','newEvent','mutate','refreshState','batchIdentityScope','qcReviewFields','qcDecisionEvent','checkedTasks','qcBulkReturnTasks','assertQcBulkReturnSelection','withQcBulkReturnSave','showBulkQcFail','saveBulkQcFail'];
const actualFunctions=functionNames.map(extract).join('\n');

function fixture(statuses){
  const state={version:3,tasks:[],events:[],batches:[],preferences:{}};
  let tick=0;
  statuses.forEach((spec,index)=>{
    const {status,groupId='g01',mode='single'}=typeof spec==='string'?{status:spec}:spec;
    const task={id:uid('task'),tid:`TID-${index+1}`,movie:'批量验收返修验证',groupId,mode,date:'2026-09-20',createdAt:'2026-09-20T00:00:00.000Z'};
    state.tasks.push(task);
    const event=(type,details={})=>state.events.push({id:uid('event'),taskId:task.id,type,workflowVersion:3,actor:'测试标注',at:new Date(Date.UTC(2026,8,20,1,0,tick++)).toISOString(),...details});
    event('claim',{assignee:'测试标注',actorRole:'annotation'});
    if(status==='annotating')return;
    if(status==='rejection_pending'){event('annotator_reject',{note:'无法标注'});return;}
    event('submit',{round:1,submissionKind:'initial',actorRole:'annotation'});
    if(status==='annotation_done')return;
    const pack=uid('package');event('package_built',{stage:'qc',packageId:pack,packageRound:1,actor:'测试组长',actorRole:'qc'});event('package_claimed',{stage:'qc',packageId:pack,packageRound:1,actor:'测试组长',actorRole:'qc'});
    if(status==='pending_qc')return;
    if(status==='pending_reqc'){
      event('qc_fail',{actor:'测试组长',actorRole:'qc',qcRound:1,pLevel:'P1',tags:['主体/对象漏标'],note:'首检返修'});event('submit',{round:2,submissionKind:'rework',actorRole:'annotation'});
      const nextPack=uid('package');event('package_built',{stage:'qc',packageId:nextPack,packageRound:2,actor:'测试组长',actorRole:'qc'});event('package_claimed',{stage:'qc',packageId:nextPack,packageRound:2,actor:'测试组长',actorRole:'qc'});return;
    }
    event('qc_pass',{actor:'测试组长',actorRole:'qc',qcRound:1});
    if(status==='pending_acceptance')return;
    event(status==='accepted'?'acceptance_pass':'acceptance_fail',{actor:'测试验收',actorRole:'acceptance',acceptanceRound:1,note:'验收发现问题'});
    if(status==='qc_self_rework')event('acceptance_route',{actor:'测试组长',actorRole:'qc',route:'qc',note:'质检自行处理'});
    if(status==='acceptance_rework')event('acceptance_route',{actor:'测试组长',actorRole:'qc',route:'annotation',note:'已经分派给标注'});
  });
  return state;
}

function harness(initial){
  let live=clone(initial),selected=initial.tasks.map(task=>({id:task.id,expected:snapshot(initial,task.id).updatedAt}));
  let form=null,html='',revision=0,saves=0,renders=0,transportError=null,beforeBuilder=null;
  const toasts=[],errors=[],nodes=new Map();
  function control(value=''){return{value,disabled:false,checked:false,isConnected:true,focus(){}};}
  const target={scrollIntoView(){},get innerHTML(){return html;},set innerHTML(value){html=value;if(!value){form=null;return;}const controls=[control()];const elements={note:controls[0]};if(/name="pLevel"/.test(value)){elements.pLevel=control();controls.push(elements.pLevel);}const button=control();controls.push(button);const scope=/data-scope="([^"]*)"/.exec(value)?.[1]?.replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');form={id:'qcBulkDecisionForm',dataset:{scope},elements,__tags:[],isConnected:true,querySelectorAll(){return controls;},querySelector(selector){return selector.includes('submit')?button:null;},closest(){return this;}};},get firstElementChild(){return form;}};
  nodes.set('qcBulkWorkbench',target);nodes.set('qcBulkReturnError',{textContent:'',focus(){}});
  nodes.set('qcView',{querySelectorAll:selector=>form?.querySelectorAll(selector)||[]});
  for(const id of ['scopeGroup','scopeDateFrom','scopeDateTo','changeIdentity'])nodes.set(id,control());
  const context={console,Date,JSON,Map,Set,WeakMap,Object,Number,String,Array,Promise,Error,Math,
    window:{WorkbenchFlow:Flow,crypto:{randomUUID}},profile:clone(defaultProfile),activeMode:'single',state:clone(initial),eventIndexes:new WeakMap(),mutationDepth:0,sharedHasUpdates:false,dirtyForms:new Set(),qcBulkReturnBusy:false,
    QC_TAGS:['命名/ID错误','补标缺失','景别覆盖缺失','朝向覆盖缺失','图片模糊','黑边/裁切','命名/ID对齐错误','主体/对象漏标'],
    document:{activeElement:null},
    $:id=>id==='qcBulkDecisionForm'?form:nodes.get(id),
    qsa:(selector,root)=>{if(selector.includes('qcTask'))return selected.map(row=>({value:row.id,dataset:{expected:row.expected},checked:true,disabled:false}));if(selector.includes('tags'))return(root?.__tags||[]).map(value=>({value,checked:true,disabled:false}));return root?.querySelectorAll(selector)||[];},
    listDefinitions:{qcTask:{}},listSelection:()=>selected.map(row=>({...row})),listModel:()=>({selected:{delete:id=>{selected=selected.filter(row=>row.id!==id);}}}),
    showToast:(message,kind)=>toasts.push({message,kind}),setSharedStatus:(kind,message)=>{if(kind==='error')errors.push(message);},setText:(id,message)=>{if(nodes.has(id))nodes.get(id).textContent=message;},renderQcQueue:()=>{renders++;},
    store:{read:()=>clone(live),transact:async builder=>{if(beforeBuilder){const callback=beforeBuilder;beforeBuilder=null;callback();}if(transportError)throw transportError;const pending=builder(clone(live));const delta=normalizeDelta(live,clone(pending),clone(context.profile),{now:new Date().toISOString(),checkPin(){throw new Error('unexpected PIN validation');}});live={...live,tasks:[...live.tasks,...delta.tasks],events:[...live.events,...delta.events],batches:[...live.batches,...delta.batches]};revision++;saves++;return clone(live);}}
  };
  vm.createContext(context);vm.runInContext(actualFunctions,context,{filename:sourceFile});
  return{context,target,toasts,errors,nodes,get state(){return clone(live);},get selected(){return selected;},set selected(value){selected=value;},get form(){return form;},get saves(){return saves;},get revision(){return revision;},get renders(){return renders;},get html(){return html;},get transportError(){return transportError;},set transportError(value){transportError=value;},set beforeBuilder(value){beforeBuilder=value;},replaceLive(value){live=clone(value);},open(){context.showBulkQcFail();return form;},async save(){await context.saveBulkQcFail(form);},task(index){return snapshot(live,initial.tasks[index].id);}};
}

async function main(){
  const proofs=[];
  const pureInitial=fixture(['acceptance_return_pending','acceptance_return_pending']),pure=harness(pureInitial);
  const pureForm=pure.open();assert(pureForm);assert(!pureForm.elements.pLevel,'pure acceptance return must not ask for a QC P level');assert(!/name="tags"/.test(pure.html));
  pureForm.elements.note.value='验收意见转标注修改';await pure.save();assert.equal(pure.saves,1);assert.equal(pure.form,null);assert.equal(pure.renders,1);
  const pureAdded=pure.state.events.slice(pureInitial.events.length);assert.equal(pureAdded.length,2);assert(pureAdded.every(event=>event.type==='acceptance_route'&&event.route==='annotation'));
  for(let i=0;i<2;i++){assert.equal(pure.task(i).status,'acceptance_rework');assert.equal(pure.task(i).acceptanceRound,1);assert.equal(pure.task(i).qcRound,1);assert.equal(pure.task(i).acceptanceNote,'验收发现问题');}
  assert(pureAdded.every(event=>!Object.hasOwn(event,'pLevel')&&!Object.hasOwn(event,'tags')));
  proofs.push('纯验收退回批量只填说明，无P或标签；实际app生成acceptance_route(annotation)，服务端通过且投影为待标注返修、原验收意见/轮次保留');

  const mixedInitial=fixture(['acceptance_return_pending','pending_qc','pending_reqc']),mixed=harness(mixedInitial),mixedForm=mixed.open();
  assert(mixedForm.elements.pLevel);assert.deepEqual(clone(mixedForm.__counts),{qc:2,acceptance:1});mixedForm.elements.note.value='本批统一修正';
  const beforeMixed=JSON.stringify(mixed.state);await mixed.save();assert.equal(mixed.saves,0);assert.equal(JSON.stringify(mixed.state),beforeMixed);assert.equal(mixed.form,mixedForm);assert.equal(mixedForm.elements.note.value,'本批统一修正');
  mixedForm.elements.pLevel.value='P1';await mixed.save();assert.equal(mixed.saves,0,'mixed batch still needs a QC error tag');
  mixedForm.__tags=['主体/对象漏标'];await mixed.save();assert.equal(mixed.saves,1);assert.equal(mixed.task(0).status,'acceptance_rework');assert.equal(mixed.task(1).status,'rework');assert.equal(mixed.task(2).status,'rework');
  const mixedAdded=mixed.state.events.slice(mixedInitial.events.length);assert.deepEqual(mixedAdded.map(event=>event.type),['acceptance_route','qc_fail','qc_fail']);assert(!Object.hasOwn(mixedAdded[0],'pLevel'));assert(mixedAdded.slice(1).every(event=>event.pLevel==='P1'&&event.tags[0]==='主体/对象漏标'));
  proofs.push('验收退回+一次/二次待质检混选，真实app分别产出分流与qc_fail；P级/标签缺失整批不保存、草稿保留；补齐后一次原子保存');

  const markerMixed=harness(fixture(['acceptance_return_pending','pending_qc'])),markerForm=markerMixed.open();markerForm.elements.note.value='[质检拒绝] 本意只是转交标注';markerForm.elements.pLevel.value='P1';markerForm.__tags=['主体/对象漏标'];const markerBefore=JSON.stringify(markerMixed.state);await markerMixed.save();assert.equal(markerMixed.saves,0);assert.equal(JSON.stringify(markerMixed.state),markerBefore);assert.equal(markerMixed.form,markerForm);assert(markerMixed.errors.some(message=>/拒绝专用标记/.test(message)));
  const markerPure=harness(fixture(['acceptance_return_pending'])),markerPureForm=markerPure.open();markerPureForm.elements.note.value='[质检拒绝] 转交说明中的原文';await markerPure.save();assert.equal(markerPure.task(0).status,'acceptance_rework');assert.equal(markerPure.state.events.at(-1).type,'acceptance_route');
  proofs.push('普通质检混入拒绝专用marker时整批阻止，避免本意返修却变终态拒绝；纯验收分流仅保留说明、不扩大此限制');

  const ordinary=harness(fixture(['pending_qc'])),ordinaryForm=ordinary.open();ordinaryForm.elements.note.value='普通质检原路径';ordinaryForm.elements.pLevel.value='P2';ordinaryForm.__tags=['命名/ID对齐错误'];await ordinary.save();assert.equal(ordinary.task(0).status,'rework');assert.equal(ordinary.state.events.at(-1).type,'qc_fail');
  const empty=harness(fixture(['acceptance_return_pending'])),emptyForm=empty.open();await empty.save();assert.equal(empty.saves,0);assert.equal(empty.form,emptyForm);
  for(const disallowed of ['qc_self_rework','accepted','rejection_pending','acceptance_rework']){const invalid=harness(fixture(['acceptance_return_pending',disallowed]));const before=JSON.stringify(invalid.state);invalid.open();assert(invalid.toasts.some(toast=>/本批均未保存/.test(toast.message)));assert.equal(invalid.form,null);assert.equal(JSON.stringify(invalid.state),before);}
  proofs.push('普通质检打回保持原P级/标签规则；空说明及混入已处理/自行返修/拒绝待确认等任务整批阻止');

  const stale=harness(fixture(['acceptance_return_pending','pending_qc'])),staleForm=stale.open();staleForm.elements.note.value='不要丢掉的返修说明';staleForm.elements.pLevel.value='P0';staleForm.__tags=['主体/对象漏标'];
  const external=stale.state;external.events.push({id:uid('event'),taskId:external.tasks[0].id,type:'metadata_edit',actor:'admin',at:new Date().toISOString(),after:{tid:'CHANGED',movie:'仍保留影片'}});stale.replaceLive(external);
  const beforeStale=JSON.stringify(stale.state);await stale.save();assert.equal(stale.saves,0);assert.equal(JSON.stringify(stale.state),beforeStale);assert.equal(stale.form,staleForm);assert.equal(staleForm.elements.note.value,'不要丢掉的返修说明');
  const selection=harness(fixture(['acceptance_return_pending','pending_qc'])),selectionForm=selection.open();selectionForm.elements.note.value='选中任务有变保留';selection.selected=selection.selected.slice(0,1);await selection.save();assert.equal(selection.saves,0);assert.equal(selection.form,selectionForm);
  for(const change of ['name','group','mode']){const scope=harness(fixture(['acceptance_return_pending'])),scopeForm=scope.open();scopeForm.elements.note.value='切换身份前写的说明';if(change==='name')scope.context.profile.name='另一组长';if(change==='group')scope.context.profile.groupId='g02';if(change==='mode')scope.context.activeMode='multi';await scope.save();assert.equal(scope.saves,0);assert.equal(scope.form,scopeForm);}
  const duringSave=harness(fixture(['acceptance_return_pending'])),duringForm=duringSave.open();duringForm.elements.note.value='异步期间身份变化';duringSave.beforeBuilder=()=>{duringSave.context.profile.groupId='g02';};await duringSave.save();assert.equal(duringSave.saves,0);assert.equal(duringSave.form,duringForm);
  proofs.push('任务过期、勾选变化、姓名/组别/模块变化及异步保存期间身份切换全部阻止，说明和选择保留');

  for(const options of [{groupId:'g02',mode:'single'},{groupId:'g06',mode:'multi'}]){const wrong=harness(fixture([{status:'acceptance_return_pending',...options}]));wrong.open();assert(wrong.toasts.some(toast=>/所属|小组|模块|单镜头|多镜头/.test(toast.message)));assert.equal(wrong.form,null);assert.equal(wrong.saves,0);}
  const serverRejected=harness(fixture(['acceptance_return_pending','pending_qc'])),serverForm=serverRejected.open();serverForm.elements.note.value='服务器校验失败也要保留';serverForm.elements.pLevel.value='P1';serverForm.__tags=['非法错误标签'];const serverBefore=JSON.stringify(serverRejected.state);await serverRejected.save();assert.equal(serverRejected.saves,0);assert.equal(JSON.stringify(serverRejected.state),serverBefore);assert.equal(serverRejected.form,serverForm);assert(serverRejected.errors.some(message=>/标签/.test(message)));
  const network=harness(fixture(['acceptance_return_pending'])),networkForm=network.open();networkForm.elements.note.value='断网填写内容保留';network.transportError=new Error('隔离模拟连接失败');await network.save();assert.equal(network.saves,0);assert.equal(network.form,networkForm);assert.equal(networkForm.elements.note.value,'断网填写内容保留');
  assert.equal(network.context.qcBulkReturnBusy,false);assert(!Object.hasOwn(networkForm.dataset,'saving'));assert.equal(network.nodes.get('changeIdentity').disabled,false);
  const twice=harness(fixture(['acceptance_return_pending'])),twiceForm=twice.open();twiceForm.elements.note.value='双击只能提交一次';twice.nodes.get('scopeGroup').disabled=true;await Promise.all([twice.save(),twice.save()]);assert.equal(twice.saves,1);assert.equal(twice.context.qcBulkReturnBusy,false);assert.equal(twice.nodes.get('scopeGroup').disabled,true,'pre-existing disabled controls must stay disabled');assert.equal(twice.nodes.get('changeIdentity').disabled,false);
  proofs.push('真实server normalize拒绝非法错误标签时不落前面已生成的验收分流；跨组/模块和连接失败均不改变业务数据');
  proofs.push('保存忙锁挡住双击重复提交；失败/成功后释放忙锁，并恢复控件原有disabled状态');

  const serverFixture=fixture(['acceptance_return_pending','pending_qc']),originalServer=JSON.stringify(serverFixture),returned=serverFixture.tasks[0],pending=serverFixture.tasks[1];
  const realEvent=(task,type,extra={})=>({id:uid('event'),taskId:task.id,type,note:'协议兼容验证',...extra});
  assert.throws(()=>normalizeDelta(serverFixture,{events:[realEvent(returned,'qc_fail',{pLevel:'P1',tags:['主体/对象漏标']})]},defaultProfile,{checkPin(){}}),error=>error.status===409);
  assert.throws(()=>normalizeDelta(serverFixture,{events:[realEvent(returned,'acceptance_route',{route:'annotation',expectedUpdatedAt:'stale'})]},defaultProfile,{checkPin(){}}),error=>error.status===409);
  const compatible=normalizeDelta(serverFixture,{events:[realEvent(returned,'acceptance_route',{route:'annotation'}),realEvent(pending,'qc_fail',{pLevel:'P1',tags:['主体/对象漏标']})]},defaultProfile,{checkPin(){}});
  assert.equal(compatible.events[0].type,'acceptance_route');assert.equal(compatible.events[1].type,'qc_fail');assert.equal(JSON.stringify(serverFixture),originalServer);
  const projected={...serverFixture,events:[...serverFixture.events,...compatible.events]};assert.equal(snapshot(projected,returned.id).status,'acceptance_rework');assert.equal(snapshot(projected,pending.id).status,'rework');
  assert.throws(()=>normalizeDelta(serverFixture,{events:[realEvent(returned,'acceptance_route',{route:'annotation'})]},{...defaultProfile,groupId:'g02'},{checkPin(){}}),error=>error.status===403);
  assert.equal(Flow.project({id:'old' },[{type:'acceptance_fail',taskId:'old',note:'旧版本原本已交标注'}]).status,'acceptance_rework','pre-v3 legacy returned tasks keep existing projected state');
  proofs.push('不添加新事件编码：旧合法acceptance_route/qc_fail协议保持；错误qc_fail打验收退回仍409，真实server严格任务scope与过期timestamp');
  const result={ok:true,checkedAt:new Date().toISOString(),runtime:process.version,functions:functionNames,checks:proofs,sourceHash:createHash('sha256').update(source).digest('hex')};
  if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
