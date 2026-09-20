(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkbenchFlow = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const STATUS_META = Object.freeze(Object.fromEntries(Object.entries({
    unclaimed: { label: '待标注', tone: 'pending' },
    annotating: { label: '待标注', tone: 'active' },
    annotation_done: { label: '标注完成·待建质检包', tone: 'review' },
    annotation_rework_done: { label: '标注返修完成·待建质检包', tone: 'review' },
    qc_pack_unclaimed: { label: '质检包待认领', tone: 'review' },
    pending_qc: { label: '待一次质检', tone: 'review' },
    pending_reqc: { label: '待再次质检', tone: 'review' },
    rework: { label: '待标注返修', tone: 'rework' },
    qc_pass_unsent: { label: '质检通过·自动流入验收', tone: 'review' },
    acceptance_pack_unclaimed: { label: '历史验收包待认领', tone: 'review' },
    pending_acceptance: { label: '待验收', tone: 'review' },
    accepted: { label: '验收通过', tone: 'done' },
    acceptance_return_pending: { label: '验收打回·待质检处理', tone: 'rework' },
    qc_self_rework: { label: '质检自行返修中', tone: 'rework' },
    qc_self_done: { label: '质检返修完成·自动流入验收', tone: 'review' },
    acceptance_rework: { label: '验收打回·待标注修改', tone: 'rework' },
    rejection_pending: { label: '标注拒绝待质检确认', tone: 'rework' },
    rejected: { label: '已拒绝·废弃', tone: 'pending' }
  }).map(([key, value]) => [key, Object.freeze(value)])));

  function positiveRound(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
  }

  const QC_REJECT_MARKER = '[质检拒绝]';
  const ACCEPTANCE_REJECT_MARKER = '[验收拒绝]';
  function isQcReject(event) { return !!event && (event.type === 'qc_reject' || event.type === 'qc_fail' && String(event.note || '').startsWith(QC_REJECT_MARKER)); }
  function isAcceptanceReject(event) { return !!event && (event.type === 'acceptance_reject' || event.type === 'acceptance_fail' && String(event.note || '').startsWith(ACCEPTANCE_REJECT_MARKER)); }
  function rejectReason(event, marker) { return String(event?.note || '').startsWith(marker) ? String(event.note).slice(marker.length).trim() : String(event?.note || '').trim(); }

  function isReworkAssignment(event) {
    return !!event && event.type === 'claim' && event.assignmentKind === 'rework_transfer';
  }

  // Replay in supplied event order. Storage establishes the stable chronological
  // order; re-sorting here would lose the order of atomic build + claim actions.
  // The UI authorizes new writes. Replay also protects an explicit reassignment
  // from older cached pages: their raw records stay intact, but conflicting
  // actions cannot move the replacement worker's task or inflate their output.
  function project(task, events) {
    const s = {
      status: 'unclaimed', assignee: '', originalAssignee: '', previousAssignee: '',
      round: 0, qcRound: 0, acceptanceRound: 0, submittedAt: '', reviewedAt: '',
      updatedAt: task.createdAt || '',
      deleted: false, deletedAt: '', deletedBy: '', deletionReason: '', deletedBatchId: '',
      qcPackageId: '', qcPackageName: '', qcPackageRound: 0,
      qcPackageBuilder: '', qcPackageBuiltAt: '', qcPackageClaimer: '', qcPackageClaimedAt: '',
      acceptancePackageId: '', acceptancePackageName: '', acceptancePackageRound: 0,
      acceptancePackageBuilder: '', acceptancePackageBuiltAt: '', acceptancePackageClaimer: '', acceptancePackageClaimedAt: '',
      packageStage: '', packageId: '', packageName: '', packageRound: 0,
      packageBuilder: '', packageBuiltAt: '', packageClaimer: '', packageClaimedAt: '',
      rejectionReason: '', rejectionConfirmReason: '', rejectionBy: '', rejectionAt: '',
      rejectionConfirmedBy: '', rejectionConfirmedAt: '', rejectionResumeStatus: '',
      rejectionReturnReason: '', rejectionReturnedBy: '', rejectionReturnedAt: '',
      finalRejectStage: '', finalRejectReason: '', finalRejectedBy: '', finalRejectedAt: '',
      acceptanceNote: '', acceptanceReviewedBy: '', acceptanceReviewedAt: '',
      acceptanceRoute: '', acceptanceRouteNote: '', acceptanceRoutedBy: '', acceptanceRoutedAt: '',
      qcRepairNote: '', qcRepairedBy: '', qcRepairedAt: ''
    };
    let lastQcReviewRound = 0;
    let lastAcceptanceReviewRound = 0;

    function assignee(event) {
      const next = event.assignee || (event.type === 'claim' ? event.actor : '');
      if (!next) return;
      if (!s.originalAssignee) s.originalAssignee = event.previousAssignee || s.assignee || next;
      if (event.previousAssignee && (!s.assignmentId || event.previousAssignee !== next)) s.previousAssignee = event.previousAssignee;
      else if (s.assignee && s.assignee !== next) s.previousAssignee = s.assignee;
      s.assignee = next;
    }

    function assignmentConflict(event) {
      if (!s.assignmentId || isReworkAssignment(event)) return '';
      if (['claim', 'submit', 'annotator_reject'].includes(event.type)) {
        const actor = event.actor || event.assignee || '';
        const alias = event.previousAssignee === s.assignee && event.assignee === actor
          && (event.identityAlias === true || (!/^\p{Script=Han}+$/u.test(s.assignee) && /^\p{Script=Han}+$/u.test(actor)));
        if (actor !== s.assignee && !alias) return `任务已分配给${s.assignee}，原处理人的记录未计入进度。`;
        if (event.assignee && event.assignee !== s.assignee && !alias) return '记录中的处理人与当前分配不一致，未计入进度。';
        if (['submit', 'annotator_reject'].includes(event.type) && !['annotating', 'rework', 'acceptance_rework'].includes(s.status)) return '任务已进入下一环节，旧页面的重复操作未计入进度。';
      }
      if (Number(event.workflowVersion) >= 3) return '';
      const staleRound = positiveRound(event.round) && positiveRound(event.round) !== s.round;
      if (['qc_pass', 'qc_fail', 'qc_reject'].includes(event.type) && (!['pending_qc', 'pending_reqc'].includes(s.status) || staleRound)) return '当前质检环节或轮次已变化，旧页面的审核未计入进度。';
      if (['acceptance_pass', 'acceptance_fail', 'acceptance_reject'].includes(event.type) && (s.status !== 'pending_acceptance' || staleRound)) return '当前验收环节或轮次已变化，旧页面的审核未计入进度。';
      if (event.type === 'sent_acceptance' && !['qc_pass_unsent','pending_acceptance'].includes(s.status)) return '当前任务尚未质检通过，旧页面的送验记录未计入进度。';
      return '';
    }

    function packageEvent(event, claimed) {
      const stage = event.stage;
      if (stage !== 'qc' && stage !== 'acceptance') return;
      const prefix = stage === 'qc' ? 'qc' : 'acceptance';
      const currentRound = s[`${prefix}Round`];
      const packageRound = positiveRound(event.packageRound) || (claimed ? s[`${prefix}PackageRound`] : 0) || currentRound + 1;
      if (event.packageId) s[`${prefix}PackageId`] = event.packageId;
      if (event.packageName) s[`${prefix}PackageName`] = event.packageName;
      s[`${prefix}PackageRound`] = packageRound;
      if (claimed) {
        s[`${prefix}Round`] = Math.max(currentRound, packageRound);
        s[`${prefix}PackageClaimer`] = event.claimer || event.packageClaimer || event.actor || '';
        s[`${prefix}PackageClaimedAt`] = event.at || '';
        if (event.packageBuilder) s[`${prefix}PackageBuilder`] = event.packageBuilder;
      } else {
        s[`${prefix}PackageBuilder`] = event.builder || event.packageBuilder || event.actor || '';
        s[`${prefix}PackageBuiltAt`] = event.at || '';
        s[`${prefix}PackageClaimer`] = '';
        s[`${prefix}PackageClaimedAt`] = '';
      }
      s.packageStage = stage;
      s.packageId = s[`${prefix}PackageId`];
      s.packageName = s[`${prefix}PackageName`];
      s.packageRound = packageRound;
      s.packageBuilder = s[`${prefix}PackageBuilder`];
      s.packageBuiltAt = s[`${prefix}PackageBuiltAt`];
      s.packageClaimer = s[`${prefix}PackageClaimer`];
      s.packageClaimedAt = s[`${prefix}PackageClaimedAt`];
      s.status = stage === 'qc'
        ? (claimed ? (s.qcRound === 1 ? 'pending_qc' : 'pending_reqc') : 'qc_pack_unclaimed')
        : (claimed ? 'pending_acceptance' : 'acceptance_pack_unclaimed');
    }

    (events || []).forEach(event => {
      if (!event || (event.taskId && event.taskId !== task.id)) return;
      if (s.deleted) {
        if (!s.legacyConflicts) s.legacyConflicts = [];
        s.legacyConflicts.push({ eventId: event.id || '', taskId: task.id, reason: '该导入已删除，后续旧页面记录未计入进度。' });
        return;
      }
      const conflict = assignmentConflict(event);
      if (conflict) {
        if (!s.legacyConflicts) s.legacyConflicts = [];
        s.legacyConflicts.push({ eventId: event.id || '', taskId: task.id, reason: conflict });
        return;
      }
      s.updatedAt = event.at || s.updatedAt;
      switch (event.type) {
        case 'task_deleted':
          s.deleted = true; s.status = 'deleted'; s.deletedAt = event.at || '';
          s.deletedBy = event.actor || ''; s.deletionReason = event.note || '';
          s.deletedBatchId = event.batchId || task.batchId || '';
          break;
        case 'claim':
          assignee(event);
          if (isReworkAssignment(event)) {
            // Claim remains readable by older pages so they enforce the new owner.
            // A reassignment changes ownership only; work state and rounds stay put.
            s.assignmentId = event.id || '';
            s.assignedFrom = event.fromAssignee || '';
            s.assignedBy = event.actor || '';
            s.assignedAt = event.at || '';
            s.assignmentReason = event.note || '';
          } else if (!s.assignmentId) s.status = 'annotating';
          break;
        case 'submit':
          assignee(event); s.round += 1; s.submittedAt = event.at || '';
          if (Number(event.workflowVersion) >= 3 || s.assignmentId) {
            s.status = s.round === 1 ? 'annotation_done' : 'annotation_rework_done';
          } else {
            // Old submitted cases were already in QC. Keep their actual state;
            // do not silently invent an unclaimed package during this upgrade.
            s.status = event.targetStatus || (s.round === 1 ? 'pending_qc' : 'pending_reqc');
            if (['pending_qc', 'pending_reqc'].includes(s.status)) s.qcRound = Math.max(s.qcRound, positiveRound(event.qcRound), lastQcReviewRound + 1);
          }
          break;
        case 'package_built': packageEvent(event, false); break;
        case 'package_claimed': packageEvent(event, true); break;
        case 'qc_fail':
        case 'qc_pass':
        case 'qc_reject':
          s.qcRound = Math.max(s.qcRound, positiveRound(event.qcRound) || positiveRound(event.packageRound) || positiveRound(event.round) || lastQcReviewRound + 1);
          lastQcReviewRound = s.qcRound;
          s.reviewedAt = event.at || '';
          if (event.type === 'qc_pass') {
            s.status = 'pending_acceptance';
            s.acceptanceRound = Math.max(s.acceptanceRound, lastAcceptanceReviewRound + 1);
          } else if (isQcReject(event)) {
            s.status = 'rejected'; s.finalRejectStage = 'qc'; s.finalRejectReason = rejectReason(event, QC_REJECT_MARKER);
            s.finalRejectedBy = event.actor || ''; s.finalRejectedAt = event.at || '';
          } else s.status = 'rework';
          break;
        case 'annotator_reject':
          assignee(event); s.rejectionResumeStatus = event.resumeStatus || s.status;
          s.status = 'rejection_pending'; s.rejectionReason = event.note || '';
          s.rejectionBy = event.actor || ''; s.rejectionAt = event.at || '';
          break;
        case 'reject_confirm':
          s.status = 'rejected'; s.rejectionConfirmReason = event.note || '';
          s.rejectionConfirmedBy = event.actor || ''; s.rejectionConfirmedAt = event.at || '';
          s.finalRejectStage = 'annotation_qc'; s.finalRejectReason = event.note || s.rejectionReason || '';
          s.finalRejectedBy = event.actor || ''; s.finalRejectedAt = event.at || '';
          break;
        case 'reject_return':
          s.status = event.resumeStatus || s.rejectionResumeStatus || 'annotating';
          s.rejectionReturnReason = event.note || ''; s.rejectionReturnedBy = event.actor || '';
          s.rejectionReturnedAt = event.at || '';
          break;
        case 'sent_acceptance':
          s.status = 'pending_acceptance';
          s.acceptanceRound = Math.max(s.acceptanceRound, positiveRound(event.acceptanceRound) || positiveRound(event.packageRound) || lastAcceptanceReviewRound + 1);
          break;
        case 'acceptance_pass':
        case 'acceptance_fail':
        case 'acceptance_reject':
          s.acceptanceRound = Math.max(s.acceptanceRound, positiveRound(event.acceptanceRound) || positiveRound(event.packageRound) || lastAcceptanceReviewRound + 1);
          lastAcceptanceReviewRound = s.acceptanceRound;
          s.acceptanceNote = event.note || ''; s.acceptanceReviewedBy = event.actor || '';
          s.acceptanceReviewedAt = event.at || '';
          if (event.type === 'acceptance_pass') s.status = 'accepted';
          else if (isAcceptanceReject(event)) {
            s.status = 'rejected'; s.finalRejectStage = 'acceptance'; s.finalRejectReason = rejectReason(event, ACCEPTANCE_REJECT_MARKER);
            s.finalRejectedBy = event.actor || ''; s.finalRejectedAt = event.at || '';
          } else s.status = Number(event.workflowVersion) >= 3 ? 'acceptance_return_pending' : 'acceptance_rework';
          break;
        case 'acceptance_route':
          if (!['qc', 'annotation'].includes(event.route)) break;
          s.acceptanceRoute = event.route; s.acceptanceRouteNote = event.note || '';
          s.acceptanceRoutedBy = event.actor || ''; s.acceptanceRoutedAt = event.at || '';
          s.status = event.route === 'qc' ? 'qc_self_rework' : 'acceptance_rework';
          break;
        case 'qc_repair_done':
          s.status = 'pending_acceptance'; s.qcRepairNote = event.note || '';
          s.qcRepairedBy = event.actor || ''; s.qcRepairedAt = event.at || '';
          s.acceptanceRound = Math.max(s.acceptanceRound, lastAcceptanceReviewRound + 1);
          break;
        case 'metadata_edit':
          if (event.after && event.after.tid) s.tid = event.after.tid;
          if (event.after && event.after.movie) s.movie = event.after.movie;
          break;
        default: break;
      }
    });
    // Earlier releases recorded an acceptance package before claiming it.
    // Keep those records, but include every task that reached acceptance in the
    // direct queue. No synthetic records or production data migration are needed.
    if (!s.deleted && ['qc_pass_unsent', 'qc_self_done', 'acceptance_pack_unclaimed'].includes(s.status)) {
      s.status = 'pending_acceptance';
      s.acceptanceRound = Math.max(s.acceptanceRound, s.acceptancePackageRound, lastAcceptanceReviewRound + 1);
    }
    return s;
  }

  function eventConflicts(events = []) {
    const taskIds = new Set(events.filter(event => isReworkAssignment(event) || event?.type === 'task_deleted').map(event => event.taskId));
    if (!taskIds.size) return [];
    const histories = new Map(Array.from(taskIds, id => [id, []]));
    events.forEach(event => { if (event && histories.has(event.taskId)) histories.get(event.taskId).push(event); });
    return Array.from(histories, ([id, history]) => project({ id }, history).legacyConflicts || []).flat();
  }

  function effectiveEvents(events = []) {
    const conflicts = new Set(eventConflicts(events).map(item => item.eventId));
    return conflicts.size ? events.filter(event => !conflicts.has(event.id)) : events;
  }

  function label(task) {
    if (!task) return '未知状态';
    if (task.deleted || task.status === 'deleted') return '已删除';
    if (task.status === 'rejected') return task.finalRejectStage === 'acceptance' ? '验收拒绝·已废弃' : task.finalRejectStage === 'qc' ? '质检拒绝·已废弃' : '标注拒绝·质检确认';
    if (['pending_qc', 'pending_reqc'].includes(task.status)) {
      const round = positiveRound(task.qcRound) || (task.status === 'pending_qc' ? 1 : 2);
      return round === 1 ? '待一次质检' : round === 2 ? '待二次质检' : `待第 ${round} 次质检`;
    }
    if (task.status === 'qc_pack_unclaimed') return `质检包待认领 · 第 ${positiveRound(task.qcPackageRound) || positiveRound(task.qcRound) + 1} 次`;
    if (task.status === 'acceptance_pack_unclaimed') return `验收包待认领 · 第 ${positiveRound(task.acceptancePackageRound) || positiveRound(task.acceptanceRound) + 1} 次`;
    if (task.status === 'pending_acceptance') return `待第 ${positiveRound(task.acceptanceRound) || 1} 次验收`;
    return STATUS_META[task.status] ? STATUS_META[task.status].label : String(task.status || '未知状态');
  }

  function counts(tasks) {
    const c = Object.fromEntries(Object.keys(STATUS_META).map(key => [key, 0]));
    c.total = 0; c.qcFirst = 0; c.qcSecond = 0; c.qcThirdPlus = 0;
    (tasks || []).forEach(task => {
      if (task.deleted || task.status === 'deleted') return;
      c.total += 1;
      if (Object.hasOwn(STATUS_META, task.status)) c[task.status] += 1;
      if (['pending_qc', 'pending_reqc'].includes(task.status)) {
        const round = positiveRound(task.qcRound) || (task.status === 'pending_qc' ? 1 : 2);
        c[round === 1 ? 'qcFirst' : round === 2 ? 'qcSecond' : 'qcThirdPlus'] += 1;
      }
    });
    c.annotation = c.unclaimed + c.annotating;
    c.qc = c.pending_qc + c.pending_reqc;
    c.repairs = c.rework + c.acceptance_rework + c.qc_self_rework;
    c.awaitingQcBuild = c.annotation_done + c.annotation_rework_done;
    c.awaitingAcceptanceBuild = c.qc_pass_unsent + c.qc_self_done;
    c.awaitingClaim = c.qc_pack_unclaimed + c.acceptance_pack_unclaimed;
    return c;
  }

  function canBuild(task, stage) {
    return !!task && !task.deleted && task.status !== 'deleted' && stage === 'qc' && ['annotation_done', 'annotation_rework_done'].includes(task.status);
  }

  return Object.freeze({ STATUS_META, project, label, counts, canBuild, isReworkAssignment, isQcReject, isAcceptanceReject, eventConflicts, effectiveEvents });
}));
