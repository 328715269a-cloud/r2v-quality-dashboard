'use strict';

// Read-only, synthetic-data verification of the real first-QC tag drilldown.
// Never connects to a production API and never modifies task/event history.
process.env.TZ = 'Asia/Shanghai';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Reports = require('../group-workbench/reports.js');
const Flow = require('../group-workbench/workflow.js');
const source = fs.readFileSync(path.join(__dirname, '../group-workbench/app.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const cases = [];
function check(label, actual, expected) {
  assert.deepEqual(plain(actual), plain(expected), label);
  cases.push(label);
}
function extract(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `real production helper ${name} exists`);
  const end = source.indexOf('\n', match.index);
  const first = source.slice(match.index, end);
  return first.trimEnd().endsWith('}') ? first : source.slice(match.index, source.indexOf('\n  }', end) + 4);
}

const TAG = '图片模糊/清晰度不足';
const OTHER_TAG = '黑边/裁切不完整';
const OWNER = '舒云健';
const at = (day, time = '09:00:00') => `${day}T${time}+08:00`;
function makeFixture() {
  const state = {version: 3, tasks: [], events: [], batches: [], preferences: {}};
  let serial = 0;
  const add = (id, {mode = 'single', groupId = 'g01', owner = OWNER, reviews = [], movie = '合成影片', tid = id} = {}) => {
    state.tasks.push({id, tid, movie, mode, groupId, date: '2026-08-01', createdAt: at('2026-08-01')});
    const history = [
      {type: 'claim', at: at('2026-09-30'), actor: owner, actorRole: 'annotation', assignee: owner},
      {type: 'submit', at: at('2026-10-01'), actor: owner, actorRole: 'annotation', submissionKind: 'initial'},
      ...reviews
    ];
    for (const event of history) state.events.push({id: `synthetic-${++serial}`, taskId: id, workflowVersion: 3, actor: '首检组长', actorRole: 'qc', ...event});
  };
  const fail = (date = '2026-10-02', details = {}) => ({type: 'qc_fail', at: at(date), pLevel: 'P1', tags: [TAG], note: '请修复模糊画面', ...details});
  add('first-day', {reviews: [fail('2026-10-02', {tags: [TAG, OTHER_TAG]})]});
  add('repaired-next-day', {reviews: [fail(), {type: 'submit', at: at('2026-10-03'), actor: OWNER, actorRole: 'annotation', submissionKind: 'rework'}, {type: 'qc_pass', at: at('2026-10-03', '10:00:00')}, {type: 'acceptance_pass', at: at('2026-10-03', '11:00:00')}]});
  add('second-fail-ignored', {reviews: [{type: 'qc_pass', at: at('2026-10-02')}, {type: 'acceptance_fail', at: at('2026-10-03')}, {type: 'acceptance_route', at: at('2026-10-03', '10:00:00'), route: 'annotation'}, {type: 'submit', at: at('2026-10-03', '11:00:00'), actor: OWNER, actorRole: 'annotation'}, fail('2026-10-04')]});
  add('boundary-start', {reviews: [fail('2026-10-02', {at: '2026-10-01T16:00:00.000Z'})]});
  add('boundary-end', {reviews: [fail('2026-10-02', {at: '2026-10-02T15:59:59.999Z'})]});
  add('next-midnight', {reviews: [fail('2026-10-03', {at: '2026-10-02T16:00:00.000Z'})]});
  add('explicit-rejection', {reviews: [fail('2026-10-02', {type: 'qc_reject', note: '无法作业'})]});
  add('legacy-rejection', {reviews: [fail('2026-10-02', {note: '[质检拒绝] 无法作业'})]});
  add('no-level', {reviews: [fail('2026-10-02', {pLevel: ''})]});
  add('empty-tags', {reviews: [fail('2026-10-02', {tags: []})]});
  add('invalid-date', {reviews: [fail('2026-10-02', {at: 'invalid'})]});
  add('same-name-other-group', {groupId: 'g02', reviews: [fail()]});
  add('same-name-other-mode', {mode: 'multi', groupId: 'g06', reviews: [fail()]});
  add('other-person', {owner: '刘书通', reviews: [fail()]});
  add('reassigned', {reviews: [fail(), {type: 'admin_reassign', at: at('2026-10-03'), actor: '管理员', actorRole: 'admin', assignee: '接手同学', toRole: 'annotation', note: '请假代修'}]});
  add('released-without-review', {reviews: [fail(), {type: 'admin_release', at: at('2026-10-03'), actor: '管理员', actorRole: 'admin'}]});
  add('released-restarted', {reviews: [fail(), {type: 'admin_release', at: at('2026-10-03'), actor: '管理员', actorRole: 'admin'}, {type: 'claim', at: at('2026-10-04'), actor: '接手同学', actorRole: 'annotation', assignee: '接手同学'}, {type: 'submit', at: at('2026-10-04', '10:00:00'), actor: '接手同学', actorRole: 'annotation'}, fail('2026-10-05')]});
  add('deleted-task', {reviews: [fail(), {type: 'task_deleted', at: at('2026-10-03'), actor: '管理员', actorRole: 'admin'}]});
  return {state, add, fail};
}

// Harness and assertions below execute only extracted production functions.
function harness(initial) {
  const nodes = new Map(), handlers = new Map(), stats = {contributions: 0, tidHtml: 0, mounts: 0};
  const decode = text => text.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  class Node {
    constructor(id = '') { this.id=id; this.value=''; this.dataset={}; this.attributes=new Map(); this.buttons=[]; this._html=''; const classes=new Set(); this.classList={add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)}; }
    set innerHTML(html) {
      this._html=html;
      if(this.id==='personStatsBody')nodes.delete('personErrorDetailRow');
      this.buttons=[...html.matchAll(/<button\b([^>]+)>([\s\S]*?)<\/button>/g)].map(match=>{
        const node=new Node();
        for(const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
          const value=decode(attr[2]);node.setAttribute(attr[1],value);
          if(attr[1].startsWith('data-'))node.dataset[attr[1].slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;
        }
        node.textContent=decode(match[2].replace(/<[^>]+>/g,''));
        return node;
      });
    }
    get innerHTML(){return this._html;}
    setAttribute(name,value){this.attributes.set(name,String(value));}
    getAttribute(name){return this.attributes.get(name)||null;}
    closest(selector){if(selector==='tr')return this;const action=/data-action="([^"]+)"/.exec(selector)?.[1];return action===this.dataset.action||selector.includes('#personErrorDetail')?this:null;}
    addEventListener(type,fn){handlers.set(`${this.id}:${type}`,fn);}
    after(node){nodes.set(node.id,node);stats.mounts++;}
    remove(){nodes.delete(this.id);}
    focus(){this.focused=true;}
  }
  for(const id of ['scopeDateFrom','scopeDateTo','scopeGroup','personStatsBody','personDailyDetails','errorAnalysisDetails','errorScope','errorLevel','movieProgressSearch','movieProgressFilter'])nodes.set(id,new Node(id));
  nodes.get('scopeGroup').value='all';
  const context={console,Date,Intl,Map,Set,WeakMap,Array,Object,JSON,String,Number,Math,Error,encodeURIComponent,decodeURIComponent,
    state:plain(initial),profile:{name:'管理员',role:'admin'},activeMode:'single',eventIndexes:new WeakMap(),snapshotCache:new WeakMap(),
    personErrorIndex:{source:null,scope:'',rows:new Map()},personErrorDetail:null,PERSON_ERROR_PAGE_SIZE:20,
    window:{WorkbenchFlow:Flow,WorkbenchReports:{...Reports,annotationContributors(history){stats.contributions++;return Reports.annotationContributors(history);}}},
    $:id=>nodes.get(id),qsa:(selector,root)=>root?.buttons?.filter(button=>selector.includes(button.dataset.action))||[],
    document:{createElement:()=>new Node(),addEventListener:(type,fn)=>handlers.set(`document:${type}`,fn)},groupLabel:id=>({g01:'单镜头1组',g02:'单镜头2组',g06:'多镜头1组'})[id]||id,
    emptyRow:(n,message)=>`<tr><td colspan="${n}">${message}</td></tr>`
  };
  const helpers=['escapeHtml','localDateString','eventDate','acceptanceEventDate','formatImportTime','canViewAllGroups','canViewGroup','selectedRange','singleScopeDate','validScopeRange','inDateRange','scopeRangeKey','scopeRangeLabel','selectedGroup','inCurrentScope','batchIdentityScope','eventsForTask','liveEvents','taskSnapshot','taskWithSnapshot','taskIndex','allTasks','statusPill','tidMarkup','personErrorScopeKey','addPersonErrorEntry','ensurePersonErrorIndex','personErrorMatches','closePersonErrorDetail','togglePersonErrorDetail','renderPersonErrorDetail','renderPersonStats','bindOverviewEvents'];
  vm.createContext(context);vm.runInContext(helpers.map(extract).join('\n'),context);
  const realTid=context.tidMarkup;context.tidMarkup=task=>{stats.tidHtml++;return realTid(task);};
  context.bindOverviewEvents();
  return {c:context,nodes,stats,handlers,
    scope({from='2026-10-02',to=from,group='g01',mode='single',profile={name:'管理员',role:'admin'}}={}){nodes.get('scopeDateFrom').value=from;nodes.get('scopeDateTo').value=to;nodes.get('scopeGroup').value=group;context.activeMode=mode;context.profile=profile;context.snapshotCache=new WeakMap();},
    ids(group='g01',owner=OWNER,tag=TAG){return plain(context.personErrorMatches(JSON.stringify([group,owner]),tag).map(row=>row.task.id)).sort();},
    chip(group='g01',owner=OWNER,tag=TAG){return nodes.get('personStatsBody').buttons.find(button=>button.dataset.key===encodeURIComponent(JSON.stringify([group,owner]))&&button.dataset.tag===tag);},
    html(){return nodes.get('personErrorDetailRow')?.innerHTML||'';}
  };
}

const fixture=makeFixture(), original=JSON.stringify(fixture.state), h=harness(fixture.state), c=h.c;
h.scope();
const expected=['boundary-end','boundary-start','first-day','reassigned','repaired-next-day'];
check('first-QC tag resolves exact task IDs independent of import/submission date',h.ids(),expected);
check('secondary tag shows only its matching task',h.ids('g01',OWNER,OTHER_TAG),['first-day']);
check('same-name other group cannot contaminate selected group',h.ids('g02'),[]);
check('same-name multi-shot task cannot contaminate single-shot',h.ids('g06'),[]);
check('another annotator has a distinct cohort',h.ids('g01','刘书通'),['other-person']);
check('reassignment preserves first-QC contributor even though current assignee differs',h.ids('g01','接手同学'),[]);
check('date/review/rejection/release/deleted exclusions are exact',h.ids().filter(id=>['second-fail-ignored','explicit-rejection','legacy-rejection','no-level','empty-tags','invalid-date','released-without-review','released-restarted','deleted-task'].includes(id)),[]);
h.scope({from:'2026-10-03'});check('repair pass is not treated as a new first QC',h.ids(),['next-midnight']);
h.scope({from:'2026-10-04'});check('later repeated fail does not create a first-QC tag',h.ids(),[]);
h.scope({from:'2026-10-05'});check('release restart contributes to new actual annotator only',h.ids('g01','接手同学'),['released-restarted']);check('release removes original annotator attribution',h.ids(),[]);
h.scope({from:'2026-10-02',to:'2026-10-03'});check('inclusive two-day range keeps one entry per task',h.ids(),[...expected,'next-midnight'].sort());
h.scope({from:'',to:'2026-10-02'});check('open lower date bound',h.ids(),expected);
h.scope({from:'2026-10-03',to:''});check('open upper date bound',h.ids(),['next-midnight']);
h.scope({from:'2026-10-03',to:'2026-10-02'});check('invalid date range gives no task details',h.ids(),[]);
h.scope({group:'g02'});check('switching group uses its own same-name cohort',h.ids('g02'),['same-name-other-group']);
h.scope({group:'all'});check('all-group scope still keeps individual group keys separate',h.ids(),expected);check('all-group scope exposes permitted other group separately',h.ids('g02'),['same-name-other-group']);
h.scope({group:'all',mode:'multi'});check('multi-shot independently resolves task IDs',h.ids('g06'),['same-name-other-mode']);check('multi-shot excludes all single-shot tasks',h.ids(),[]);
for(const role of ['annotation','qc']) {
  h.scope({group:'all',profile:{name:OWNER,role,groupId:'g01',mode:'single'}});
  check(`${role} scope cannot read other group's tags`,h.ids('g02'),[]);
  check(`${role} scope retains own group`,h.ids(),expected);
}
h.scope();c.renderPersonStats();
check('ordinary person statistics does not mount any detail row',h.stats.mounts,0);
check('ordinary person statistics produces no task-row HTML',h.stats.tidHtml,0);
const chip=h.chip();assert.ok(chip,'real personal tag button rendered');
check('displayed chip count equals exact drilldown task count',chip.textContent,`${TAG}×5`);
const contributionsBeforeOpen=h.stats.contributions;c.togglePersonErrorDetail(chip);
check('opening uses existing person-stat index without a second global scan',h.stats.contributions,contributionsBeforeOpen);
check('opened detail lists exact selected task IDs',plain(c.personErrorDetail.rows.map(row=>row.task.id)).sort(),expected);
check('click updates expanded semantics',chip.getAttribute('aria-expanded'),'true');
assert.match(h.html(),/合成影片/);assert.match(h.html(),/首检组长/);assert.match(h.html(),/请修复模糊画面/);assert.match(h.html(),/2026-10-02/);assert.match(h.html(),/验收通过/);assert.match(h.html(),/data-action="copy"/);
cases.push('detail displays film, actual reviewer, first-QC time, note, latest status and copy action');
c.togglePersonErrorDetail(chip);check('same tag second click collapses',c.personErrorDetail,null);check('collapsed detail DOM removed',h.html(),'');check('collapse resets aria-expanded',chip.getAttribute('aria-expanded'),'false');
c.togglePersonErrorDetail(chip);c.togglePersonErrorDetail(h.chip('g01',OWNER,OTHER_TAG));check('another tag replaces detail rather than accumulating panels',c.personErrorDetail.rows.map(row=>row.task.id),['first-day']);check('one detail panel only',h.nodes.has('personErrorDetailRow'),true);
c.closePersonErrorDetail(true);check('explicit close restores chip keyboard focus',h.chip('g01',OWNER,OTHER_TAG).focused,true);
h.handlers.get('document:click')({target:h.chip()});check('actual delegated chip handler opens matching detail',c.personErrorDetail.tag,TAG);
h.handlers.get('document:click')({target:h.chip()});check('actual delegated chip handler toggles closed',c.personErrorDetail,null);
h.handlers.get('document:click')({target:h.chip()});const close=h.nodes.get('personErrorDetailRow').buttons.find(button=>button.dataset.action==='close-person-error-tids');h.handlers.get('document:click')({target:close});check('actual delegated close button removes detail',c.personErrorDetail,null);
h.handlers.get('document:click')({target:h.chip()});let prevented=false;h.handlers.get('personStatsBody:keydown')({key:'Escape',target:h.chip(),preventDefault(){prevented=true;}});check('actual Escape handler closes and prevents default',[c.personErrorDetail,prevented],[null,true]);
for(const change of [{from:'2026-10-03'},{group:'g02'},{mode:'multi',group:'all'},{profile:{name:'新身份',role:'admin'}}]) {
  h.scope();c.renderPersonStats();c.togglePersonErrorDetail(h.chip());h.scope(change);c.renderPersonErrorDetail();check(`scope change closes stale panel ${JSON.stringify(change)}`,c.personErrorDetail,null);
}
h.scope();c.renderPersonStats();c.togglePersonErrorDetail(h.chip());c.renderPersonStats();check('same-scope redraw restores open tag and exact rows',c.personErrorDetail.rows.map(row=>row.task.id).sort(),expected);
check('input synthetic fixture unchanged',JSON.stringify(fixture.state),original);
check('real app calculations never mutate loaded task/event history',JSON.stringify(c.state),original);

// Metadata displayed in the read-only panel must be escaped, including copied TIDs.
const attack=makeFixture(),evil='<img src=x onerror="alert(1)"> & \'quoted\'';
attack.add('escaped',{tid:evil,movie:evil,owner:evil,reviews:[attack.fail('2026-10-02',{tags:[evil],note:evil,actor:evil})]});
const safe=harness(attack.state);safe.scope();safe.c.renderPersonStats();const safeChip=safe.chip('g01',evil,evil);assert.ok(safeChip);safe.c.togglePersonErrorDetail(safeChip);
assert.ok(!safe.html().includes('<img'));assert.ok(safe.html().includes('&lt;img'));assert.ok(safe.html().includes('&quot;alert(1)&quot;'));assert.ok(safe.html().includes('&#039;quoted&#039;'));cases.push('task, film, person, tag, reviewer, note and copy attributes remain HTML escaped');

// 10,003 matching synthetic tasks: first aggregation is measured, paging is bounded.
const big={version:3,tasks:[],events:[],batches:[],preferences:{}};
for(let i=0;i<10003;i++) {
  const id=`large-${String(i).padStart(5,'0')}`;big.tasks.push({id,tid:id,movie:'性能合成影片',mode:'multi',groupId:'g06',date:'2026-08-01',createdAt:at('2026-08-01')});
  big.events.push({id:id+'-claim',taskId:id,type:'claim',actor:OWNER,actorRole:'annotation',assignee:OWNER,at:at('2026-10-01'),workflowVersion:3},{id:id+'-submit',taskId:id,type:'submit',actor:OWNER,actorRole:'annotation',submissionKind:'initial',at:at('2026-10-01','10:00:00'),workflowVersion:3},{id:id+'-qc',taskId:id,type:'qc_fail',actor:'性能组长',actorRole:'qc',pLevel:'P1',tags:[TAG],note:'性能合成说明',at:at('2026-10-02'),workflowVersion:3});
}
const large=harness(big);large.scope({mode:'multi',group:'g06'});const start=performance.now();large.c.renderPersonStats();const aggregateMs=performance.now()-start;
check('10,003-task unopened panel has zero task HTML',large.stats.tidHtml,0);check('10,003-task aggregation performs one contributor pass per task',large.stats.contributions,10003);
const openStart=performance.now();large.c.togglePersonErrorDetail(large.chip('g06'));const openMs=performance.now()-openStart;
check('large cohort open contains all correct task references',large.c.personErrorDetail.rows.length,10003);check('large cohort open renders only 20 task rows',large.stats.tidHtml,20);check('cached open performs no contributor rescan',large.stats.contributions,10003);
const originalRows=large.c.personErrorDetail.rows;large.stats.tidHtml=0;large.c.personErrorDetail.page=2;large.c.renderPersonErrorDetail();check('page two renders exactly 20 task rows',large.stats.tidHtml,20);check('page two reuses result reference',large.c.personErrorDetail.rows===originalRows,true);check('page two performs no global contributor scan',large.stats.contributions,10003);
const nextButton=large.nodes.get('personErrorDetailRow').buttons.find(button=>button.dataset.action==='person-error-page'&&button.dataset.page==='3');large.handlers.get('document:click')({target:nextButton});check('actual delegated next-page handler renders requested page',large.c.personErrorDetail.page,3);check('actual delegated pagination retains cached cohort',large.c.personErrorDetail.rows===originalRows,true);
large.stats.tidHtml=0;large.c.personErrorDetail.page=501;large.c.renderPersonErrorDetail();check('last page renders exactly three task rows',large.stats.tidHtml,3);assert.match(large.html(),/第 501 \/ 501 页/);
large.stats.tidHtml=0;large.c.personErrorDetail.page=5000;large.c.renderPersonErrorDetail();check('page beyond end clamps safely',large.c.personErrorDetail.page,501);check('clamped last page remains bounded',large.stats.tidHtml,3);
large.c.state={...large.c.state,tasks:large.c.state.tasks.slice(0,21),events:large.c.state.events.slice(0,63)};large.stats.tidHtml=0;large.c.renderPersonStats();check('new snapshot refreshes match set and clamps pagination', [large.c.personErrorDetail.rows.length,large.c.personErrorDetail.page,large.stats.tidHtml],[21,2,1]);
large.c.closePersonErrorDetail();large.stats.tidHtml=0;large.c.renderPersonErrorDetail();check('closed panel rerender makes no task DOM',large.stats.tidHtml,0);

console.log(JSON.stringify({ok:true,checks:cases.length,cases,performance:{syntheticTasks:10003,aggregateMs:Math.round(aggregateMs),openMs:Math.round(openMs),pageSize:20},productionDataWrites:0},null,2));
