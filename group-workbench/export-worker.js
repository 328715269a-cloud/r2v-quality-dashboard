(function (root) {
  'use strict';
  function createExporter(Flow, Reports, IO) {
    function generate(request, source, backup, progress = () => {}) {
      const {kind, scope, groups, statusMeta, eventLabels} = request;
      if (!scope?.profile) throw new Error('作业身份已失效，请重新进入后导出。');
      if (kind === 'backup' && scope.profile.role !== 'admin') throw new Error('完整备份仅管理员可下载。');
      const canView = id => ['admin', 'acceptance'].includes(scope.profile.role) || id === scope.profile.groupId;
      const groupNames = new Map(groups.map(group => [group.id, group.name]));
      const groupLabel = id => groupNames.get(id) || '未知小组';
      const localDate = value => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      };
      const histories = new Map(), general = [], order = new Map();
      (source.events || []).forEach((event, index) => {
        if (!histories.has(event.taskId)) histories.set(event.taskId, []);
        histories.get(event.taskId).push(event);
        if (!event.taskId) general.push(event);
        order.set(event, index);
      });
      const history = (task, includeGeneral = false) => {
        const own = histories.get(task.id) || [];
        if (!includeGeneral || !general.length) return own;
        const result = [];let left = 0, right = 0;
        while (left < own.length || right < general.length) {
          if (right >= general.length || left < own.length && order.get(own[left]) < order.get(general[right])) result.push(own[left++]);
          else result.push(general[right++]);
        }
        return result;
      };
      progress('正在计算最新任务状态…');
      if (kind === 'backup') {
        const result = {...backup};
        if (backup.state) result.latestTasks = source.tasks.map(task => ({...task, ...Flow.project(task, history(task, true))}));
        progress('正在生成完整备份文件…');
        return {blob: new Blob([JSON.stringify(result, null, 2)], {type: 'application/json;charset=utf-8'}), rowCount: source.tasks.length};
      }
      const visible = (source.tasks || []).filter(task => canView(task.groupId)).map(task => ({...task, ...Flow.project(task, history(task))}));
      if (kind === 'legacyPackages') {
        const tasks = visible.filter(task => !task.deleted), visibleIds = new Set(tasks.map(task => task.id));
        const rows = (source.batches || []).filter(batch => batch.kind === 'handoff' && canView(batch.groupId) && (batch.mode || groups.find(group => group.id === batch.groupId)?.defaultMode) === scope.mode).map(batch => {
          const taskIds = (batch.taskIds || []).filter(id => visibleIds.has(id)), ids = new Set(taskIds);
          const events = source.events.filter(event => ids.has(event.taskId) && event.packageId === batch.id), claims = events.filter(event => event.type === 'package_claimed'), members = tasks.filter(task => ids.has(task.id));
          return {建包记录ID:batch.id,通航包名或编号:batch.packageName,当时影片包:batch.movie,当前影片包:[...new Set(members.map(task=>task.movie))].join('、'),小组:groupLabel(batch.groupId),去向:batch.stage==='qc'?'质检':'验收',任务数:taskIds.length,当时TID:JSON.stringify((batch.tids||[]).filter((tid,index)=>visibleIds.has((batch.taskIds||[])[index]))),当前TID:JSON.stringify(members.map(task=>task.tid)),建包人:batch.createdBy,建包时间:batch.createdAt,领取人:[...new Set(claims.map(event=>event.actor))].join('、'),领取条数:new Set(claims.map(event=>event.taskId)).size,完整建包JSON:JSON.stringify({...batch,taskIds}),完整流水JSON:JSON.stringify(events)};
        });
        return {blob: new Blob([IO.csv(Object.keys(rows[0] || {建包记录ID:'',通航包名或编号:''}), rows)], {type:'text/csv;charset=utf-8'}), rowCount:rows.length};
      }
      const inScope = task => task.mode === scope.mode && (scope.groupId === 'all' || task.groupId === scope.groupId);
      const auditTasks = visible.filter(inScope), tasks = auditTasks.filter(task => !task.deleted).map(task => ({...task, statusLabel:Flow.label(task)}));
      const reportGroups = groups.filter(group => group.defaultMode === scope.mode && (scope.groupId === 'all' || group.id === scope.groupId) && canView(group.id));
      const eventLabel = event => Flow.isReworkAssignment(event)?'分配代修':Flow.isQcReject(event)?'质检拒绝并废弃':Flow.isAcceptanceReject(event)?'验收拒绝并废弃':event.type==='group_daily_edit'?'修改每日小组人数与总量':eventLabels[event.type]||event.type;
      const eventDetail = event => {
        if(event.type==='group_daily_edit')return `${event.date} · ${groupLabel(event.groupId)} · 负责人 ${event.after.leader} · 总量 ${event.after.total} · 人数 ${event.after.headcount===null?'自动识别':event.after.headcount} · ${event.note||''}`;
        if(Flow.isReworkAssignment(event))return `${event.fromAssignee} → ${event.assignee} · ${event.note||'请假代修'}`;
        const parts=[];if(event.round)parts.push(`第 ${event.round} 轮`);if(event.pLevel)parts.push(event.pLevel);if(event.tags?.length)parts.push(event.tags.join('、'));
        if(event.before&&event.after){if(event.before.tid!==event.after.tid)parts.push(`TID：${event.before.tid} → ${event.after.tid}`);if(event.before.movie!==event.after.movie)parts.push(`影片：${event.before.movie} → ${event.after.movie}`);}
        if(event.previousAssignee&&event.assignee&&event.previousAssignee!==event.assignee)parts.push(`接续演示身份：${event.previousAssignee} → ${event.assignee}`);
        if(event.packageName)parts.push(`建包批次：${event.packageName}`);if(event.stage)parts.push(event.stage==='qc'?'送质检':'送验收');if(event.packageRound)parts.push(`第 ${event.packageRound} 轮`);if(event.route)parts.push(event.route==='qc'?'质检自行修改':'标注修改后重新质检');
        if(event.note)parts.push(event.note);return parts.join(' · ')||'已记录';
      };
      progress('正在生成所选报表…');
      const reports = Reports.build({state:source,tasks,auditTasks,groups:reportGroups,mode:scope.mode,statusMeta,groupLabel,eventLabel,eventDetail,localDate,kind});
      let report = reports[kind];
      if (kind === 'summary') {
        const columns = new Map([...reports.groups.columns, ...reports.movies.columns].map(column => [column.key, column]));
        report = {columns:[{key:'scope',label:'汇总层级'}, ...columns.values()],rows:[...reports.groups.rows.map(row=>({...row,scope:'小组'})),...reports.movies.rows.map(row=>({...row,scope:'影片'}))]};
      }
      if (!report) throw new Error('未找到此导出类型。');
      if (scope.range === 'scope') {
        if (scope.dateFrom && scope.dateTo && scope.dateFrom > scope.dateTo) throw new Error('请修正日期区间后再导出。');
        report = {...report, rows:report.rows.filter(row => {const date=String(row.date);return !!date&&(!scope.dateFrom||date>=scope.dateFrom)&&(!scope.dateTo||date<=scope.dateTo);})};
      }
      progress('正在生成下载文件…');
      return {blob:new Blob([IO.csv(report.columns,report.rows)],{type:'text/csv;charset=utf-8'}),rowCount:report.rows.length};
    }
    return {generate};
  }
  if (typeof module === 'object' && module.exports) { module.exports = {createExporter}; return; }
  let job = null, exporter = null;
  root.onmessage = event => {
    const message = event.data;
    try {
      if (message.type === 'start') {
        if (job) throw new Error('已有导出正在生成。');
        root.window = root;
        for (const dependency of message.dependencies) {
          const url = new URL(dependency, root.location.href);
          if (url.origin !== root.location.origin) throw new Error('导出组件必须来自当前工作台。');
          root.importScripts(url.href);
        }
        exporter = createExporter(root.WorkbenchFlow, root.WorkbenchReports, root.WorkbenchDataIO);
        job = {request:message.request,state:{...message.state,tasks:[],events:[],batches:[]},backup:message.backup};
        if (job.backup && Object.hasOwn(job.backup, 'transactions')) job.backup.transactions = [];
      } else if (message.type === 'chunk') {
        if (!job || !['tasks','events','batches','transactions'].includes(message.collection)) throw new Error('导出数据传输异常。');
        const rows = message.collection === 'transactions' ? job.backup.transactions : job.state[message.collection];
        for (const row of message.rows) rows.push(row);
      } else if (message.type === 'generate') {
        if (!job) throw new Error('导出数据尚未准备好。');
        if (job.backup?.state) job.backup.state = job.state;
        const result = exporter.generate(job.request, job.state, job.backup, text => root.postMessage({type:'progress',text}));
        root.postMessage({type:'complete',...result});job = null;
      }
    } catch (error) {job = null;root.postMessage({type:'error',message:error.message || '导出生成失败，请重试。'});}
  };
}(typeof self !== 'undefined' ? self : null));
