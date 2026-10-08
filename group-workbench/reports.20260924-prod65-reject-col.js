(function (root, factory) {
  'use strict';
  const flow = typeof module === 'object' && module.exports ? require('./workflow.js') : root.WorkbenchFlow;
  const api = factory(flow);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkbenchReports = api;
}(typeof window !== 'undefined' ? window : null, function (flow) {
  'use strict';

  const columns = entries => entries.map(([key, label]) => ({ key, label }));
  const json = value => JSON.stringify(value == null ? null : value);
  const unique = values => Array.from(new Set(values.filter(value => value !== undefined && value !== null && value !== '')));
  const text = value => value == null ? '' : String(value);
  const effectiveEvents = history => flow.effectiveEvents(history || []);
  const modeLabel = value => value === 'multi' ? '多镜头' : value === 'single' ? '单镜头' : text(value);
  const seedMovies = Object.freeze(['星河远征', '风起长安', '云海纪事', '逐光计划', '城南旧影', '深蓝航线', '奇境档案', '森林来信', '月面旅人', '时光拼图']);
  const isReworkAssignment = event => event?.type === 'claim' && event.assignmentKind === 'rework_transfer';
  function assignmentPairs(history) {
    return new Set((history || []).filter(isReworkAssignment).map(event => json([event.taskId || '', text(event.fromAssignee).trim(), text(event.assignee).trim()])));
  }
  function identityAliasPair(event, transfers) {
    if (!event || isReworkAssignment(event) || event.fromAssignee || event.identityAlias === false
      || !['claim','submit','annotator_reject'].includes(event.type) || (event.actorRole && event.actorRole !== 'annotation')) return null;
    const previous = text(event.previousAssignee).trim(), next = text(event.actor).trim();
    if (!previous || !next || previous === next || transfers.has(json([event.taskId || '', previous, next]))) return null;
    const legacy = !/^\p{Script=Han}+$/u.test(previous) && /^\p{Script=Han}+$/u.test(next);
    return event.identityAlias === true || legacy ? [previous, next] : null;
  }

  function annotationContributors(history = []) {
    history = effectiveEvents(history);
    // 释放：这条 case 回到未认领重新走流程，释放前产生的标注 / 质检 / 验收记录全部作废，
    // 只统计最后一次释放之后的记录，重新认领后的提交按「首次标完」计入而不是返修。
    let releaseCut = -1;
    history.forEach((event, index) => { if (event.type === 'admin_release') releaseCut = index; });
    if (releaseCut >= 0) history = history.slice(releaseCut + 1);
    const transfers = assignmentPairs(history), aliases = new Map();
    function nameOf(value) {
      let name = text(value).trim();
      const seen = new Set();
      while (aliases.has(name) && !seen.has(name)) { seen.add(name); name = aliases.get(name); }
      return name;
    }
    history.forEach(event => {
      const pair = identityAliasPair(event, transfers);
      if (!pair) return;
      const from = nameOf(pair[0]), to = nameOf(pair[1]);
      if (from && to && from !== to) aliases.set(from, to);
    });
    const result = { initial: null, submissions: [], rework: [], firstQc: null, firstAcceptance: null, firstAcceptanceDecision: null };
    const rework = new Map();
    let lastSubmit = null, firstClaim = null;
    const identity = event => ({ name: nameOf(event?.actor), rawName: text(event?.actor) });
    history.forEach(event => {
      if (!event || isReworkAssignment(event)) return;
      const annotation = !event.actorRole || event.actorRole === 'annotation';
      if (event.type === 'claim' && annotation && !firstClaim) firstClaim = identity(event);
      if (event.type === 'submit' && annotation) {
        const kind = !result.submissions.length && (!event.submissionKind || event.submissionKind === 'initial') ? 'initial' : 'rework';
        const entry = { ...identity(event), at: text(event.at), eventId: text(event.id), kind };
        result.submissions.push(entry); lastSubmit = entry;
        if (kind === 'initial') result.initial = { name: entry.name, rawName: entry.rawName, at: entry.at, eventId: entry.eventId };
        else {
          if (!rework.has(entry.name)) rework.set(entry.name, { name: entry.name, count: 0, events: [] });
          const worker = rework.get(entry.name); worker.count += 1;
          worker.events.push({ at: entry.at, eventId: entry.eventId, rawName: entry.rawName });
        }
      }
      // 首检：质检「拒绝，直接废弃」不计入首检分母，与错误标签分析口径保持一致
      // （拒绝时没有 P 级也没有错误标签，计进分母只会白白拉低首检准确率）。
      // 注意：拒绝既可能是 qc_reject 事件，也可能是带「[质检拒绝]」前缀的 qc_fail，
      // 统一用 flow.isQcReject 判定，不能只按事件类型过滤。
      if (['qc_pass','qc_fail','qc_reject'].includes(event.type) && !result.firstQc && !flow.isQcReject(event)) {
        const owner = lastSubmit || firstClaim || { name: '', rawName: '' };
        result.firstQc = { name: owner.name, rawName: owner.rawName, at: text(event.at), eventId: text(event.id), type: event.type, pLevel: text(event.pLevel), tags: JSON.parse(json(event.tags || [])), note: text(event.note) };
      }
      if (event.type === 'acceptance_pass' && !result.firstAcceptance) {
        const owner = lastSubmit || firstClaim || { name: '', rawName: '' };
        result.firstAcceptance = { name: owner.name, rawName: owner.rawName, at: text(event.at), eventId: text(event.id) };
      }
      if (['acceptance_pass', 'acceptance_fail', 'acceptance_reject'].includes(event.type) && !result.firstAcceptanceDecision) {
        const owner = lastSubmit || firstClaim || { name: '', rawName: '' };
        result.firstAcceptanceDecision = { name: owner.name, rawName: owner.rawName, at: text(event.at), eventId: text(event.id), type: flow.isAcceptanceReject(event) ? 'acceptance_reject' : event.type };
      }
    });
    result.rework = Array.from(rework.values());
    return result;
  }

  function movieTitle(task) {
    const original = text(task?.movie);
    const seed = /^seed_task_(\d{8})_(g\d{2})_[1-8]$/.exec(text(task?.id));
    if (!seed) return original;
    const title = seedMovies[Number(seed[2].slice(1)) - 1];
    if (!title) return original;
    const date = `${seed[1].slice(0, 4)}-${seed[1].slice(4, 6)}-${seed[1].slice(6, 8)}`;
    try { rangeDate(date); } catch (_) { return original; }
    // This exact guard removes only the original seed suffix. Imported titles,
    // sequels and renamed seeds retain every character of their current name.
    return original === `${title} · ${date.slice(5)}` ? title : original;
  }

  function movieProgress(input = {}) {
    const tasks = (input.tasks || []).filter(task => !task.deleted && (!input.mode || task.mode === input.mode));
    const groupName = typeof input.groupLabel === 'function' ? input.groupLabel : id => text(id);
    const bundles = new Map();
    tasks.forEach(task => {
      const movie = movieTitle(task), mode = text(task.mode), key = json([mode, movie]);
      if (!bundles.has(key)) bundles.set(key, { key, movie, mode, tasks: [] });
      bundles.get(key).tasks.push(task);
    });
    return Array.from(bundles.values()).map(bundle => {
      const members = bundle.tasks;
      const groupIds = unique(members.map(task => task.groupId));
      const statuses = members.map(task => text(task.status) || 'unknown');
      const statusCounts = Object.fromEntries(unique([...Object.keys(input.statusMeta || {}), ...statuses]).map(status => [status, 0]));
      statuses.forEach(status => { statusCounts[status] += 1; });
      const total = members.length, accepted = members.filter(task => task.status === 'accepted').length, rejected = members.filter(task => task.status === 'rejected').length;
      const active = total - accepted - rejected;
      return {
        key: bundle.key, movie: bundle.movie, mode: bundle.mode, groupIds,
        groups: groupIds.map(groupName), sourceNames: unique(members.map(task => text(task.movie))), taskIds: members.map(task => task.id),
        total, accepted, rejected, active, closed: total > 0 && active === 0,
        closureRate: total ? (accepted + rejected) / total * 100 : 0,
        completionRate: total ? accepted / total * 100 : 0, statusCounts
      };
    }).filter(row => !input.groupId || input.groupId === 'all' || row.groupIds.includes(input.groupId))
      .sort((a, b) => a.movie.localeCompare(b.movie, 'zh-CN') || a.mode.localeCompare(b.mode));
  }

  function qcOperator(history) {
    history = effectiveEvents(history);
    const types = new Set(['qc_pass', 'qc_fail', 'qc_reject', 'reject_confirm', 'reject_return', 'acceptance_pass', 'acceptance_reject', 'acceptance_route', 'qc_repair_done', 'sent_acceptance']);
    for (let index = (history || []).length - 1; index >= 0; index -= 1) {
      const event = history[index];
      if (!event || (Object.hasOwn(event, 'actorRole') && event.actorRole !== 'qc')) continue;
      const packageAction = ['package_built', 'package_claimed'].includes(event.type) && ['qc', 'acceptance'].includes(event.stage);
      if ((!types.has(event.type) && !packageAction && !isReworkAssignment(event)) || typeof event.actor !== 'string' || !event.actor.trim()) continue;
      return { name: event.actor, at: text(event.at), type: event.type };
    }
    return { name: '', at: '', type: '' };
  }

  function localDateOf(value, callback) {
    if (!value) return '';
    if (typeof callback === 'function') return text(callback(value));
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function groupDailyModel(input) {
    const mode = input.mode || '';
    const groups = (input.groups || []).filter(group => !mode || (group.defaultMode || group.mode) === mode);
    const groupMap = new Map(groups.map(group => [group.id, group]));
    const tasks = (input.tasks || []).filter(task => !task.deleted && groupMap.has(task.groupId) && (!mode || task.mode === mode));
    const taskMap = new Map(tasks.map(task => [task.id, task]));
    const allEvents = effectiveEvents(input.state?.events || []);
    const transfers = assignmentPairs(allEvents);
    const settings = allEvents.map((event, order) => ({ event, order })).filter(({ event }) =>
      event.type === 'group_daily_edit' && groupMap.has(event.groupId)
      && event.mode === (groupMap.get(event.groupId).defaultMode || groupMap.get(event.groupId).mode || mode)
      && (!mode || event.mode === mode) && /^\d{4}-\d{2}-\d{2}$/.test(event.date || '')
    ).sort((a, b) => (Date.parse(a.event.at) || 0) - (Date.parse(b.event.at) || 0) || a.order - b.order).map(({ event }) => event);
    const groupSettings = new Map(groups.map(group => [group.id, settings.filter(event => event.groupId === group.id)]));
    const dates = new Map(groups.map(group => [group.id, new Set()]));
    const aliases = new Map(groups.map(group => [group.id, new Map()]));
    const completions = new Map(groups.map(group => [group.id, new Map()]));
    const seenSubmissions = new Set();
    const activity = [];
    // 当日质检通过 / 验收通过：与作业记录同一口径（首次通过、按 TID 去重）
    const qcPassDaily = new Map(groups.map(group => [group.id, new Map()]));
    const acceptanceDaily = new Map(groups.map(group => [group.id, new Map()]));
    // 整体去重（所选范围内一条 case 只算一次）：与当日口径共用同一套「小组 × 日期 × TID」
    // 分桶，差别只在汇总方式——当日口径逐日相加（跨天重做会重复累加），整体去重对
    // 所选范围内的日期取并集（同一条 case 无论做了几次都只算 1）。
    // 释放作废会清掉该 case 在所有日期上的记录，重走后按新记录重新计入，不会双计。
    const passKeyOf = task => text(task && task.tid).trim() || text(task && task.id);
    function unionPass(bucket, groupId, includes) {
      const byDate = bucket.get(groupId);
      const keys = new Set();
      if (!byDate) return keys;
      byDate.forEach((owners, date) => { if (includes(date)) owners.forEach((_, key) => keys.add(key)); });
      return keys;
    }
    function unionReject(bucket, groupId, includes) {
      const byDate = bucket.get(groupId);
      const keys = new Set();
      if (!byDate) return keys;
      byDate.forEach((row, date) => { if (includes(date) && row.rejected) row.rejected.forEach(id => keys.add(id)); });
      return keys;
    }
    function passBucket(bucket, groupId) {
      if (!bucket.has(groupId)) bucket.set(groupId, new Map());
      return bucket.get(groupId);
    }
    function addPass(bucket, groupId, date, key, taskId) {
      const byDate = passBucket(bucket, groupId);
      if (!byDate.has(date)) byDate.set(date, new Map());
      const owners = byDate.get(date);
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(taskId);
    }
    function clearPass(bucket, groupId, key, taskId) {
      const byDate = bucket.get(groupId);
      if (!byDate) return;
      byDate.forEach(owners => {
        const held = owners.get(key);
        if (!held) return;
        held.delete(taskId);
        if (!held.size) owners.delete(key);
      });
    }
    const dateOf = value => localDateOf(value, input.localDate);
    function rootName(groupId, name) {
      const parents = aliases.get(groupId);
      let current = name;
      const trail = [];
      while (parents.has(current) && parents.get(current) !== current) { trail.push(current); current = parents.get(current); }
      trail.forEach(item => parents.set(item, current));
      return current;
    }
    settings.forEach(event => dates.get(event.groupId).add(event.date));
    tasks.forEach(task => { const date = dateOf(task.createdAt || task.date); if (date) dates.get(task.groupId).add(date); });
    allEvents.forEach(event => {
      const task = taskMap.get(event.taskId);
      if (!task || event.type === 'group_daily_edit') return;
      const date = dateOf(event.at);
      if (date) dates.get(task.groupId).add(date);
      // 释放：这条 case 回到未认领重新走流程。此前产生的标注完成、返修次数
      // 与作业人数全部作废，重新认领后的提交按「首次标注完成」重新计入。
      if (event.type === 'admin_release') {
        seenSubmissions.delete(task.id);
        const releaseKey = passKeyOf(task);
        clearPass(qcPassDaily, task.groupId, releaseKey, task.id);
        clearPass(acceptanceDaily, task.groupId, releaseKey, task.id);
        const byDateAll = completions.get(task.groupId);
        if (byDateAll) byDateAll.forEach(row => {
          row.completed.delete(task.id); row.initial.delete(task.id);
          if (row.reworkBy) { row.rework -= row.reworkBy.get(task.id) || 0; row.reworkBy.delete(task.id); }
          // 释放后此前的标注拒绝同当作废：拒绝量与标注完成走同一套「释放即清零」规则
          if (row.rejected) { row.rejected.delete(task.id); if (row.rejectBy) { row.rejectActions -= row.rejectBy.get(task.id) || 0; row.rejectBy.delete(task.id); } }
        });
        for (let index = activity.length - 1; index >= 0; index -= 1) if (activity[index].task && activity[index].task.id === task.id) activity.splice(index, 1);
        return;
      }
      // 质检通过 / 验收通过：当日 · TID 去重（addPass 按「小组 × 日期 × TID」分桶，同一天重复通过只算 1 条）
      if (date && event.type === 'qc_pass') addPass(qcPassDaily, task.groupId, date, passKeyOf(task), task.id);
      if (date && event.type === 'acceptance_pass') addPass(acceptanceDaily, task.groupId, date, passKeyOf(task), task.id);
      if (isReworkAssignment(event) || !['claim', 'submit', 'annotator_reject'].includes(event.type) || (event.actorRole && event.actorRole !== 'annotation')) return;
      let submissionKind = '';
      if (event.type === 'submit') {
        submissionKind = !seenSubmissions.has(task.id) && (!event.submissionKind || event.submissionKind === 'initial') ? 'initial' : 'rework';
        seenSubmissions.add(task.id);
        if (date) {
          const byDate = completions.get(task.groupId);
          if (!byDate.has(date)) byDate.set(date, { completed: new Set(), initial: new Set(), rework: 0, reworkBy: new Map(), rejected: new Set(), rejectActions: 0, rejectBy: new Map() });
          const row = byDate.get(date); row.completed.add(task.id);
          if (submissionKind === 'initial') row.initial.add(task.id);
          else { row.rework += 1; row.reworkBy.set(task.id, (row.reworkBy.get(task.id) || 0) + 1); }
        }
      }
      // 标注拒绝：按拒绝发生当天落进统计范围，拒绝也算工作量，单独成列不与提交混计
      if (event.type === 'annotator_reject' && date) {
        const byDate = completions.get(task.groupId);
        if (!byDate.has(date)) byDate.set(date, { completed: new Set(), initial: new Set(), rework: 0, reworkBy: new Map(), rejected: new Set(), rejectActions: 0, rejectBy: new Map() });
        const row = byDate.get(date); row.rejected.add(task.id); row.rejectActions += 1;
        row.rejectBy.set(task.id, (row.rejectBy.get(task.id) || 0) + 1);
      }
      if (!date) return;
      const actor = text(event.actor).trim();
      if (!actor) return;
      const alias = identityAliasPair(event, transfers);
      if (alias) {
        const previous = rootName(task.groupId, alias[0]);
        const next = rootName(task.groupId, alias[1]);
        if (previous && previous !== next) aliases.get(task.groupId).set(previous, next);
      }
      activity.push({ groupId: task.groupId, date, actor, task, event, submissionKind });
    });
    const members = new Map(groups.map(group => [group.id, new Map()]));
    const people = new Map();
    activity.forEach(item => {
      const byDate = members.get(item.groupId);
      if (!byDate.has(item.date)) byDate.set(item.date, new Set());
      const name = rootName(item.groupId, item.actor);
      byDate.get(item.date).add(name);
      const key = json([item.groupId, item.date, name]);
      if (!people.has(key)) people.set(key, { groupId: item.groupId, mode: item.task.mode, date: item.date, name, completed: new Set(), initial: new Set(), rework: 0, submissionActions: 0, rejected: new Set(), rejectActions: 0, eventIds: [], rawNames: new Set(), submittedTimes: [] });
      const row = people.get(key); row.rawNames.add(item.actor);
      if (item.event.type === 'submit') {
        row.completed.add(item.task.id); row.submissionActions += 1;
        if (item.submissionKind === 'initial') row.initial.add(item.task.id); else row.rework += 1;
        if (item.event.id) row.eventIds.push(item.event.id);
        row.submittedTimes.push(text(item.event.at));
      }
      if (item.event.type === 'annotator_reject') { row.rejected.add(item.task.id); row.rejectActions += 1; }
    });
    const peopleRows = Array.from(people.values()).map(row => {
      const times = row.submittedTimes.slice().sort((a,b) => Date.parse(a) - Date.parse(b));
      const taskIds = Array.from(row.completed);
      return {
        groupId: row.groupId, mode: row.mode, date: row.date, name: row.name,
        completedTIDs: row.completed.size, initialSubmissionTIDs: row.initial.size, reworkSubmissionActions: row.rework,
        annotatorRejectTIDs: row.rejected.size, annotatorRejectActions: row.rejectActions,
        submissionActions: row.submissionActions, taskIds, tids: taskIds.map(id => text(taskMap.get(id)?.tid)),
        eventIds: row.eventIds, rawNames: Array.from(row.rawNames), firstSubmittedAt: times[0] || '', lastSubmittedAt: times.at(-1) || ''
      };
    }).sort((a,b) => a.date.localeCompare(b.date) || a.groupId.localeCompare(b.groupId) || a.name.localeCompare(b.name, 'zh-CN'));
    function applicableLeader(group, date) {
      const candidates = groupSettings.get(group.id).filter(event => (!date || event.date <= date) && text(event.after?.leader).trim());
      candidates.sort((a, b) => a.date.localeCompare(b.date));
      return candidates.at(-1)?.after.leader || group.leader || '待填写';
    }
    function day(group, date) {
      const history = groupSettings.get(group.id).filter(event => event.date === date);
      const latest = history.at(-1);
      const names = Array.from(members.get(group.id).get(date) || []).sort((a, b) => a.localeCompare(b, 'zh-CN'));
      const override = latest?.after?.headcount;
      const manual = typeof override === 'number' && Number.isFinite(override) && override >= 0 && Number.isInteger(override * 2);
      const total = latest?.after?.total;
      const done = completions.get(group.id).get(date), headcount = manual ? override : names.length;
      const completedTIDs = done?.completed.size || 0;
      const efficiencyIssue = completedTIDs > 0 && headcount === 0 ? 'completed_without_headcount' : headcount === 0 ? 'no_person_days' : '';
      return {
        groupId: group.id, date, leader: applicableLeader(group, date),
        total: Number.isSafeInteger(total) && total >= 0 ? total : null,
        autoHeadcount: names.length, headcount,
        headcountSource: manual ? 'manual' : 'auto', members: names, latestEditId: latest?.id || '',
        history: JSON.parse(json(history)), isAggregate: false,
        completedTIDs, initialSubmissionTIDs: done?.initial.size || 0, reworkSubmissionActions: done?.rework || 0,
        annotatorRejectTIDs: done?.rejected.size || 0, annotatorRejectActions: done?.rejectActions || 0,
        qcPassTIDs: qcPassDaily.get(group.id)?.get(date)?.size || 0, acceptancePassTIDs: acceptanceDaily.get(group.id)?.get(date)?.size || 0,
        uniqueInitialTIDs: done?.initial.size || 0, uniqueAnnotatorRejectTIDs: done?.rejected.size || 0,
        uniqueQcPassTIDs: qcPassDaily.get(group.id)?.get(date)?.size || 0,
        uniqueAcceptancePassTIDs: acceptanceDaily.get(group.id)?.get(date)?.size || 0,
        personDayEfficiency: headcount > 0 ? completedTIDs / headcount : null,
        efficiencyIssue, efficiencyIssueDates: efficiencyIssue === 'completed_without_headcount' ? [date] : []
      };
    }
    function aggregate(group, dateFrom = '', dateTo = '') {
      const includes = date => (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);
      const daily = Array.from(dates.get(group.id)).filter(includes).sort().map(value => day(group, value));
      const history = groupSettings.get(group.id).filter(event => includes(event.date));
      const withTotal = daily.filter(item => item.total !== null);
      const latest = history.slice().sort((a, b) => a.date.localeCompare(b.date)).at(-1);
      const headcount = daily.reduce((sum, item) => sum + item.headcount, 0);
      const completedTIDs = daily.reduce((sum, item) => sum + item.completedTIDs, 0);
      const efficiencyIssueDates = daily.flatMap(item => item.efficiencyIssueDates);
      const efficiencyIssue = efficiencyIssueDates.length ? 'completed_without_headcount' : headcount === 0 ? 'no_person_days' : '';
      return {
        groupId: group.id, date: '', leader: applicableLeader(group, dateTo),
        total: withTotal.length ? withTotal.reduce((sum, item) => sum + item.total, 0) : null,
        autoHeadcount: daily.reduce((sum, item) => sum + item.autoHeadcount, 0),
        headcount,
        headcountSource: daily.some(item => item.headcountSource === 'manual') ? 'manual' : 'auto',
        members: unique(daily.flatMap(item => item.members)).sort((a, b) => a.localeCompare(b, 'zh-CN')),
        latestEditId: latest?.id || '', history: JSON.parse(json(history)), isAggregate: true,
        completedTIDs, initialSubmissionTIDs: daily.reduce((sum, item) => sum + item.initialSubmissionTIDs, 0),
        reworkSubmissionActions: daily.reduce((sum, item) => sum + item.reworkSubmissionActions, 0),
        annotatorRejectActions: daily.reduce((sum, item) => sum + item.annotatorRejectActions, 0),
        qcPassTIDs: daily.reduce((sum, item) => sum + item.qcPassTIDs, 0), acceptancePassTIDs: daily.reduce((sum, item) => sum + item.acceptancePassTIDs, 0),
        // 首次标完一条 case 只会发生一次（记在首次提交那天，释放重走后重新记一次），
        // 逐日相加不会重复；质检通过 / 验收通过可能跨天多次达成，改成区间内取并集去重。
        uniqueInitialTIDs: daily.reduce((sum, item) => sum + item.uniqueInitialTIDs, 0),
        // 区间内同一条 case 被拒绝两次（退回后再次拒绝）也只算 1 条，取日期并集去重
        uniqueAnnotatorRejectTIDs: unionReject(completions, group.id, includes).size,
        uniqueQcPassTIDs: unionPass(qcPassDaily, group.id, includes).size,
        uniqueAcceptancePassTIDs: unionPass(acceptanceDaily, group.id, includes).size,
        personDayEfficiency: !efficiencyIssue && headcount > 0 ? completedTIDs / headcount : null,
        efficiencyIssue, efficiencyIssueDates
      };
    }
    function row(group, date) { return date ? day(group, date) : aggregate(group); }
    return {
      groups, settings, dates, peopleRows,
      rows: date => groups.map(group => row(group, date)),
      row: (groupId, date) => row(groupMap.get(groupId), date),
      rangeRows: (dateFrom, dateTo) => groups.map(group => dateFrom && dateFrom === dateTo ? day(group, dateFrom) : aggregate(group, dateFrom, dateTo))
    };
  }

  // 口径闭合自检：按「一条 case 从头到尾只算一次」的互斥阶段统计。
  // 分配 = 在制（未提交）+ 提交未过检 + 过检未验收 + 已验收 + 拒绝。
  // 释放会作废之前的所有记录，因此只看最后一次释放之后的事件链。
  function caseClosure({ tasks, events, groups, mode, dateFrom, dateTo, localDate }) {
    const byTask = new Map();
    (events || []).forEach(event => { if (!byTask.has(event.taskId)) byTask.set(event.taskId, []); byTask.get(event.taskId).push(event); });
    const groupIds = new Set((groups || []).map(group => group.id));
    const dateOf = value => localDateOf(value, localDate);
    const scoped = (tasks || []).filter(task => (!mode || task.mode === mode) && (!groupIds.size || groupIds.has(task.groupId)));
    const rows = scoped.filter(task => {
      if (!dateFrom && !dateTo) return true;
      const date = dateOf(task.createdAt || task.date);
      if (!date) return false;
      return (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);
    }).map(task => {
      const chain = byTask.get(task.id) || [];
      let cut = -1;
      chain.forEach((event, index) => { if (event.type === 'admin_release') cut = index; });
      const live = cut >= 0 ? chain.slice(cut + 1) : chain;
      const ever = type => live.some(event => event.type === type);
      const everSubmit = ever('submit'), everQcPass = ever('qc_pass'), everAccepted = ever('acceptance_pass');
      // 首次标完：与「首次标注完成」同口径（无 submissionKind 的历史数据按首次计）
      const everInitial = live.some(event => event.type === 'submit' && (!event.submissionKind || event.submissionKind === 'initial'));
      const rejected = task.status === 'rejected' || ever('reject_confirm');
      const stage = rejected ? 'rejected' : everAccepted ? 'accepted' : everQcPass ? 'qcPassed' : everSubmit ? 'submitted' : 'pending';
      return { groupId: task.groupId, stage, everSubmit, everInitial, everQcPass, everAccepted };
    });
    const count = (list, stage) => list.filter(row => row.stage === stage).length;
    const pick = list => {
      const assigned = list.length;
      const pending = count(list, 'pending'), submitted = count(list, 'submitted'), qcPassed = count(list, 'qcPassed');
      const accepted = count(list, 'accepted'), rejected = count(list, 'rejected');
      const uniqueQcPass = list.filter(row => row.everQcPass).length;
      const uniqueAccepted = list.filter(row => row.everAccepted).length;
      const rejectedHadQcPass = list.filter(row => row.stage === 'rejected' && row.everQcPass).length;
      return {
        assigned, pending, submitted, qcPassed, accepted, rejected,
        uniqueInitial: list.filter(row => row.everInitial).length, uniqueQcPass, uniqueAccepted, rejectedHadQcPass,
        balanced: assigned === pending + submitted + qcPassed + accepted + rejected,
        qcGap: uniqueQcPass - (qcPassed + accepted + rejectedHadQcPass),
        accGap: uniqueAccepted - accepted
      };
    };
    const byGroup = {};
    (groups || []).forEach(group => { byGroup[group.id] = pick(rows.filter(row => row.groupId === group.id)); });
    return { ...pick(rows), byGroup };
  }

  function rangeDate(value) {
    const date = text(value).trim();
    if (!date) return '';
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!parts) throw new RangeError('小组统计日期请使用 YYYY-MM-DD 格式。');
    const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!year || month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw new RangeError('小组统计日期不是有效日期。');
    return date;
  }

  function groupDaily(input) {
    // Explicit range keys take precedence; the original date API and complete
    // report exports keep their single-day/all-days behavior and row schema.
    if (!Object.hasOwn(input, 'dateFrom') && !Object.hasOwn(input, 'dateTo')) return groupDailyModel(input).rows(input.date || '');
    const dateFrom = rangeDate(input.dateFrom), dateTo = rangeDate(input.dateTo);
    if (dateFrom && dateTo && dateFrom > dateTo) throw new RangeError('开始日期不能晚于结束日期。');
    return groupDailyModel(input).rangeRows(dateFrom, dateTo);
  }

  function personDaily(input = {}) {
    const ranged = Object.hasOwn(input, 'dateFrom') || Object.hasOwn(input, 'dateTo');
    const dateFrom = rangeDate(ranged ? input.dateFrom : input.date), dateTo = rangeDate(ranged ? input.dateTo : input.date);
    if (dateFrom && dateTo && dateFrom > dateTo) throw new RangeError('开始日期不能晚于结束日期。');
    return groupDailyModel(input).peopleRows.filter(row => (!dateFrom || row.date >= dateFrom) && (!dateTo || row.date <= dateTo)
      && (!input.groupId || input.groupId === 'all' || row.groupId === input.groupId));
  }

  function build(input) {
    const requested = input.kind ? new Set(input.kind === 'summary' ? ['groups', 'movies'] : [input.kind]) : null;
    const wants = kind => !requested || requested.has(kind);
    const state = input.state || {};
    const auditTasks = (input.auditTasks || input.tasks || []).filter(task => !input.mode || task.mode === input.mode);
    const auditMap = new Map(auditTasks.map(task => [task.id, task]));
    const auditRawMap = new Map((state.tasks || []).filter(task => auditMap.has(task.id)).map(task => [task.id, task]));
    const auditEvents = (state.events || []).filter(event => auditMap.has(event.taskId));
    const tasks = (input.tasks || []).filter(task => !task.deleted && (!input.mode || task.mode === input.mode));
    const meta = input.statusMeta || {};
    const groupName = typeof input.groupLabel === 'function' ? input.groupLabel : id => text(id);
    const eventName = typeof input.eventLabel === 'function' ? input.eventLabel : event => text(event.type);
    const eventDescription = typeof input.eventDetail === 'function' ? input.eventDetail : event => text(event.note);
    const taskMap = new Map(tasks.map(task => [task.id, task]));
    const ids = new Set(taskMap.keys());
    const rawMap = new Map((state.tasks || []).filter(task => ids.has(task.id)).map(task => [task.id, task]));
    const rawEvents = (state.events || []).filter(event => event.type !== 'group_daily_edit' && ids.has(event.taskId));
    const events = effectiveEvents(rawEvents);
    const conflicts = flow.eventConflicts(rawEvents);
    const conflictsByTask = new Map();
    conflicts.forEach(conflict => { if (!conflictsByTask.has(conflict.taskId)) conflictsByTask.set(conflict.taskId, []); conflictsByTask.get(conflict.taskId).push(conflict); });
    const conflictById = new Map(flow.eventConflicts(auditEvents).map(conflict => [conflict.eventId, conflict]));
    const reportGroups = input.groups || unique(tasks.map(task => task.groupId)).map(id => ({ id, name: groupName(id), defaultMode: tasks.find(task => task.groupId === id)?.mode }));
    const groupModel = wants('groups') || wants('daily') || wants('personDaily') || wants('events')
      ? groupDailyModel({ ...input, tasks, groups: reportGroups }) : {settings:[],groups:[],peopleRows:[]};
    const settingsSet = new Set(groupModel.settings);
    const taskEventsSet = new Set(auditEvents);
    const exportEvents = (state.events || []).filter(event => settingsSet.has(event) || taskEventsSet.has(event));
    const histories = new Map(tasks.map(task => [task.id, []]));
    rawEvents.forEach(event => histories.get(event.taskId).push(event));
    const statusKeys = unique([...Object.keys(meta), ...tasks.map(task => task.status)]);
    const statusColumns = columns(statusKeys.map(key => [`status_${key}`, `状态：${meta[key]?.label || key}${key === 'unclaimed' ? '（未认领）' : key === 'annotating' ? '（已认领）' : ''}`]));
    const statusName = task => task.statusLabel || meta[task.status]?.label || task.status || '';

    function dateOf(value) {
      return localDateOf(value, input.localDate);
    }

    const taskRows = (wants('tasks') ? tasks : []).map(task => {
      const rawHistory = histories.get(task.id) || [], history = effectiveEvents(rawHistory);
      const omitted = conflictsByTask.get(task.id) || [];
      const firstClaim = history.find(event => event.type === 'claim' && !isReworkAssignment(event));
      const qcEvents = history.filter(event => ['qc_pass', 'qc_fail', 'qc_reject'].includes(event.type));
      const operator = qcOperator(history);
      const contributors = annotationContributors(history), assignments = history.filter(isReworkAssignment), assignment = assignments.at(-1);
      // Keep the existing export JSON schema while the UI uses the first acceptance decision.
      const contributionHistory = { initial: contributors.initial, submissions: contributors.submissions, rework: contributors.rework, firstQc: contributors.firstQc, firstAcceptance: contributors.firstAcceptance };
      const row = {
        taskId: task.id, tid: text(task.tid), movie: text(task.movie), movieTitle: movieTitle(task), date: task.date || '',
        groupId: task.groupId || '', group: groupName(task.groupId), mode: modeLabel(task.mode),
        assignee: task.assignee || '', originalAssignee: task.originalAssignee || firstClaim?.assignee || firstClaim?.actor || '', previousAssignee: task.previousAssignee || '',
        qcOperator: operator.name, qcOperatorAt: operator.at,
        initialAnnotationName: contributors.initial?.name || '', initialAnnotationRawName: contributors.initial?.rawName || '', initialAnnotationAt: contributors.initial?.at || '',
        reworkPeopleJSON: json(contributors.rework.map(person => person.name)), reworkContributionsJSON: json(contributors.rework), annotationContributionsJSON: json(contributionHistory),
        assignmentCount: assignments.length, assignedFrom: assignment?.fromAssignee || '', assignedTo: assignment?.assignee || '', assignedBy: assignment?.actor || '', assignedAt: assignment?.at || '',
        assignmentReason: assignment?.note || '', assignmentStatus: assignment?.assignmentStatus || '', assignmentsJSON: json(rawHistory.filter(isReworkAssignment)),
        status: task.status, statusLabel: statusName(task), submitRound: task.round || 0, qcRound: task.qcRound || 0, acceptanceRound: task.acceptanceRound || 0,
        claimedAt: firstClaim?.at || '', submittedAt: task.submittedAt || '', reviewedAt: task.reviewedAt || '',
        batchId: task.batchId || '', createdBy: task.createdBy || '', createdAt: task.createdAt || '',
        lastUpdated: task.updatedAt || '', originalTaskJSON: json(rawMap.get(task.id) || task), fullTimelineJSON: json(rawHistory),
        excludedEventCount: omitted.length, excludedEventsJSON: json(omitted)
      };
      for (const prefix of ['qc', 'acceptance']) {
        for (const suffix of ['PackageId', 'PackageName', 'PackageRound', 'PackageBuilder', 'PackageBuiltAt', 'PackageClaimer', 'PackageClaimedAt']) row[`${prefix}${suffix}`] = task[`${prefix}${suffix}`] ?? '';
      }
      for (const [prefix, qc] of [['firstQc', qcEvents[0]], ['latestQc', qcEvents.at(-1)]]) {
        const rejected=qc&&flow.isQcReject(qc);
        row[`${prefix}Decision`] = qc ? qc.type === 'qc_pass' ? '通过' : rejected ? '拒绝' : '打回' : '';
        row[`${prefix}PLevel`] = rejected?'':qc?.pLevel || '';
        row[`${prefix}TagsJSON`] = json(rejected?[]:qc?.tags || []);
        row[`${prefix}Note`] = qc?.note || '';
        row[`${prefix}Actor`] = qc?.actor || '';
        row[`${prefix}At`] = qc?.at || '';
      }
      for (const key of ['rejectionReason', 'rejectionBy', 'rejectionAt', 'rejectionConfirmReason', 'rejectionConfirmedBy', 'rejectionConfirmedAt', 'rejectionReturnReason', 'rejectionReturnedBy', 'rejectionReturnedAt', 'finalRejectStage', 'finalRejectReason', 'finalRejectedBy', 'finalRejectedAt', 'acceptanceNote', 'acceptanceReviewedBy', 'acceptanceReviewedAt', 'acceptanceRoute', 'acceptanceRouteNote', 'acceptanceRoutedBy', 'acceptanceRoutedAt', 'qcRepairNote', 'qcRepairedBy', 'qcRepairedAt']) row[key] = task[key] ?? '';
      return row;
    });
    const taskColumns = columns([
      ['taskId','内部任务ID'],['tid','TID'],['movie','影片包'],['movieTitle','整片影片名'],['date','分配业务日期'],['groupId','小组ID'],['group','小组'],['mode','作业类型'],
      ['assignee','当前标注人'],['originalAssignee','最初标注人'],['previousAssignee','接续前标注人'],['status','状态编码'],['statusLabel','当前状态'],
      ['qcOperator','组长 / 质检操作人'],['qcOperatorAt','最近质检操作时间'],
      ['initialAnnotationName','初标提交人'],['initialAnnotationRawName','初标提交人原始记录'],['initialAnnotationAt','首次标注提交时间'],['reworkPeopleJSON','历史返修提交人JSON'],['reworkContributionsJSON','各人返修提交明细JSON'],['annotationContributionsJSON','完整标注贡献归属JSON'],
      ['assignmentCount','代修分配次数'],['assignedFrom','最近转出标注人'],['assignedTo','最近接手标注人'],['assignedBy','最近分配组长'],['assignedAt','最近代修分配时间'],['assignmentReason','最近代修原因'],['assignmentStatus','分配时返修状态'],['assignmentsJSON','完整代修分配历史JSON'],
      ['excludedEventCount','未计入进度的记录数'],['excludedEventsJSON','未计入进度的记录与原因JSON'],
      ['submitRound','标注提交次数'],['qcRound','当前质检轮次'],['acceptanceRound','当前验收轮次'],['claimedAt','首次认领时间'],['submittedAt','最近标注提交时间'],['reviewedAt','最近质检时间'],
      ['firstQcDecision','首次质检结果'],['firstQcPLevel','首次质检P等级'],['firstQcTagsJSON','首次质检错误标签JSON'],['firstQcNote','首次质检说明'],['firstQcActor','首次质检人'],['firstQcAt','首次质检时间'],
      ['latestQcDecision','最近质检结果'],['latestQcPLevel','最近质检P等级'],['latestQcTagsJSON','最近质检错误标签JSON'],['latestQcNote','最近质检说明'],['latestQcActor','最近质检人'],['latestQcAt','最近质检时间'],
      ['qcPackageId','质检包ID'],['qcPackageName','质检包名'],['qcPackageRound','质检包轮次'],['qcPackageBuilder','质检建包人'],['qcPackageBuiltAt','质检建包时间'],['qcPackageClaimer','质检包认领人'],['qcPackageClaimedAt','质检包认领时间'],
      ['acceptancePackageId','验收包ID'],['acceptancePackageName','验收包名'],['acceptancePackageRound','验收包轮次'],['acceptancePackageBuilder','验收建包人'],['acceptancePackageBuiltAt','验收建包时间'],['acceptancePackageClaimer','验收包认领人'],['acceptancePackageClaimedAt','验收包认领时间'],
      ['rejectionReason','标注拒绝原因'],['rejectionBy','标注拒绝人'],['rejectionAt','标注拒绝时间'],['rejectionConfirmReason','质检确认拒绝说明'],['rejectionConfirmedBy','拒绝确认人'],['rejectionConfirmedAt','拒绝确认时间'],
      ['rejectionReturnReason','不同意拒绝说明'],['rejectionReturnedBy','不同意拒绝操作人'],['rejectionReturnedAt','不同意拒绝时间'],
      ['finalRejectStage','最终拒绝环节'],['finalRejectReason','最终拒绝原因'],['finalRejectedBy','最终拒绝操作人'],['finalRejectedAt','最终拒绝时间'],
      ['acceptanceNote','最近验收说明'],['acceptanceReviewedBy','最近验收人'],['acceptanceReviewedAt','最近验收时间'],['acceptanceRoute','验收不通过处理方向'],['acceptanceRouteNote','验收不通过分流说明'],['acceptanceRoutedBy','分流操作人'],['acceptanceRoutedAt','分流时间'],
      ['qcRepairNote','质检自行返修说明'],['qcRepairedBy','质检自行返修人'],['qcRepairedAt','质检自行返修完成时间'],['batchId','原始导入批次'],['createdBy','导入人'],['createdAt','导入时间'],['lastUpdated','最近更新时间'],['originalTaskJSON','完整原始任务JSON'],['fullTimelineJSON','完整任务流水JSON']
    ]);

    const eventRows = (wants('events') ? exportEvents : []).map(event => {
      const current = auditMap.get(event.taskId) || { groupId: event.groupId, mode: event.mode }, raw = auditRawMap.get(event.taskId) || current;
      return {
        eventId: event.id, taskId: event.taskId, currentTid: text(current.tid), atTimeTid: text(event.tidAtEvent ?? raw.tid),
        currentMovie: text(current.movie), atTimeMovie: text(event.movieAtEvent ?? raw.movie),
        groupId: current.groupId || '', group: groupName(current.groupId), mode: modeLabel(current.mode),
        actor: event.actor || '', actorRole: event.actorRole || '', at: event.at || '', localDate: dateOf(event.at),
        submitRound: event.round ?? '', qcRound: event.qcRound ?? '', acceptanceRound: event.acceptanceRound ?? '',
        type: event.type, label: eventName(event), note: event.note || '', detail: eventDescription(event), pLevel: event.pLevel || '', tagsJSON: json(event.tags || []),
        stage: event.stage || '', packageId: event.packageId || '', packageName: event.packageName || '', packageRound: event.packageRound ?? '',
        assignee: event.assignee || '', previousAssignee: event.previousAssignee || '', settingDate: event.type === 'group_daily_edit' ? event.date : '', beforeJSON: json(event.before), afterJSON: json(event.after), rawJSON: json(event),
        assignmentKind: event.assignmentKind || '', fromAssignee: event.fromAssignee || '', assignmentStatus: event.assignmentStatus || '', identityAlias: event.identityAlias ?? '',
        excludedFromProgress: conflictById.has(event.id), excludedReason: conflictById.get(event.id)?.reason || ''
      };
    });
    const eventColumns = columns([
      ['eventId','事件ID'],['taskId','内部任务ID'],['currentTid','当前TID'],['atTimeTid','当时TID'],['currentMovie','当前影片包'],['atTimeMovie','当时影片包'],['groupId','小组ID'],['group','小组'],['mode','作业类型'],
      ['actor','操作人'],['actorRole','操作角色'],['at','实际操作时间'],['localDate','实际操作日期'],['submitRound','标注提交轮次'],['qcRound','质检轮次'],['acceptanceRound','验收轮次'],['type','操作编码'],['label','操作'],['pLevel','质检P等级'],['tagsJSON','质检错误标签JSON'],['note','说明'],['detail','完整说明'],
      ['stage','建包阶段'],['packageId','流转包ID'],['packageName','流转包名'],['packageRound','流转包轮次'],['assignee','标注人'],['previousAssignee','接续前标注人'],['settingDate','小组记录业务日期'],['beforeJSON','修改前JSON'],['afterJSON','修改后JSON'],['rawJSON','完整原始事件JSON'],
      ['assignmentKind','人员分配类型'],['fromAssignee','转出标注人'],['assignmentStatus','分配时返修状态'],['identityAlias','是否同一人身份接续'],
      ['excludedFromProgress','是否未计入进度'],['excludedReason','未计入进度的原因']
    ]);

    const importColumns = columns([
      ['batchId','导入批次ID'],['movie','当前影片名'],['originalMovie','导入时影片名'],['date','分配日期'],['groupId','小组ID'],['group','小组'],['mode','作业类型'],
      ['importedCount','本次导入条数'],['activeCount','有效任务条数'],['recordStatus','导入记录状态'],['createdBy','导入人'],['createdAt','导入时间'],['deletedBy','删除人'],['deletedAt','删除时间'],['deletionReason','删除原因'],
      ['taskIdsJSON','原始任务ID JSON'],['originalTIDsJSON','原始TID JSON'],['currentTIDsJSON','当前TID JSON'],['rawBatchJSON','原始导入批次JSON'],['originalTasksJSON','完整原始任务JSON'],['latestTasksJSON','最新任务含删除状态JSON'],['fullTimelineJSON','完整历史JSON']
    ]);
    const importRows = (wants('imports') ? state.batches || [] : []).filter(batch => batch.kind !== 'handoff').map(batch => {
      const members = auditTasks.filter(task => task.batchId === batch.id || batch.taskIds?.includes(task.id));
      if (!members.length) return null;
      const memberIds = new Set(members.map(task => task.id)), deleted = members.filter(task => task.deleted), last = deleted.at(-1);
      return {
        batchId: batch.id, movie: unique(members.map(task => task.movie)).join('、'), originalMovie: batch.movie || '', date: batch.date || '', groupId: batch.groupId || '', group: groupName(batch.groupId), mode: modeLabel(batch.mode || members[0].mode),
        importedCount: members.length, activeCount: members.length - deleted.length, recordStatus: deleted.length === members.length ? '已删除' : deleted.length ? '部分已删除' : '未删除',
        createdBy: batch.createdBy || '', createdAt: batch.createdAt || '', deletedBy: last?.deletedBy || '', deletedAt: last?.deletedAt || '', deletionReason: last?.deletionReason || '',
        taskIdsJSON: json(members.map(task => task.id)), originalTIDsJSON: json(members.map(task => auditRawMap.get(task.id)?.tid)), currentTIDsJSON: json(members.map(task => task.tid)), rawBatchJSON: json(batch),
        originalTasksJSON: json(members.map(task => auditRawMap.get(task.id))), latestTasksJSON: json(members), fullTimelineJSON: json(auditEvents.filter(event => memberIds.has(event.taskId)))
      };
    }).filter(Boolean);

    const packageRecords = (wants('packages') || wants('daily') ? state.batches || [] : []).filter(batch => batch.kind === 'handoff').map(batch => {
      const packageId = batch.packageId || batch.id;
      const packageEvents = events.filter(event => event.packageId === packageId || event.packageId === batch.id);
      const rawPackageEvents = rawEvents.filter(event => event.packageId === packageId || event.packageId === batch.id);
      const members = unique([...(batch.taskIds || []), ...rawPackageEvents.map(event => event.taskId)]).filter(id => ids.has(id));
      return { batch, packageId, packageEvents, rawPackageEvents, members };
    }).filter(record => record.members.length);

    function scopedBatch(record) {
      const { batch, members } = record;
      const originalIds = Array.isArray(batch.taskIds) ? batch.taskIds : [];
      const scoped = { ...batch, taskIds: members.slice() };
      for (const key of ['tids', 'originalTIDs', 'originalTids', 'currentTIDs', 'currentTids']) {
        if (Array.isArray(batch[key]) && batch[key].length === originalIds.length) scoped[key] = batch[key].filter((value, index) => ids.has(originalIds[index]));
      }
      return scoped;
    }

    const packageRows = (wants('packages') ? packageRecords : []).map(record => {
      const { batch, packageId, packageEvents, members } = record;
      const current = members.map(id => taskMap.get(id));
      const built = new Map(packageEvents.filter(event => event.type === 'package_built').map(event => [event.taskId, event]));
      const batchTIDs = new Map((batch.taskIds || []).map((id, index) => [id, batch.tids?.[index]]));
      const originalTIDs = members.map(id => text(built.get(id)?.tidAtEvent ?? batchTIDs.get(id) ?? rawMap.get(id)?.tid ?? taskMap.get(id).tid));
      const originalMovies = unique(members.map(id => text(built.get(id)?.movieAtEvent ?? batch.movie ?? rawMap.get(id)?.movie ?? taskMap.get(id).movie)));
      const packageRounds = unique([batch.packageRound ?? batch.round, ...packageEvents.map(event => event.packageRound)]);
      const claims = packageEvents.filter(event => event.type === 'package_claimed');
      const claimTimes = unique(claims.map(event => event.at)).sort();
      return {
        packageId, packageName: batch.packageName || batch.name || '', stage: batch.stage || '', stageLabel: batch.stage === 'qc' ? '质检包' : batch.stage === 'acceptance' ? '验收包' : text(batch.stage),
        packageRound: packageRounds.join('、'), packageRoundsJSON: json(packageRounds), mode: unique(current.map(task => modeLabel(task.mode))).join('、'),
        originalMoviesJSON: json(originalMovies), currentMoviesJSON: json(unique(current.map(task => task.movie))),
        groupIdsJSON: json(unique(current.map(task => task.groupId))), groups: unique(current.map(task => groupName(task.groupId))).join('、'),
        totalTIDs: members.length, taskIdsJSON: json(members), originalTIDsJSON: json(originalTIDs), currentTIDsJSON: json(current.map(task => text(task.tid))),
        createdBy: batch.createdBy || '', createdAt: batch.createdAt || '', claimedBy: unique(claims.map(event => event.claimer || event.packageClaimer || event.actor)).join('、'),
        claimedTIDs: unique(claims.map(event => event.taskId)).length, firstClaimedAt: claimTimes[0] || '', lastClaimedAt: claimTimes.at(-1) || '', claimTimesJSON: json(claimTimes),
        rawBatchJSON: json(scopedBatch(record)), fullEventsJSON: json(record.rawPackageEvents)
      };
    });
    const packageColumns = columns([
      ['packageId','流转包ID'],['packageName','流转包名'],['stage','阶段编码'],['stageLabel','流转阶段'],['packageRound','包内任务轮次'],['packageRoundsJSON','包内任务轮次JSON'],['mode','作业类型'],
      ['originalMoviesJSON','建包时影片JSON'],['currentMoviesJSON','当前影片JSON'],['groupIdsJSON','所属小组ID JSON'],['groups','所属小组'],['totalTIDs','包内TID数量'],['taskIdsJSON','任务ID明细JSON'],['originalTIDsJSON','建包时TID明细JSON'],['currentTIDsJSON','当前TID明细JSON'],
      ['createdBy','建包人'],['createdAt','建包时间'],['claimedBy','认领人'],['claimedTIDs','已认领TID数量'],['firstClaimedAt','首次认领时间'],['lastClaimedAt','最近认领时间'],['claimTimesJSON','认领时间JSON'],['rawBatchJSON','批次记录JSON（当前模块）'],['fullEventsJSON','完整建包与认领流水JSON']
    ]);

    function aggregate(subset, identity) {
      const dates = unique(subset.map(task => task.date)).sort();
      const row = {
        ...identity, mode: unique(subset.map(task => modeLabel(task.mode))).join('、'),
        totalTIDs: subset.length, movieCount: unique(subset.map(task => json([text(task.mode), movieTitle(task)]))).length,
        groupCount: unique(subset.map(task => task.groupId)).length, groups: unique(subset.map(task => groupName(task.groupId))).join('、'),
        moviesJSON: json(unique(subset.map(task => task.movie))), firstAllocationDate: dates[0] || '', lastAllocationDate: dates.at(-1) || '',
        acceptedTIDs: subset.filter(task => task.status === 'accepted').length,
        rejectedTIDs: subset.filter(task => task.status === 'rejected').length,
        taskIdsJSON: json(subset.map(task => task.id)), currentTIDsJSON: json(subset.map(task => text(task.tid)))
      };
      row.closedTIDs = row.acceptedTIDs + row.rejectedTIDs;
      row.completionRate = subset.length ? `${(row.acceptedTIDs / subset.length * 100).toFixed(1)}%` : '0.0%';
      row.closureRate = subset.length ? `${(row.closedTIDs / subset.length * 100).toFixed(1)}%` : '0.0%';
      statusKeys.forEach(key => { row[`status_${key}`] = 0; });
      subset.forEach(task => { row[`status_${task.status}`] += 1; });
      return row;
    }
    const movieRows = (wants('movies') ? movieProgress({ tasks, mode: input.mode, groupLabel: groupName, statusMeta: meta }) : []).map(progress => {
      const subset = progress.taskIds.map(id => taskMap.get(id));
      return {
        ...aggregate(subset, { movie: progress.movie }), key: progress.key, modeCode: progress.mode, taskCount: progress.total,
        closed: progress.closed, closureStatus: progress.closed ? '已闭环' : '流程中', closedTIDs: progress.accepted + progress.rejected,
        rejectedTIDs: progress.rejected, activeTIDs: progress.active, closureRate: `${progress.closureRate.toFixed(1)}%`,
        sourceNameCount: progress.sourceNames.length, sourceNamesJSON: json(progress.sourceNames), groupIdsJSON: json(progress.groupIds)
      };
    });
    function settingFields(row) {
      return {
        leader: row.leader, total: row.total, autoHeadcount: row.autoHeadcount, headcount: row.headcount,
        headcountSource: row.headcountSource, membersJSON: json(row.members), latestEditId: row.latestEditId,
        settingsHistoryJSON: json(row.history), isAggregate: row.isAggregate,
        annotationCompletedTIDs: row.completedTIDs, initialSubmissionTIDs: row.initialSubmissionTIDs,
        reworkSubmissionActions: row.reworkSubmissionActions, personDayEfficiency: row.personDayEfficiency,
        efficiencyIssue: row.efficiencyIssue, efficiencyIssueDatesJSON: json(row.efficiencyIssueDates)
      };
    }
    const groupRows = (wants('groups') ? groupModel.groups : []).map(group => ({
      ...aggregate(tasks.filter(task => task.groupId === group.id), { groupId: group.id, group: groupName(group.id) }),
      mode: modeLabel(group.defaultMode || group.mode || input.mode), ...settingFields(groupModel.row(group.id, ''))
    }));
    const settingColumns = columns([
      ['leader','负责人'],['total','组长登记总量'],['autoHeadcount','自动作业人数（日人次）'],['headcount','采用作业人数（日人次）'],['headcountSource','人数来源（auto/manual）'],['membersJSON','自动作业人员JSON'],['latestEditId','最近小组记录ID'],['settingsHistoryJSON','完整小组修改历史JSON'],['isAggregate','是否跨日期累计'],
      ['annotationCompletedTIDs','实际提交完成TID（日内去重）'],['initialSubmissionTIDs','首次提交完成TID'],['reworkSubmissionActions','返修提交次数'],['qcPassTIDs','质检通过TID数量（当日·TID去重）'],['acceptancePassTIDs','验收通过TID数量（当日·TID去重）'],['personDayEfficiency','日人均完成TID（条/人天）'],['efficiencyIssue','效率核对状态'],['efficiencyIssueDatesJSON','完成但人数为零的日期JSON']
    ]);
    const summaryColumns = columns([
      ['mode','作业类型'],['totalTIDs','累计分配TID数量'],['movieCount','累计影片数量'],['groupCount','参与小组数'],['groups','参与小组'],['moviesJSON','影片明细JSON'],['firstAllocationDate','最早分配业务日期'],['lastAllocationDate','最近分配业务日期'],['acceptedTIDs','验收通过TID数量'],['rejectedTIDs','最终拒绝TID数量'],['closedTIDs','已闭环TID数量'],['completionRate','验收通过率'],['closureRate','闭环率（通过+拒绝）']
    ]).concat(statusColumns, columns([['taskIdsJSON','内部任务ID明细JSON'],['currentTIDsJSON','当前TID明细JSON']]));

    const dailyMap = new Map();
    function dayRow(date, groupId) {
      const key = json([date, groupId]);
      if (!dailyMap.has(key)) dailyMap.set(key, {
        date, groupId, group: groupName(groupId), modes: new Set(), imported: new Set(), initial: new Set(), completed: new Set(), rejected: new Set(), active: new Set(),
        annotationReworkActions: 0, qcPassed: new Set(), qcPassActions: 0, qcFailActions: 0, qcRejected: new Set(), acceptanceFailActions: 0, acceptanceRejected: new Set(), qcSelfRepairActions: 0, assignmentActions: 0, qcPackages: new Set(), acceptancePackages: new Set(), taskActions: new Map(),
        // 条数型指标（质检通过 / 验收通过）按 TID 去重：同一 TID 的多条重复任务记录只算一条。
        qcPassedTids: new Set(), completedTids: new Set(), qcPassOwners: new Map(), completedOwners: new Map(),
        // 整体去重：一条 case 只算一次，只记第一次达成的那一天
        uniqueQcTids: new Set(), uniqueQcOwners: new Map(), uniqueCompletedTids: new Set(), uniqueCompletedOwners: new Map()
      });
      return dailyMap.get(key);
    }
    // 次数型指标按任务登记，释放时可以精确回退这一条的贡献。
    function bump(row, field, taskId) {
      row[field] += 1;
      const entry = row.taskActions.get(taskId) || {};
      entry[field] = (entry[field] || 0) + 1;
      row.taskActions.set(taskId, entry);
    }
    const tidKey = task => text(task && task.tid).trim() || text(task && task.id);
    function addTid(set, owners, key, taskId) {
      set.add(key);
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(taskId);
    }
    // 释放时只回退这条任务对 TID 的贡献；同一 TID 还有其它任务在计数则保留。
    function dropTid(set, owners, key, taskId) {
      const held = owners.get(key);
      if (!held) return;
      held.delete(taskId);
      if (!held.size) { owners.delete(key); set.delete(key); }
    }
    const firstByType = new Map();
    function first(type, taskId) { return firstByType.get(`${type}:${taskId}`); }
    (wants('daily') ? events : []).forEach(event => {
      const qcReject=flow.isQcReject(event),acceptanceReject=flow.isAcceptanceReject(event);
      // 释放：这条 case 回到未认领重新走流程，此前登记的首次记录全部作废
      // （导入记录保留，任务仍然存在）。重新开始后按新记录重新计入。
      if (event.type === 'admin_release') {
        for (const type of ['submit', 'qc_pass', 'qc_reject', 'acceptance_reject', 'acceptance_pass', 'reject_confirm', 'final_reject']) firstByType.delete(`${type}:${event.taskId}`);
        return;
      }
      if (['dispatch', 'submit', 'acceptance_pass', 'reject_confirm'].includes(event.type) && !first(event.type, event.taskId)) firstByType.set(`${event.type}:${event.taskId}`, event);
      if (qcReject&&!first('qc_reject',event.taskId))firstByType.set(`qc_reject:${event.taskId}`,event);
      if (acceptanceReject&&!first('acceptance_reject',event.taskId))firstByType.set(`acceptance_reject:${event.taskId}`,event);
      if ((event.type==='reject_confirm'||qcReject||acceptanceReject) && !first('final_reject', event.taskId)) firstByType.set(`final_reject:${event.taskId}`, event);
    });
    (wants('daily') ? events : []).forEach(event => {
      const task = taskMap.get(event.taskId);
      const date = dateOf(event.at || task.createdAt);
      if (!date) return;
      const row = dayRow(date, task.groupId); row.modes.add(modeLabel(task.mode));
      if (isReworkAssignment(event)) { row.assignmentActions += 1; return; }
      row.active.add(task.id);
      // 释放：作废这条 case 在所有日期上已登记的完成 / 通过 / 拒绝与操作次数，
      // 重新走完流程后再重新计入，避免同一条被算两次。
      if (event.type === 'admin_release') {
        const releaseKey = tidKey(task);
        dailyMap.forEach(item => {
          item.initial.delete(task.id); item.qcPassed.delete(task.id); item.completed.delete(task.id);
          item.rejected.delete(task.id); item.qcRejected.delete(task.id); item.acceptanceRejected.delete(task.id);
          dropTid(item.qcPassedTids, item.qcPassOwners, releaseKey, task.id);
          dropTid(item.completedTids, item.completedOwners, releaseKey, task.id);
          dropTid(item.uniqueQcTids, item.uniqueQcOwners, releaseKey, task.id);
          dropTid(item.uniqueCompletedTids, item.uniqueCompletedOwners, releaseKey, task.id);
          const actions = item.taskActions.get(task.id);
          if (actions) { for (const field of Object.keys(actions)) item[field] -= actions[field]; item.taskActions.delete(task.id); }
        });
        return;
      }
      if (event.type === 'dispatch' && first('dispatch', task.id) === event) row.imported.add(task.id);
      if (event.type === 'submit') {
        const initialKind = event.submissionKind === 'initial' || (!event.submissionKind && first('submit', task.id) === event);
        if (initialKind && first('submit', task.id) === event) row.initial.add(task.id);
        if (!initialKind) bump(row, 'annotationReworkActions', task.id);
      }
      const qcReject=flow.isQcReject(event),acceptanceReject=flow.isAcceptanceReject(event);
      // 质检通过 / 验收通过：当日 · TID 去重（与「实际完成」同款口径）。
      // row 本身按「日期 × 小组」分组，同一天同一 TID 多次通过只算 1 条；若改日返修后再次通过，则在新的一天再计 1 条。
      if (event.type === 'qc_pass') {
        row.qcPassed.add(task.id); addTid(row.qcPassedTids, row.qcPassOwners, tidKey(task), task.id);
        addTid(row.uniqueQcTids, row.uniqueQcOwners, tidKey(task), task.id);
      }
      if (event.type === 'qc_fail'&&!qcReject) bump(row, 'qcFailActions', task.id);
      if (qcReject && first('qc_reject', task.id) === event) row.qcRejected.add(task.id);
      if (event.type === 'acceptance_pass') {
        row.completed.add(task.id); addTid(row.completedTids, row.completedOwners, tidKey(task), task.id);
        addTid(row.uniqueCompletedTids, row.uniqueCompletedOwners, tidKey(task), task.id);
      }
      if (event.type === 'acceptance_fail'&&!acceptanceReject) bump(row, 'acceptanceFailActions', task.id);
      if (acceptanceReject && first('acceptance_reject', task.id) === event) row.acceptanceRejected.add(task.id);
      if ((event.type==='reject_confirm'||qcReject||acceptanceReject) && first('final_reject', task.id) === event) row.rejected.add(task.id);
      if (event.type === 'qc_repair_done') bump(row, 'qcSelfRepairActions', task.id);
    });
    (wants('daily') ? tasks : []).filter(task => !first('dispatch', task.id)).forEach(task => {
      const date = dateOf(task.createdAt || task.date);
      if (!date) return;
      const row = dayRow(date, task.groupId); row.modes.add(modeLabel(task.mode)); row.imported.add(task.id); row.active.add(task.id);
    });
    (wants('daily') ? packageRecords : []).forEach(record => {
      const date = dateOf(record.batch.createdAt);
      if (!date || !['qc', 'acceptance'].includes(record.batch.stage)) return;
      const packageGroups = unique(record.members.map(id => taskMap.get(id).groupId));
      packageGroups.forEach(groupId => {
        const row = dayRow(date, groupId);
        record.members.map(id => taskMap.get(id)).filter(task => task.groupId === groupId).forEach(task => { row.modes.add(modeLabel(task.mode)); row.active.add(task.id); });
        row[record.batch.stage === 'qc' ? 'qcPackages' : 'acceptancePackages'].add(record.packageId);
      });
    });
    (wants('daily') ? groupModel.groups : []).forEach(group => groupModel.dates.get(group.id).forEach(date => {
      dayRow(date, group.id).modes.add(modeLabel(group.defaultMode || group.mode || input.mode));
    }));
    const dailyRows = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date) || text(a.groupId).localeCompare(text(b.groupId))).map(row => ({
      date: row.date, groupId: row.groupId, group: row.group, mode: Array.from(row.modes).join('、'),
      importedTIDs: row.imported.size, initialAnnotationTIDs: row.initial.size, annotationReworkActions: row.annotationReworkActions,
      qcPassActions: row.qcPassedTids.size, qcFailActions: row.qcFailActions, qcRejectedTIDs: row.qcRejected.size, completedTIDs: row.completedTids.size, acceptanceFailActions: row.acceptanceFailActions, acceptanceRejectedTIDs: row.acceptanceRejected.size,
      uniqueInitialTIDs: row.initial.size, uniqueQcPassTIDs: row.uniqueQcTids.size, uniqueAcceptanceTIDs: row.uniqueCompletedTids.size,
      rejectedTIDs: row.rejected.size, qcSelfRepairActions: row.qcSelfRepairActions, qcPackageCount: row.qcPackages.size, acceptancePackageCount: row.acceptancePackages.size,
      activeTIDs: row.active.size, assignmentActions: row.assignmentActions, importedTaskIdsJSON: json(Array.from(row.imported)), initialTaskIdsJSON: json(Array.from(row.initial)), completedTaskIdsJSON: json(Array.from(row.completed)), rejectedTaskIdsJSON: json(Array.from(row.rejected)),
      ...settingFields(groupModel.row(row.groupId, row.date))
    }));
    const dailyColumns = columns([
      ['date','实际操作日期'],['groupId','小组ID'],['group','小组'],['mode','作业类型'],['importedTIDs','新增分配TID数量'],['initialAnnotationTIDs','首次标注完成TID数量'],['annotationReworkActions','标注返修提交次数'],
      ['qcPassActions','质检通过TID数量（当日·TID去重）'],['qcFailActions','质检打回操作次数'],['qcRejectedTIDs','质检拒绝TID数量'],['completedTIDs','验收通过TID数量（当日·TID去重）'],['acceptanceRejectedTIDs','验收拒绝TID数量'],['rejectedTIDs','最终拒绝TID数量'],['acceptanceFailActions','验收不通过操作次数'],['qcSelfRepairActions','质检自行返修完成次数'],
      ['uniqueInitialTIDs','首次标完TID数量（所选范围去重）'],['uniqueQcPassTIDs','质检通过TID数量（所选范围去重）'],['uniqueAcceptanceTIDs','验收通过TID数量（所选范围去重）'],
      ['qcPackageCount','新建质检包数'],['acceptancePackageCount','历史新建验收包数'],['activeTIDs','有操作TID数量'],['assignmentActions','代修分配任务次数'],['importedTaskIdsJSON','新增分配任务ID JSON'],['initialTaskIdsJSON','首次标注完成任务ID JSON'],['completedTaskIdsJSON','首次验收通过任务ID JSON'],['rejectedTaskIdsJSON','最终拒绝任务ID JSON']
    ]);
    const personRows = (wants('personDaily') ? groupModel.peopleRows : []).map(row => ({
      groupId: row.groupId, group: groupName(row.groupId), mode: modeLabel(row.mode), date: row.date, name: row.name,
      completedTIDs: row.completedTIDs, initialSubmissionTIDs: row.initialSubmissionTIDs,
      reworkSubmissionActions: row.reworkSubmissionActions, submissionActions: row.submissionActions,
      taskIdsJSON: json(row.taskIds), tidsJSON: json(row.tids), eventIdsJSON: json(row.eventIds), rawNamesJSON: json(row.rawNames),
      firstSubmittedAt: row.firstSubmittedAt, lastSubmittedAt: row.lastSubmittedAt
    }));
    const personColumns = columns([
      ['date','实际作业日期'],['groupId','小组ID'],['group','小组'],['mode','作业类型'],['name','标注人'],
      ['completedTIDs','当日实际提交完成TID（按人去重）'],['initialSubmissionTIDs','首次提交完成TID'],['reworkSubmissionActions','返修提交次数'],['submissionActions','全部提交次数'],
      ['taskIdsJSON','内部任务ID明细JSON'],['tidsJSON','当前TID明细JSON'],['eventIdsJSON','有效提交事件ID JSON'],['rawNamesJSON','原始操作人名称JSON'],['firstSubmittedAt','当日首次提交时间'],['lastSubmittedAt','当日最后提交时间']
    ]);
    const result = {
      imports: { columns: importColumns, rows: importRows },
      tasks: { columns: taskColumns, rows: taskRows }, events: { columns: eventColumns, rows: eventRows }, packages: { columns: packageColumns, rows: packageRows },
      movies: {
        columns: columns([['movie','整片影片名']]).concat(summaryColumns, columns([
          ['key','整片汇总标识'],['modeCode','作业类型编码'],['taskCount','整片TID数量'],['closed','是否整片闭环'],['closureStatus','整片流程状态'],
          ['activeTIDs','流程中TID数量'],['sourceNameCount','原始影片包名数量'],['sourceNamesJSON','原始影片名集合JSON'],['groupIdsJSON','参与小组ID JSON']
        ])), rows: movieRows
      },
      groups: { columns: columns([['groupId','小组ID'],['group','小组']]).concat(summaryColumns, settingColumns), rows: groupRows },
      daily: { columns: dailyColumns.concat(settingColumns), rows: dailyRows },
      personDaily: { columns: personColumns, rows: personRows },
      closure: caseClosure({
        tasks, events: (input.state && input.state.events) || [], groups: reportGroups, mode: input.mode || '',
        dateFrom: rangeDate(input.dateFrom || ''), dateTo: rangeDate(input.dateTo || ''), localDate: input.localDate
      })
    };
    return requested ? Object.fromEntries(Object.entries(result).filter(([kind]) => kind === 'closure' || wants(kind))) : result;
  }

  return Object.freeze({ build, groupDaily, personDaily, qcOperator, movieTitle, movieProgress, annotationContributors });
}));
