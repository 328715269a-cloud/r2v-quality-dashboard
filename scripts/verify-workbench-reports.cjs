'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module'),crypto=require('node:crypto');
const repo=path.resolve(__dirname,'..');
// Reuse the established report regression against the formal module; the only
// changed expectations are the additive import-audit and personal daily exports.
const legacy=path.join(repo,'scripts/verify-group-workbench-reports.cjs'),m=new Module(legacy,module);
m.filename=legacy;m.paths=module.paths;
m._compile(fs.readFileSync(legacy,'utf8').replaceAll('../group-workbench-beta/','../group-workbench/').replace("['tasks','events','packages','movies','groups','daily']","['imports','tasks','events','packages','movies','groups','daily','personDaily']"),legacy);
const Flow=require(path.join(repo,'group-workbench/workflow.js')),Reports=require(path.join(repo,'group-workbench/reports.js')),IO=require(path.join(repo,'group-workbench/data-io.js'));
const tasks=[['old','REUSE','wrong','single','g01','b1'],['new','REUSE','correct','single','g01','b2'],['other','OTHER','多镜影片','multi','g06','b3']].map(([id,tid,movie,mode,groupId,batchId])=>({id,tid,movie,mode,groupId,batchId,date:'2026-09-11',createdAt:'2026-09-11T01:00:00Z',createdBy:'admin'}));
const events=tasks.map(task=>({id:'dispatch-'+task.id,taskId:task.id,type:'dispatch',actor:'admin',at:task.createdAt}));
events.push({id:'deleted',taskId:'old',type:'task_deleted',batchId:'b1',actor:'admin',at:'2026-09-11T02:00:00Z',note:'误导入，保留历史'});
const batches=tasks.map(task=>({id:task.batchId,kind:'import',taskIds:[task.id],mode:task.mode,groupId:task.groupId,movie:task.movie,date:task.date,createdBy:'admin',createdAt:task.createdAt}));
const state={tasks,events,batches},original=JSON.stringify(state),auditTasks=tasks.map(task=>({...task,...Flow.project(task,events)}));
const active=auditTasks.filter(task=>!task.deleted),report=Reports.build({state,tasks:active,auditTasks,mode:'single',statusMeta:Flow.STATUS_META});
assert.equal(report.tasks.rows.length,1);assert.equal(report.tasks.rows[0].taskId,'new');
assert.equal(report.movies.rows.length,1);assert.equal(report.movies.rows[0].movie,'correct');
assert.equal(report.groups.rows[0].totalTIDs,1);assert.equal(report.daily.rows.reduce((n,row)=>n+row.importedTIDs,0),1);
assert.equal(report.imports.rows.length,2);const deleted=report.imports.rows.find(row=>row.batchId==='b1');
assert.equal(deleted.recordStatus,'已删除');assert.equal(deleted.importedCount,1);assert.equal(deleted.activeCount,0);assert.equal(deleted.deletedBy,'admin');assert.equal(deleted.deletionReason,'误导入，保留历史');
assert.deepEqual(JSON.parse(deleted.originalTasksJSON),[tasks[0]]);assert.equal(JSON.parse(deleted.fullTimelineJSON).length,2);assert.equal(JSON.parse(deleted.latestTasksJSON)[0].deleted,true);
assert.equal(report.events.rows.length,3);assert.equal(report.events.rows.find(row=>row.type==='task_deleted').currentTid,'REUSE');assert(!report.events.rows.some(row=>row.taskId==='other'));
assert.equal(IO.parseTable(IO.csv(report.imports.columns,report.imports.rows)).records.length,3);
assert.equal(JSON.stringify(state),original);assert.equal(Flow.counts(auditTasks).total,2);
const sourceHashes=Object.fromEntries(['app.js','index.html','styles.css','reports.js','workflow.js','shared-store.js','data-io.js'].map(file=>['group-workbench/'+file,crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'group-workbench',file))).digest('hex')]));
fs.writeFileSync(path.join(__dirname,'reports-validation.json'),JSON.stringify({ok:true,legacyRegression:'passed with additional imports and personDaily reports',deletionAuditAssertions:22,sourceHashes},null,2));
console.log(JSON.stringify({ok:true,deletionAuditAssertions:22}));
