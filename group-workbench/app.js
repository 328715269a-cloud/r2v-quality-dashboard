(function () {
  'use strict';

  const GROUPS = [
    ...[1,2,3,4,5].map(number=>({id:'g0'+number,name:`单镜头${number}组`,leader:'',defaultMode:'single',members:[]})),
    ...[1,2,3,4,5,6,7,8,9,10,11,12].map(number=>({id:number<=5?'g'+String(number+5).padStart(2,'0'):'m'+String(number).padStart(2,'0'),name:`多镜头${number}组`,leader:'',defaultMode:'multi',members:[]}))
  ];
  const QC_TAGS = ['命名/ID对齐错误', '分类/标签归属错误', '朝向覆盖缺失（正/侧/背面）', '景别/机位/角度/朝向判定错误', 'AI生成/图片来源异常', 'ID合并/拆分错误', '主体/对象漏标', '图片模糊/清晰度不足', '黑边/裁切不完整', '其他主体混入/画面污染'];
  const QC_TAG_COLORS = ['#e4574c', '#e8913a', '#c9a227', '#7fae4e', '#3fa17b', '#3f8fae', '#5a6fd0', '#9a5fd0', '#c95893', '#8a8f98'];
  const STATUS_META = Object.fromEntries(Object.entries(window.WorkbenchFlow.STATUS_META).filter(([key])=>key!=='deleted'));
  const VIEW_META = {
    overview:{id:'overviewView',title:'小组总览'}, dispatch:{id:'dispatchView',title:'任务导入'},
    tasks:{id:'tasksView',title:'标注台'}, qc:{id:'qcView',title:'质检台'},
    acceptance:{id:'acceptanceView',title:'验收台'}, records:{id:'recordsView',title:'全部任务'}
  };
  const OVERVIEW_BUCKETS = {
    active: { label: '处理中', test: task => !['accepted','rejected'].includes(task.status) },
    closed: { label: '已闭环（通过 + 拒绝）', states: ['accepted','rejected'] },
    repairs: { label: '返修 / 打回待处理', states: ['rework','acceptance_return_pending','qc_self_rework','acceptance_rework'] }
  };

  let state = null;
  let currentView = 'overview';
  let dispatchDraft = null;
  const dispatchModuleDrafts=new Map();
  let selectedQcTaskId = '';
  let selectedTimelineTaskId = '';
  let toastTimer = null;
  let overviewTab = 'groups';
  let scopeDateHome = null;
  let recordWholeMovie = null;
  let batchEditorTicket = 0;

  const $ = (id) => document.getElementById(id);
  const qs = (selector, root) => (root || document).querySelector(selector);
  const qsa = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function uid(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `${prefix}_${window.crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function localDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function todayString() {
    return localDateString(new Date());
  }

  function addDays(dateString, offset) {
    const date = new Date(`${dateString}T12:00:00`);
    date.setDate(date.getDate() + offset);
    return localDateString(date);
  }

  function isoAt(dateString, hour, minute) {
    return `${dateString}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;
  }

  function eventDate(event) {
    const date = new Date(event?.at || '');
    return Number.isNaN(date.getTime()) ? '' : localDateString(date);
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).replace('T', ' ').slice(0, 16);
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function modeLabel(mode) {
    return mode === 'multi' ? '多镜头' : '单镜头';
  }

  function groupById(id) {
    return GROUPS.find((group) => group.id === id) || null;
  }

  function groupLabel(id) {
    const group = groupById(id);
    return group ? group.name : '未知小组';
  }

  const IO = window.WorkbenchDataIO;
  const store = window.WorkbenchStore.create();
  // Live flow: annotation completion enters QC immediately; QC has no new
  // package/claim step, and QC returns can create another QC round.
  const FLOW = { sendRole: 'qc', acceptanceDirect: true, qcReject: true, acceptanceReject: true, batchPackages: false, liveQc: true };
  let profile = null;
  let activeMode = 'single';
  function canViewAllGroups() { return !profile || ['admin','acceptance'].includes(profile.role); }
  function canViewGroup(groupId) { return canViewAllGroups() || groupId === profile.groupId; }
  const moduleEditorDrafts = new Map();
  const groupDayDrafts = new Map();
  const reworkAssignmentDrafts = new Map();
  let acceptanceDraft = null;
  let acceptanceBusy=false,acceptancePreviewTicket=0,qcMatchBusy=false,qcBulkReturnBusy=false;
  let selectedAcceptanceTaskId = '';
  const acceptanceSingleDrafts = new Map();
  const annotationStatuses = ['unclaimed', 'annotating', 'rework', 'acceptance_rework'];
  const qcStatuses = ['pending_qc', 'pending_reqc', 'rejection_pending'];

  const eventIndexes = new WeakMap();
  const snapshotCache = new WeakMap();
  function eventsForTask(taskId, source = state) {
    if (!eventIndexes.has(source)) {
      const index = new Map();
      source.events.forEach(event => { if (!index.has(event.taskId)) index.set(event.taskId, []); index.get(event.taskId).push(event); });
      eventIndexes.set(source, index);
    }
    return eventIndexes.get(source).get(taskId) || [];
  }
  function taskSnapshot(task, source = state) { return window.WorkbenchFlow.project(task, eventsForTask(task.id, source)); }
  function taskWithSnapshot(task, source = state) { return Object.assign({}, task, taskSnapshot(task, source)); }
  // Heavy projection cache: one pass per shared-state revision instead of one per caller.
  function taskIndex(source = state) {
    let entry = snapshotCache.get(source);
    if (!entry) {
      const history = source.tasks.map(task => taskWithSnapshot(task, source)).filter(task=>canViewGroup(task.groupId));
      entry = { history, tasks: history.filter(task=>!task.deleted) };
      snapshotCache.set(source, entry);
    }
    return entry;
  }
  function allTaskHistory(source = state) { return taskIndex(source).history; }
  function allTasks(source = state) { return taskIndex(source).tasks; }
  function groupTaskMap(tasks) { const map = new Map(); tasks.forEach(task => { const key = task.groupId; if (!map.has(key)) map.set(key, []); map.get(key).push(task); }); return map; }
  function movieGroupTaskMap(tasks) { const map = new Map(); tasks.forEach(task => { const key = `${task.groupId}|${task.movie}`; if (!map.has(key)) map.set(key, []); map.get(key).push(task); }); return map; }
  function visibleStateSnapshot() {
    const tasks=state.tasks.filter(task=>canViewGroup(task.groupId)),ids=new Set(tasks.map(task=>task.id));
    const events=state.events.filter(event=>canViewGroup(event.groupId)||ids.has(event.taskId));
    const batches=state.batches.filter(batch=>canViewGroup(batch.groupId)||(batch.taskIds||[]).some(id=>ids.has(id))).map(batch=>({...batch,taskIds:(batch.taskIds||[]).filter(id=>ids.has(id))}));
    return JSON.parse(JSON.stringify({...state,tasks,events,batches,preferences:{}}));
  }
  function findTask(source, id) {
    const task = source.tasks.find(item => item.id === id);
    if (!task) throw new Error('任务不存在，请重新选择。');
    const current=taskWithSnapshot(task, source);
    if(!canViewGroup(current.groupId))throw new Error('当前身份只能查看所属小组的任务。');
    if(current.deleted)throw new Error('该任务所属导入已删除，请重新选择。');
    return current;
  }
  function firstEvent(id, predicate, source = state) { return window.WorkbenchFlow.effectiveEvents(eventsForTask(id, source)).find(predicate); }
  function selectedRange() { return {dateFrom:$('scopeDateFrom').value,dateTo:$('scopeDateTo').value}; }
  function validScopeRange() { const {dateFrom,dateTo}=selectedRange();return !dateFrom||!dateTo||dateFrom<=dateTo; }
  function singleScopeDate() { const {dateFrom,dateTo}=selectedRange();return dateFrom&&dateFrom===dateTo?dateFrom:''; }
  function inDateRange(date,{dateFrom,dateTo}=selectedRange()) { return !!date&&(!dateFrom||date>=dateFrom)&&(!dateTo||date<=dateTo); }
  function scopeRangeLabel() { const {dateFrom,dateTo}=selectedRange();return singleScopeDate()||(dateFrom&&dateTo?`${dateFrom} 至 ${dateTo}`:dateFrom?`${dateFrom} 起`:dateTo?`截至 ${dateTo}`:'全部日期'); }
  function scopeRangeKey() { const {dateFrom,dateTo}=selectedRange();return `${dateFrom}|${dateTo}`; }
  function presetRange(preset) {
    const today=todayString(),offset=days=>{const date=new Date(`${today}T12:00:00`);date.setDate(date.getDate()+days);return localDateString(date);};
    return preset==='all'?{dateFrom:'',dateTo:''}:preset==='yesterday'?{dateFrom:offset(-1),dateTo:offset(-1)}:{dateFrom:offset(preset==='7days'?-6:preset==='30days'?-29:0),dateTo:today};
  }
  function syncScopeControls() {
    const invalid=!validScopeRange();$('scopeDateError').classList.toggle('hidden',!invalid);setText('scopeDateError','开始日期不能晚于结束日期');
    ['scopeDateFrom','scopeDateTo'].forEach(id=>$(id).setAttribute('aria-invalid',String(invalid)));
    qsa('[data-date-preset]').forEach(button=>{const range=presetRange(button.dataset.datePreset),current=selectedRange();button.setAttribute('aria-pressed',String(!invalid&&range.dateFrom===current.dateFrom&&range.dateTo===current.dateTo));});
  }
  function selectedGroup() { return canViewAllGroups()?($('scopeGroup').value||'all'):(profile?.groupId||'all'); }
  function inCurrentScope(task,withDate=true) {return canViewGroup(task.groupId)&&task.mode===activeMode&&(!withDate||inDateRange(task.date))&&(selectedGroup()==='all'||task.groupId===selectedGroup());}
  function configureScopeGroup(selected) {
    const groups=GROUPS.filter(group=>group.defaultMode===activeMode&&canViewGroup(group.id));
    const rows=canViewAllGroups()?[{value:'all',label:'全部小组'},...groups.map(group=>({value:group.id,label:group.name}))]:groups.map(group=>({value:group.id,label:group.name}));
    options($('scopeGroup'),rows,canViewAllGroups()?selected:profile?.groupId);
    $('scopeGroup').disabled=!canViewAllGroups();
    const label=$('scopeGroup').closest('label')?.querySelector('span');if(label)label.textContent=canViewAllGroups()?'查看小组':'所属小组（已锁定）';
  }
  function roleLabel(role) { return { annotation: '标注', qc: '组长 / 质检', acceptance: '验收', admin: '管理员' }[role] || ''; }
  function currentUserName() { return profile?.name || ''; }
  function ownsTask(task) { return !!profile && task.assignee === profile.name; }
  function populateLegacyIdentity() { if($('identityLegacy'))$('identityLegacy').value=''; }
  function requireRole(role, task) {
    if (!profile || profile.role !== role) throw new Error(`请以${roleLabel(role)}身份在对应工作台操作。`);
    if (task && task.mode!==activeMode) throw new Error('请切换到任务所属的单镜头或多镜头模块。');
    if (task && task.groupId !== profile.groupId && role !== 'acceptance') throw new Error('只能处理自己小组的任务。');
  }
  function requireManager() { if (!profile || !['admin', 'qc'].includes(profile.role)) throw new Error('请使用任务管理或质检身份管理导入内容。'); }
  function requireImportAdmin() { if(profile?.role!=='admin')throw new Error('任务导入仅管理员可操作，请联系管理员统一导入。'); }
  function canEditGroupDaily(groupId,mode=groupById(groupId)?.defaultMode) {
    const group=groupById(groupId);
    return !!group&&group.defaultMode===mode&&mode===activeMode&&(profile?.role==='admin'||profile?.role==='qc'&&profile.groupId===groupId);
  }
  function requireGroupEditor(groupId,mode=groupById(groupId)?.defaultMode) {
    if(!profile||!['qc','admin'].includes(profile.role))throw new Error('请使用组长 / 质检或管理员身份修改小组设置。');
    const group=groupById(groupId);
    if(!group||group.defaultMode!==mode||mode!==activeMode)throw new Error('请切换到该小组所属的单镜头或多镜头模块。');
    if(!canEditGroupDaily(groupId,mode))throw new Error('组长 / 质检只能修改本组设置。');
  }
  function requirePin(pin) { if (!String(pin).trim()) throw new Error('请输入修改权限码，由服务器验证后保存。'); }
  function requireGroupPin(pin) { if (!String(pin).trim()) throw new Error('请输入小组设置权限码，由服务器验证后保存。'); }
  function assertFresh(task, expected) { if (expected && task.updatedAt !== expected) throw new Error('这条任务已有新操作，请重新打开后再确认。当前填写内容已保留。'); }
  function newEvent(source, task, type, details = {}) {
    const latest = eventsForTask(task.id, source).reduce((max, event) => Math.max(max, Date.parse(event.at) || 0), 0);
    return Object.assign({ id: uid('event'), taskId: task.id, type, workflowVersion: 3, at: new Date(Math.max(Date.now(), latest + 1)).toISOString(), actor: currentUserName(), actorRole: profile?.role, tidAtEvent: task.tid, movieAtEvent: task.movie }, details);
  }
  let mutationDepth=0,sharedHasUpdates=false;
  const dirtyForms=new Set();
  async function mutate(builder,message,options={}) {
    const form=options.form||document.activeElement?.closest('form');
    mutationDepth+=1;setSharedStatus('saving','正在保存到云端…');
    try {state=await store.transact(builder,options);if(form)dirtyForms.delete(form);if(message)showToast(message);setSharedStatus('ready','已保存到云端');return true;}
    catch(error){showToast(error.message||'保存未完成，填写内容已保留。','error');if(options.errorTarget&&(!options.form||$(options.form.id)===options.form))setText(options.errorTarget,error.message);setSharedStatus('error',error.message);return false;}
    finally{mutationDepth-=1;}
  }
  function setSharedStatus(kind,message) {const banner=qs('.shared-banner');if(banner)banner.dataset.state=kind;setText('sharedSyncStatus',message);}
  function hasWorkDraft() {
    if(acceptanceDraft?.rows.some(row=>row.outcome==='success')||acceptanceBusy||qcMatchBusy||qcBulkReturnBusy)return true;
    for(const form of dirtyForms){if(!form.isConnected)dirtyForms.delete(form);else return true;}
    return !!qs('input[name="annotationTask"]:checked,input[name="qcTask"]:checked,input[name="acceptanceTask"]:checked,input[name="reworkAssignmentTask"]:checked');
  }
  async function syncShared(manual=false) {
    if(!profile||mutationDepth)return;
    try {const changed=await store.refresh();state=store.read();if(changed||sharedHasUpdates){if(!hasWorkDraft()&&!mutationDepth){if(manual){if(multiSelectOpen())deferredRender=true;else renderCurrentView();}else{scheduleCurrentView();}sharedHasUpdates=false;}else sharedHasUpdates=true;}
      $('sharedNewUpdatesLabel')?.classList.toggle('hidden',!sharedHasUpdates);setSharedStatus('ready',sharedHasUpdates?'已同步，当前填写内容已保留':'已连接共享数据');if(manual&&sharedHasUpdates)showToast('已同步云端数据，填写内容已保留。提交时会核对最新状态。');
    }catch(error){setSharedStatus('error',error.status===401?'身份验证已过期，请切换身份重新验证，填写内容已保留。':error.message);if(manual)showToast(error.message,'error');}
  }
  function refreshState() { try { state = store.read(); return true; } catch (error) { showToast(error.message, 'error'); return false; } }
  function setText(id, value) { if ($(id)) $(id).textContent = String(value); }
  function showToast(message, tone = '') {
    const toast = $('toast'); toast.textContent = message; toast.className = `toast ${tone}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add('hidden'), tone === 'error' ? 14000 : 6500);
  }
  function emptyRow(n, message) { return `<tr><td colspan="${n}" class="empty-cell">${escapeHtml(message)}</td></tr>`; }
  const BATCH_FIRST = 200, BATCH_NEXT = 400;
  const RENDER_GAP_MS = 1500;
  let lastRenderAt = 0, renderTimer = null, deferredRender = false;
  function multiSelectOpen() {
    const layer = $('multiSelectLayer');
    return !!layer && !layer.classList.contains('hidden');
  }
  function scheduleCurrentView() {
    clearTimeout(renderTimer);
    /* 多选面板打开时不做自动重渲染，避免列表重排把面板挤走 / 误关闭（8 秒自动同步会走到这里） */
    if (multiSelectOpen()) { deferredRender = true; return; }
    renderTimer = setTimeout(() => { renderTimer = null; renderCurrentView(); }, Math.max(0, RENDER_GAP_MS - (Date.now() - lastRenderAt)));
  }
  function renderRowsBatched(tbody, rows, colspan, emptyMessage) {
    if (!tbody) return;
    const token = `${Date.now()}-${Math.random()}`;
    tbody.dataset.renderToken = token;
    if (!rows.length) { tbody.innerHTML = emptyRow(colspan, emptyMessage); return; }
    tbody.innerHTML = rows.slice(0, BATCH_FIRST).join('');
    if (rows.length <= BATCH_FIRST) return;
    let index = BATCH_FIRST;
    const step = () => {
      if (tbody.dataset.renderToken !== token) return;
      const buffer = document.createElement('template');
      buffer.innerHTML = rows.slice(index, index + BATCH_NEXT).join('');
      tbody.appendChild(buffer.content);
      index += BATCH_NEXT;
      if (index < rows.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function statusPill(value) {
    const task=typeof value==='string'?{status:value}:value,meta=window.WorkbenchFlow.STATUS_META[task.status]||{tone:'pending'};
    return `<span class="status ${meta.tone}" data-state="${escapeHtml(task.status)}">${escapeHtml(window.WorkbenchFlow.label(task))}</span>`;
  }
  function modePill(mode) { return `<span class="tag">${escapeHtml(modeLabel(mode))}</span>`; }
  function tidMarkup(task) { return `<span class="tid-cell"><span class="mono">${escapeHtml(task.tid)}</span><button class="btn ghost small copy-tid" type="button" data-action="copy" data-tid="${escapeHtml(task.tid)}" aria-label="复制 TID ${escapeHtml(task.tid)}" title="复制 TID">复制</button></span>`; }
  function options(select, rows, selected) {
    if (!select) return; select.innerHTML = rows.map(row => `<option value="${escapeHtml(row.value)}">${escapeHtml(row.label)}</option>`).join('');
    if (rows.some(row => row.value === selected)) select.value = selected;
  }
  // Multi-select filter control: an empty selection means "all".
  const MULTI_SELECTS = new Map();
  function multiState(id) {
    if (!MULTI_SELECTS.has(id)) MULTI_SELECTS.set(id, {rows: [], selected: new Set(), query: ''});
    return MULTI_SELECTS.get(id);
  }
  function recordStatusOptions() {
    const statuses = Object.entries(STATUS_META).filter(([key]) => key !== 'annotating' && key !== 'qc_pack_unclaimed').map(([value, meta]) => ({value, label: meta.label}));
    const buckets = Object.entries(OVERVIEW_BUCKETS).map(([key, bucket]) => ({value: `overview_${key}`, label: bucket.label}));
    return [...statuses, ...buckets, {value: 'rejections', label: '拒绝相关（含待确认）'}];
  }
  function multiOptions(id, rows) {
    const s = multiState(id), valid = new Set(rows.map(row => row.value));
    s.rows = rows; [...s.selected].forEach(value => { if (!valid.has(value)) s.selected.delete(value); });
    multiPaint(id);
    const layer = $('multiSelectLayer');
    if (layer && !layer.classList.contains('hidden') && layer.dataset.owner === id) multiRenderList();
  }
  function multiGet(id) { return [...multiState(id).selected]; }
  function multiSet(id, values) {
    const s = multiState(id), list = (Array.isArray(values) ? values : [values]).filter(value => value && value !== 'all');
    s.selected = new Set(list); multiPaint(id);
  }
  function multiPaint(id) {
    const box = $(id); if (!box) return;
    const s = multiState(id), selected = s.rows.filter(row => s.selected.has(row.value));
    const target = box.querySelector('.multi-select-value');
    const text = selected.length ? (selected.length === 1 ? selected[0].label : `已选 ${selected.length} 项`) : (box.dataset.placeholder || '全部');
    if (target) target.textContent = text;
    box.classList.toggle('has-value', selected.length > 0);
    box.title = selected.length ? selected.map(row => row.label).join('、') : '';
  }
  function multiLayer() {
    let layer = $('multiSelectLayer');
    if (!layer) {
      layer = document.createElement('div'); layer.id = 'multiSelectLayer'; layer.className = 'multi-select-layer hidden'; document.body.appendChild(layer);
      layer.addEventListener('click', event => {
        event.stopPropagation();
        const id = layer.dataset.owner; if (!id) return;
        if (event.target === layer) { closeMultiSelect(); return; }
        const s = multiState(id);
        if (event.target.closest('[data-multi-clear]')) { s.selected.clear(); multiPaint(id); multiRenderList(); multiApply(id); return; }
        const item = event.target.closest('[data-multi-value]'); if (!item) return;
        const value = item.dataset.multiValue;
        if (s.selected.has(value)) s.selected.delete(value); else s.selected.add(value);
        multiPaint(id); multiRenderList(); multiApply(id);
      });
      layer.addEventListener('input', event => {
        const id = layer.dataset.owner;
        if (!id || !event.target.matches('.multi-select-search')) return;
        multiState(id).query = event.target.value; multiRenderList();
      });
    }
    return layer;
  }
  function multiRenderList() {
    const layer = multiLayer(), id = layer.dataset.owner; if (!id) return;
    const s = multiState(id), query = String(s.query || '').trim().toUpperCase();
    const rows = query ? s.rows.filter(row => String(row.label).toUpperCase().includes(query) || String(row.value).toUpperCase().includes(query)) : s.rows;
    const list = layer.querySelector('.multi-select-panel-list'); if (!list) return;
    list.innerHTML = rows.map(row => { const on = s.selected.has(row.value); return `<button type="button" class="multi-option${on ? ' selected' : ''}" data-multi-value="${escapeHtml(row.value)}" aria-pressed="${on}"><span class="multi-option-box" aria-hidden="true">${on ? '✓' : ''}</span><span>${escapeHtml(row.label)}</span></button>`; }).join('') || '<p class="multi-empty">没有匹配的选项。</p>';
  }
  function openMultiSelect(id) {
    const box = $(id); if (!box) return;
    const layer = multiLayer(); layer.dataset.owner = id; multiState(id).query = '';
    const rect = box.getBoundingClientRect(), width = Math.max(240, Math.min(320, rect.width + 60));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    layer.innerHTML = `<div class="multi-select-panel" style="top:${Math.round(rect.bottom + 6)}px;left:${Math.round(left)}px;width:${Math.round(width)}px"><div class="multi-select-panel-head"><input class="multi-select-search" type="search" placeholder="搜索选项" aria-label="搜索选项"><button type="button" class="btn ghost small" data-multi-clear="1">清空</button></div><div class="multi-select-panel-list"></div><p class="multi-select-hint">不勾选 = 全部，可同时勾选多项。</p></div>`;
    multiRenderList(); layer.classList.remove('hidden'); box.classList.add('open'); box.setAttribute('aria-expanded', 'true');
    const search = layer.querySelector('.multi-select-search'); if (search) search.focus();
  }
  function closeMultiSelect() {
    const layer = $('multiSelectLayer');
    if (layer) { layer.classList.add('hidden'); layer.innerHTML = ''; delete layer.dataset.owner; }
    qsa('.multi-select.open').forEach(box => { box.classList.remove('open'); box.setAttribute('aria-expanded', 'false'); });
    if (deferredRender) { deferredRender = false; if (refreshState()) renderCurrentView(); }
  }
  function toggleMultiSelect(id) {
    const layer = $('multiSelectLayer');
    if (layer && !layer.classList.contains('hidden') && layer.dataset.owner === id) { closeMultiSelect(); return; }
    closeMultiSelect(); openMultiSelect(id);
  }
  function multiApply(id) { if (id === 'recordMovie' || id === 'recordStatus') { if (refreshState()) renderRecords(); } }
  function initializeControls() {
    const groups = GROUPS.map(group => ({value: group.id, label: group.name}));
    configureScopeGroup(state.preferences.scopeGroup || 'all');
    populateIdentityGroups(profile?.mode || groupById(profile?.groupId)?.defaultMode || 'single', profile?.groupId);
    $('scopeDateFrom').value = state.preferences.scopeDateFrom ?? state.preferences.scopeDate ?? todayString();
    $('scopeDateTo').value = state.preferences.scopeDateTo ?? state.preferences.scopeDate ?? todayString();
    syncScopeControls();
    const form = $('dispatchForm');
    options(form.elements.group, groups, profile?.groupId || 'g01');
    form.elements.date.value = todayString(); form.elements.mode.value = 'single';
    const statuses = [{value: 'all', label: '全部状态'}, ...Object.entries(STATUS_META).filter(([key]) => key !== 'annotating').map(([value, meta]) => ({value, label: meta.label}))];
    multiOptions('recordStatus', recordStatusOptions());
    options($('myTaskFilter'), statuses, 'all');
    if ($('demoReset')) $('demoReset').remove();
  }
  function populateIdentityGroups(mode, selected) {
    const selectedMode=mode==='multi'?'multi':'single',groups=GROUPS.filter(group=>group.defaultMode===selectedMode);
    $('identityMode').value=selectedMode;
    options($('identityGroup'),groups.map(group=>({value:group.id,label:group.name})),selected);
    setText('identityModeHelp',selectedMode==='single'?'单镜头固定5个小组。':'多镜头固定12个小组。');
    setText('identityGroupHelp',selectedMode==='single'?'请选择：单镜头1组至单镜头5组。':'请选择：多镜头1组至多镜头12组。');
    if(state)populateLegacyIdentity();
  }
  function validWorkerProfile(value) { return value && /^\p{Script=Han}{1,20}$/u.test(value.name) && GROUPS.some(group => group.id === value.groupId && (!value.mode || group.defaultMode === value.mode)) && ['annotation','qc','acceptance'].includes(value.role); }
  function validProfile(value) {
    if(value?.role==='admin')return value.name==='admin'&&!value.groupId&&!value.mode&&!value.legacyName;
    return validWorkerProfile(value);
  }
  function selectIdentityEntry(entry) {
    const admin=entry==='admin';
    $('identityForm').classList.toggle('hidden',admin);
    $('identityAdminForm').classList.toggle('hidden',!admin);
    $('workerEntry').setAttribute('aria-pressed',String(!admin));
    $('adminEntry').setAttribute('aria-pressed',String(admin));
    setText('identityHeading',admin?'进入任务管理':'进入工作台');
    setText('identityIntro','');
    if(!admin)$('identityAdminName').value='';if($('identityAdminPin'))$('identityAdminPin').value='';if($('identityRolePin'))$('identityRolePin').value='';
    $(admin?'identityAdminName':'identityName').focus();
  }
  function syncIdentityRole() {
    const required=['qc','acceptance'].includes($('identityRole').value);
    $('identityRolePinField')?.classList.toggle('hidden',!required);if($('identityRolePin')){$('identityRolePin').required=required;$('identityRolePin').value='';}
  }
  async function saveIdentity(next,pin) {
    const controls=qsa('#identityGate input,#identityGate select,#identityGate button');controls.forEach(control=>control.disabled=true);
    try {const verified=await store.signIn(next,pin);profile=verified;state=store.read();clearTimeout(toastTimer);$('toast').classList.add('hidden');$('identityAdminName').value='';$('identityAdminPin').value='';$('identityRolePin').value='';enterApp();setSharedStatus('ready','已连接共享数据');}
    catch(error){showToast(error.message||'身份验证失败，请核对后重试。','error');}
    finally{controls.forEach(control=>{control.disabled=control.id==='identityLegacy';});}
  }
  function showIdentity() {
    batchEditorTicket+=1;
    if($('batchDeleteForm')){$('batchEditor').replaceChildren();$('batchEditor').classList.add('hidden');}
    $('identityGate').classList.remove('hidden'); $('appShell').classList.add('hidden');
    const worker=profile&&profile.role!=='admin'?profile:null;
    if(worker)$('identityName').value=worker.name;
    populateIdentityGroups(worker?.mode || groupById(worker?.groupId)?.defaultMode || activeMode,worker?.groupId);
    if(worker)$('identityRole').value=worker.role;syncIdentityRole();
    populateLegacyIdentity();
    $('identityAdminName').value='';
    selectIdentityEntry(profile?.role==='admin'?'admin':'worker');
  }
  function enterApp() {
    $('identityGate').classList.add('hidden');$('appShell').classList.remove('hidden');
    const admin=profile.role==='admin',mode=admin?activeMode:groupById(profile.groupId).defaultMode;
    setText('currentUserLabel',admin?'管理员':`${profile.name} · ${groupLabel(profile.groupId)} · ${roleLabel(profile.role)}`);
    const visible=new Set(['overview','records',...({annotation:['tasks'],qc:['qc'],acceptance:['acceptance'],admin:['dispatch']})[profile.role]]);
    qsa('nav [data-view]').forEach(button=>button.classList.toggle('hidden',!visible.has(button.dataset.view)));
    $('modeSwitcher').classList.toggle('hidden',!canViewAllGroups());
    applyModule(mode,false);
    configureScopeGroup(canViewAllGroups()?'all':profile.groupId);
    activateView(({annotation:'tasks',qc:'qc',acceptance:'acceptance',admin:'dispatch'})[profile.role]);
  }
  function activateView(view) {
    if (!VIEW_META[view]) view = 'overview';
    if(view==='dispatch'){try{requireImportAdmin();}catch(error){showToast(error.message,'error');return;}}
    if (!refreshState()) return;
    currentView = view;
    document.body.dataset.activeView=view;
    placeScopeDateControl();
    qsa('.view').forEach(element => element.classList.toggle('hidden', element.id !== VIEW_META[view].id));
    qsa('nav [data-view]').forEach(element => { element.classList.toggle('active', element.dataset.view === view); element.setAttribute('aria-current', element.dataset.view === view ? 'page' : 'false'); });
    setText('pageTitle', VIEW_META[view].title); renderCurrentView();
  }
  function renderCurrentView() {
    lastRenderAt = Date.now();
    syncScopeControls();
    if (currentView === 'overview') renderOverview();
    if (currentView === 'tasks') { renderTaskSearch(); renderMyTasks(); }
    if (currentView === 'qc') renderQcQueue();
    if (currentView === 'dispatch') renderDispatch();
    if (currentView === 'acceptance') renderAcceptance();
    if (currentView === 'records') renderRecords();
  }
  function counts(tasks) { return window.WorkbenchFlow.counts(tasks); }
  function matchesOverviewBucket(task,key) {
    const bucket=OVERVIEW_BUCKETS[key];
    return !!bucket&&(bucket.test?bucket.test(task):bucket.states.includes(task.status));
  }
  function placeScopeDateControl() {
    const control=qs('.scope-date-filter');
    if(!control||!$('overviewDateSlot'))return;
    if(!scopeDateHome){scopeDateHome=document.createComment('statistics-date-control');control.before(scopeDateHome);}
    if(currentView==='overview'){
      if(control.parentNode!==$('overviewDateSlot'))$('overviewDateSlot').prepend(control);
    }else if(control.previousSibling!==scopeDateHome)scopeDateHome.after(control);
    qs('.scope-date-heading > span',control).textContent=currentView==='overview'?'登记 / 工作量日期':'统计日期';
  }
  function selectOverviewTab(value,focus=false) {
    if(!['groups','movies','daily','people'].includes(value))return;
    overviewTab=value;
    qsa('[role="tab"][data-overview-tab]').forEach(button=>{
      const active=button.dataset.overviewTab===value;
      button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;
      if(active&&focus)button.focus();
    });
    qsa('[data-overview-panel]').forEach(panel=>panel.classList.toggle('hidden',panel.dataset.overviewPanel!==value));
    const scopes={groups:`实际作业与登记：${scopeRangeLabel()} · 累计任务截至当前`,movies:selectedGroup()==='all'?'整部影片 · 全部日期、全部参与小组的最新进度':`${groupLabel(selectedGroup())}参与的影片 · 进度汇总全部参与小组`,daily:`实际作业日期：${scopeRangeLabel()}`,people:`实际作业日期：${scopeRangeLabel()}`};
    qsa('[data-overview-range-label]').forEach(label=>{if(label.id==='groupDailyScopeHint')return;const tab=label.closest('[data-overview-panel]')?.dataset.overviewPanel;label.textContent=scopes[tab]||scopes[value];});
    $('overviewDateSlot').dataset.tab=value;
    let note=$('overviewDateNote');
    if(!note){note=document.createElement('p');note.id='overviewDateNote';note.className='overview-date-note';$('overviewDateSlot').append(note);}
    note.textContent=value==='groups'?'实际完成、效率与每日登记按所选日期；累计任务进度截至当前。':value==='movies'?'整片进度不受此日期区间限制。':'按实际操作日期统计，包含起止两天。';
  }
  function overviewStateTone(status) {
    if(status==='accepted')return 'success';
    if(status==='rejected')return 'neutral';
    if(['rework','acceptance_return_pending','qc_self_rework','acceptance_rework','rejection_pending'].includes(status))return 'danger';
    return ['unclaimed','annotating'].includes(status)?'info':'warning';
  }
  function overviewStateLink(status,c,groupId) {
    return `<button type="button" data-action="state-details" data-status="${status}"${groupId?` data-group-id="${escapeHtml(groupId)}"`:''} data-tone="${overviewStateTone(status)}"><span>${escapeHtml(STATUS_META[status].label)}</span><strong>${status==='unclaimed'?c.annotation:c[status]}</strong></button>`;
  }
  function openOverviewBucket(key,groupId) {
    if(!['all','accepted','rejected','rejection_pending','closed'].includes(key)&&!OVERVIEW_BUCKETS[key])return;
    if(groupId)$('scopeGroup').value=groupId;
    $('recordDateMode').value='all';$('recordSearch').value='';multiSet('recordMovie',[]);$('recordQcRound').value='all';
    multiSet('recordStatus',[OVERVIEW_BUCKETS[key]?`overview_${key}`:key]);
    activateView('records');
  }
  function countCells(c) {
    return [c.total,c.annotation,c.qc+c.awaitingQcBuild+c.qc_pack_unclaimed,c.repairs+c.acceptance_return_pending,c.awaitingAcceptanceBuild+c.acceptance_pack_unclaimed,c.pending_acceptance,c.accepted,c.rejection_pending,c.rejected].map(value=>`<td>${value}</td>`).join('');
  }
  function groupDailyRows(source=state,date) {
    const scope=date===undefined?selectedRange():{date};
    return window.WorkbenchReports.groupDaily({state:source,tasks:allTasks(source),groups:GROUPS,...scope,mode:activeMode,localDate:value=>{const parsed=new Date(value);return Number.isNaN(parsed.getTime())?'':localDateString(parsed);}});
  }
  function efficiencyText(row) {
    if(row.efficiencyIssue==='completed_without_headcount')return '人数待核对';
    return Number.isFinite(row.personDayEfficiency)?row.personDayEfficiency.toLocaleString('zh-CN',{maximumFractionDigits:2}):'—';
  }
  function efficiencyHint(row) {
    if(row.efficiencyIssue==='completed_without_headcount')return '有完成记录的日期在班人数为 0，请核对每日人数后再计算。';
    if(row.efficiencyIssue==='no_person_days')return '所选日期暂无在班人数。';
    return '实际完成总数 ÷ 在班总人天；不使用手填总量。';
  }
  function renderPersonDaily() {
    setText('personDailyScopeHint',validScopeRange()?`${scopeRangeLabel()} · ${selectedGroup()==='all'?'全部小组':groupLabel(selectedGroup())}`:'请修正日期区间');
    if(!$('personDailyDetails').open)return;
    if(!validScopeRange()){$('personDailyBody').innerHTML=emptyRow(6,'请修正日期区间');return;}
    const rows=window.WorkbenchReports.personDaily({state,tasks:allTasks(),groups:GROUPS.filter(group=>canViewGroup(group.id)),...selectedRange(),...(selectedGroup()==='all'?{}:{groupId:selectedGroup()}),mode:activeMode,localDate:value=>{const parsed=new Date(value);return Number.isNaN(parsed.getTime())?'':localDateString(parsed);}}).filter(row=>selectedGroup()==='all'||row.groupId===selectedGroup());
    $('personDailyBody').innerHTML=rows.map(row=>`<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(groupLabel(row.groupId))}</td><td>${escapeHtml(row.name)}</td><td>${row.completedTIDs??0}</td><td>${row.initialSubmissionTIDs??0}</td><td>${row.reworkSubmissionActions??0}</td></tr>`).join('')||emptyRow(6,'当前日期区间与小组暂无提交完成记录。');
  }
  function renderGroupProgress(tasks) {
    const validRange=validScopeRange(),byGroup=groupTaskMap(tasks);
    const rows=(validRange?groupDailyRows():GROUPS.filter(group=>group.defaultMode===activeMode).map(group=>({groupId:group.id,leader:'',total:null,headcount:null,members:[]}))).filter(row=>selectedGroup()==='all'||row.groupId===selectedGroup());
    const expanded=new Set(qsa('#groupProgressBody details[open]').map(details=>details.closest('tr').dataset.groupId));
    setText('groupDailyTotalLabel',singleScopeDate()?'当日总量（手填）':'区间总量（手填）');
    setText('groupDailyAttendanceLabel',singleScopeDate()?'在班人数':'区间在班人天');
    setText('groupDailyScopeHint',validRange?`统计日期 ${scopeRangeLabel()} · 实际完成与人数按日${singleScopeDate()?'统计':'累加'}，任务进度截至当前`:'请修正日期区间；累计任务进度仍为最新状态。');
    $('groupProgressBody').innerHTML=rows.map(row=>{
      const group=groupById(row.groupId),editable=validRange&&canEditGroupDaily(row.groupId),c=counts(byGroup.get(group.id)||[]);
      const members=row.members.length?`有标注记录：${row.members.join('、')}`:'所选日期暂无标注记录';
      const field=(name,value,label)=>editable?`<button type="button" class="group-cell-edit" data-action="edit-group-day" data-group-id="${escapeHtml(group.id)}" data-field="${name}" aria-label="修改${escapeHtml(group.name+label)}">${escapeHtml(value)}<span class="group-edit-icon" aria-hidden="true"></span></button>`:escapeHtml(value);
      const states=Object.keys(STATUS_META).filter(key=>key!=='annotating');
      const activeCount=c.total-c.accepted-c.rejected;
      const countLink=(key,value,tone)=>`<button type="button" class="group-count" data-action="overview-bucket" data-bucket="${key}" data-group-id="${escapeHtml(group.id)}" data-tone="${tone}">${value}</button>`;
      const details=`<details class="group-state-details"${expanded.has(group.id)?' open':''}><summary>查看状态</summary><div class="group-state-list">${states.map(key=>overviewStateLink(key,c,group.id)).join('')}</div></details>`;
      return `<tr data-group-id="${escapeHtml(group.id)}"><td><button type="button" class="btn ghost small" data-action="group-details" data-group-id="${escapeHtml(group.id)}">${escapeHtml(group.name)}</button></td><td class="group-leader">${field('leader',validRange?row.leader||'待填写':'—','负责人')}</td><td class="group-daily-total">${field('total',validRange?(row.total===null?'未填写':row.total):'—','每日总量')}</td><td class="group-headcount" title="${escapeHtml(members)}"><strong>${validRange?(row.headcount??'—'):'—'}</strong>${validRange?`<small>${row.isAggregate?'按日累计':row.headcountSource==='manual'?'手动调整':'自动识别'}${!row.isAggregate&&row.headcountSource==='manual'?` · 自动 ${row.autoHeadcount}`:''}</small>`:''}</td><td class="group-completed"><strong>${validRange?(row.completedTIDs??0):'—'}</strong></td><td class="group-efficiency" title="${escapeHtml(validRange?efficiencyHint(row):'请修正日期区间')}"><strong>${validRange?efficiencyText(row):'—'}</strong></td><td class="group-cumulative">${countLink('all',c.total,'info')}</td><td class="group-accepted">${countLink('closed',c.accepted+c.rejected,'success')}</td><td class="group-active">${countLink('active',activeCount,'info')}</td><td>${details}</td><td>${editable?`<button type="button" class="btn small" data-action="edit-group-day" data-group-id="${escapeHtml(group.id)}">填写 / 修改</button>`:'—'}</td></tr>`;
    }).join('');
    renderPersonDaily();
  }
  function showGroupDailyEditor(groupId,focusField='leader',editDate) {
    const group=groupById(groupId);requireGroupEditor(groupId,group?.defaultMode);
    if(!validScopeRange())throw new Error('请修正日期区间：开始日期不能晚于结束日期。');
    const target=$('groupDailyEditor'),existing=$('groupDailyForm'),range=selectedRange();
    const remembered=existing?.dataset.groupId===groupId&&inDateRange(existing.dataset.date)?existing.dataset.date:'';
    const date=editDate||singleScopeDate()||remembered||(inDateRange(todayString())?todayString():range.dateTo||range.dateFrom||todayString());
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!inDateRange(date))throw new Error('请选择区间内的具体登记日期。');
    const key=`${groupId}|${date}`,focusName=['total','date'].includes(focusField)?focusField:'leader';
    const focus=()=>{const form=$('groupDailyForm');form.dataset.scopeKey=scopeRangeKey();form.elements.date.min=range.dateFrom;form.elements.date.max=range.dateTo;target.scrollIntoView({block:'nearest'});form.elements[focusName].focus({preventScroll:true});};
    target.classList.remove('hidden');
    if(existing&&existing.dataset.groupId===groupId&&existing.dataset.date===date&&existing.dataset.groupMode===activeMode){existing.elements.date.value=date;focus();return;}
    if(existing){existing.elements.date.value=existing.dataset.date;groupDayDrafts.set(`${existing.dataset.groupId}|${existing.dataset.date}`,Array.from(target.childNodes));}
    const draft=groupDayDrafts.get(key);
    if(draft){target.replaceChildren(...draft);focus();return;}
    const row=groupDailyRows(state,date).find(item=>item.groupId===groupId);
    const leader=row.leader&&row.leader!=='待填写'?row.leader:profile.role==='qc'?profile.name:'';
    target.innerHTML=`<div class="panel-heading"><div><h3>${escapeHtml(group.name)} · 每日登记</h3><p>只保存所选一天，其他日期不变。</p></div></div>
      <form id="groupDailyForm" class="workbench-form group-daily-form" data-group-id="${escapeHtml(groupId)}" data-date="${escapeHtml(date)}" data-group-mode="${activeMode}" data-expected="${escapeHtml(row.latestEditId||'')}" data-expected-leader="${escapeHtml(row.leader||'')}">
      <label class="field"><span>登记日期</span><input name="date" type="date" required value="${escapeHtml(date)}"></label>
      <label class="field"><span>负责人中文名</span><input name="leader" required maxlength="20" value="${escapeHtml(leader)}"></label>
      <label class="field"><span>当天总量</span><input name="total" type="number" min="0" max="999999999" step="1" required value="${row.total===null?'':row.total}"></label>
      <label class="field"><span>在班人数（留空自动）</span><input name="headcount" type="number" min="0" max="9999" step="0.5" placeholder="自动识别 ${row.autoHeadcount} 人" value="${row.headcountSource==='manual'?row.headcount:''}"><small>自动 ${row.autoHeadcount} 人：${escapeHtml(row.members.join('、')||'暂无标注记录')}。半天可填 0.5。</small></label>
      <label class="field"><span>修改说明</span><input name="note" required maxlength="2000" placeholder="如：今天一位成员下午请假"></label>
      <label class="field"><span>小组设置密码</span><input name="pin" type="password" required inputmode="numeric" autocomplete="off"></label>
      <div class="row-actions"><button type="submit" class="btn primary">验证并保存</button><button type="button" class="btn ghost" data-action="close-group-day">取消</button></div></form>`;
    focus();
  }
  async function saveGroupDaily(form) {
    const groupId=form.dataset.groupId,date=form.dataset.date,mode=form.dataset.groupMode;
    requireGroupEditor(groupId,mode);requireGroupPin(form.elements.pin.value);
    const scopeKey=form.dataset.scopeKey;
    if(!validScopeRange()||!date||form.elements.date.value!==date||!inDateRange(date)||scopeKey!==scopeRangeKey())throw new Error('日期区间或登记日期已经切换，请重新打开对应日期的设置。当前填写内容已保留。');
    const leader=form.elements.leader.value.trim(),totalText=form.elements.total.value.trim(),headText=form.elements.headcount.value.trim(),note=form.elements.note.value.trim();
    const total=Number(totalText),headcount=headText===''?null:Number(headText);
    if(!/^\p{Script=Han}{1,20}$/u.test(leader))throw new Error('负责人姓名必须为 1 至 20 个中文汉字。');
    if(!totalText||!Number.isSafeInteger(total)||total<0||total>999999999)throw new Error('当天总量请填写非负整数。');
    if(headcount!==null&&(!Number.isFinite(headcount)||headcount<0||headcount>9999||!Number.isInteger(headcount*2)))throw new Error('在班人数请填写非负数，以 0.5 人为单位；留空恢复自动统计。');
    if(!note)throw new Error('请填写修改说明，保留每日调整原因。');
    const actor=profile.name,actorRole=profile.role,actorGroup=profile.groupId||'';
    const ok=await mutate(source=>{
      requireGroupEditor(groupId,mode);
      if(profile.name!==actor||profile.role!==actorRole||(profile.groupId||'')!==actorGroup||$('groupDailyForm')!==form||!validScopeRange()||scopeKey!==scopeRangeKey()||form.elements.date.value!==date||form.dataset.date!==date||!inDateRange(date))throw new Error('作业身份或日期已切换，请重新打开设置再保存。当前草稿已保留。');
      const current=groupDailyRows(source,date).find(row=>row.groupId===groupId);
      if((current.latestEditId||'')!==form.dataset.expected||(current.leader||'')!==form.dataset.expectedLeader)throw new Error('小组设置已有新修改，请重新打开后确认。当前草稿已保留。');
      const latest=source.events.filter(event=>event.type==='group_daily_edit'&&event.groupId===groupId).reduce((max,event)=>Math.max(max,Date.parse(event.at)||0),0);
      return {events:[{id:uid('group_day'),type:'group_daily_edit',taskId:`group:${groupId}`,groupId,mode,date,at:new Date(Math.max(Date.now(),latest+1)).toISOString(),actor,actorRole,before:{leader:current.leader||'',total:current.total,headcount:current.headcountSource==='manual'?current.headcount:null},after:{leader,total,headcount},note}]};
    },'当天的小组总量、负责人和在班人数已保存，修改历史已保留。',{pin:form.elements.pin.value,form});
    if(ok){groupDayDrafts.delete(`${groupId}|${date}`);if($('groupDailyForm')===form){$('groupDailyEditor').classList.add('hidden');$('groupDailyEditor').innerHTML='';}renderOverview();}
  }
  function firstQcAccuracy(tasks, range = selectedRange()) {
    let firstPass = 0, firstTotal = 0;
    if (range.dateFrom && range.dateTo && range.dateFrom > range.dateTo) return { firstPass, firstTotal, rate: null };
    tasks.forEach(task => {
      const qc = window.WorkbenchReports.annotationContributors(eventsForTask(task.id)).firstQc;
      if (!qc || !['qc_pass', 'qc_fail'].includes(qc.type) || !inDateRange(eventDate(qc), range)) return;
      firstTotal += 1;
      if (qc.type === 'qc_pass') firstPass += 1;
    });
    return { firstPass, firstTotal, rate: firstTotal ? firstPass / firstTotal * 100 : null };
  }

  function renderOverview() {
    const tasks=allTasks().filter(task=>inCurrentScope(task,false)),c=counts(tasks);
    const { firstPass, firstTotal, rate } = firstQcAccuracy(tasks);
    Object.entries({metricMovies:new Set(tasks.map(task=>window.WorkbenchReports.movieTitle(task))).size,metricActive:c.total-c.accepted-c.rejected,metricTotal:c.total,metricComplete:c.accepted+c.rejected,metricQcBuild:c.awaitingQcBuild,metricPendingQc:c.qc,metricRework:c.repairs,metricRate:c.total?`${((c.accepted+c.rejected)/c.total*100).toFixed(1)}%`:'0%',metricRejected:validScopeRange()?countRangeRejected():'—',metricRejectPending:c.rejection_pending,metricAcceptance:c.pending_acceptance,metricUnsent:0,metricQcClaim:c.qc_pack_unclaimed,metricReturnPending:c.acceptance_return_pending,metricQcSelf:c.qc_self_rework,metricAcceptanceClaim:0,metricFirstQcAccuracy:rate===null?'—':`${rate.toFixed(1)}%`}).forEach(([id,value])=>setText(id,value));
    setText('metricFirstQcDetail',!validScopeRange()?'请修正日期区间':`${scopeRangeLabel()} · ${firstTotal?`首检 ${firstTotal} 条 · 一次通过 ${firstPass}`:'暂无首检记录'}`);
    setText('metricRejectedHint',validScopeRange()?`${singleScopeDate()?'当日':'区间'}拒绝（条）· 按拒绝日期`:'请修正日期区间');
    const followups=[['repairs','返修 / 打回待处理','danger'],['rejection_pending','标注拒绝待确认','danger']];
    $('overviewFollowups').innerHTML=followups.map(([key,label,tone])=>{const count=key==='rejection_pending'?c.rejection_pending:tasks.filter(task=>matchesOverviewBucket(task,key)).length;return `<button type="button" class="overview-followup" data-action="overview-bucket" data-bucket="${key}" data-tone="${tone}"${count===0?' data-empty="true"':''}><span>${label}</span><strong>${count}</strong><span class="followup-arrow" aria-hidden="true">›</span></button>`;}).join('');
    const groups=[['标注与质检',['unclaimed','annotation_done','annotation_rework_done','qc_pack_unclaimed','pending_qc','pending_reqc']],['送验与完成',['qc_pass_unsent','qc_self_done','acceptance_pack_unclaimed','pending_acceptance','accepted']],['返修与拒绝',['rework','acceptance_return_pending','qc_self_rework','acceptance_rework','rejection_pending','rejected']]];
    $('statusBoard').innerHTML=groups.map(([label,keys])=>`<section class="status-group"><h3>${label}</h3><ul>${keys.map(key=>`<li>${overviewStateLink(key,c)}</li>`).join('')}${label==='标注与质检'?`<li class="round-breakdown"><button type="button" data-action="state-details" data-status="pending_reqc" data-round="2"><span>其中：待二次质检</span><strong>${c.qcSecond}</strong></button></li><li class="round-breakdown"><button type="button" data-action="state-details" data-status="pending_reqc" data-round="3plus"><span>其中：待三次及以上质检</span><strong>${c.qcThirdPlus}</strong></button></li>`:''}</ul></section>`).join('');
    renderGroupProgress(tasks);
    const bundles=IO.summaryRows(tasks,STATUS_META,groupLabel),byMovieGroup=movieGroupTaskMap(tasks);
    renderMovieProgress();
    $('rejectionSummaryBody').innerHTML=bundles.map(bundle=>{const c=counts(byMovieGroup.get(`${bundle.groupId}|${bundle.movie}`)||[]);return `<tr><td>${escapeHtml(bundle.movie)}</td><td>${escapeHtml(bundle.group)}</td><td>${c.rejection_pending}</td><td>${c.rejected}</td><td><button type="button" class="btn ghost small" data-action="package-rejections" data-movie="${escapeHtml(bundle.movie)}" data-group-id="${escapeHtml(bundle.groupId)}">查看明细</button></td></tr>`;}).join('')||emptyRow(5,'当前范围没有影片包。');renderPersonStats();renderErrorAnalysis(tasks);
    setText('allocationSummary', `${modeLabel(activeMode)} · ${selectedGroup()==='all'?'全部小组':groupLabel(selectedGroup())} · 截至当前 · 全部分配日期`);
    renderDailyReport();
    selectOverviewTab(overviewTab);
  }
  function renderMovieProgress(filterChanged=false) {
    const tasks=allTasks(),query=$('movieProgressSearch').value.trim().toLocaleLowerCase(),filter=$('movieProgressFilter').value;
    const rows=window.WorkbenchReports.movieProgress({tasks,mode:activeMode,groupId:selectedGroup(),groupLabel,statusMeta:STATUS_META}).filter(row=>!query||row.movie.toLocaleLowerCase().includes(query));
    const active=rows.filter(row=>!row.closed),closed=rows.filter(row=>row.closed);
    const byId=new Map(tasks.map(task=>[task.id,task]));
    const expanded=new Set(qsa('.movie-state-details[open]').map(details=>details.closest('tr').dataset.movieKey));
    const renderRow=row=>{
      const c=counts(row.taskIds.map(id=>byId.get(id)).filter(Boolean)),closedCount=row.accepted+row.rejected;
      const percentage=row.closed?100:Math.floor(row.closureRate*10)/10;
      const link=(status,label,value)=>`<button type="button" data-action="movie-progress-details" data-movie="${escapeHtml(row.movie)}" data-status="${status}" data-tone="${overviewStateTone(status)}"><span>${escapeHtml(label)}</span><strong>${value}</strong></button>`;
      const states=Object.keys(STATUS_META).filter(key=>key!=='annotating').map(key=>link(key,STATUS_META[key].label,key==='unclaimed'?c.annotation:c[key])).join('');
      return `<tr data-movie-key="${escapeHtml(row.key)}" data-movie-title="${escapeHtml(row.movie)}" data-closed="${row.closed}"><td><button type="button" class="btn ghost small movie-name-button" data-action="movie-progress-details" data-movie="${escapeHtml(row.movie)}" data-status="all">${escapeHtml(row.movie)}</button></td><td>${escapeHtml(row.groups.join('、'))}</td><td><span class="status ${row.closed?'done':'active'}">${row.closed?'已闭环':'流程中'}</span></td><td><div class="movie-progress-value"><progress value="${closedCount}" max="${row.total}" aria-label="已闭环 ${closedCount} / ${row.total} 条"></progress><strong>${percentage}%</strong></div><small>${closedCount} / ${row.total} 条已闭环</small><div class="movie-progress-meta"><span>验收通过 ${row.accepted}</span><span>已拒绝 ${row.rejected}</span></div></td><td class="movie-total"><strong>${row.total}</strong></td><td>${c.annotation}</td><td>${c.qc+c.awaitingQcBuild+c.qc_pack_unclaimed}</td><td>${c.awaitingAcceptanceBuild+c.acceptance_pack_unclaimed+c.pending_acceptance}</td><td>${c.repairs+c.acceptance_return_pending+c.rejection_pending}</td><td><details class="movie-state-details"${expanded.has(row.key)?' open':''}><summary>展开状态</summary><div class="movie-state-list">${states}</div></details></td></tr>`;
    };
    $('movieProgressBody').innerHTML=active.map(renderRow).join('')||emptyRow(10,query?'没有匹配的流程中影片。':'没有流程中的影片。');
    $('movieClosedBody').innerHTML=closed.map(renderRow).join('')||emptyRow(10,query?'没有匹配的已闭环影片。':'暂无已闭环影片。');
    setText('movieActiveCount',active.length);setText('movieClosedCount',closed.length);
    setText('movieProgressSummary',`共 ${rows.length} 部 · 流程中 ${active.length} 部 · 已闭环 ${closed.length} 部`);
    $('movieActiveSection').classList.toggle('hidden',filter==='closed');$('movieClosedSection').classList.toggle('hidden',filter==='active');
    if(filterChanged)$('movieClosedSection').open=filter==='closed';
  }
  function openWholeMovie(movie,status='all') {
    recordWholeMovie={title:movie,value:''};
    $('scopeGroup').value='all';$('recordDateMode').value='all';$('recordSearch').value='';$('recordQcRound').value='all';multiSet('recordStatus',[status]);multiSet('recordMovie',[]);
    activateView('records');multiSet('recordMovie',[recordWholeMovie.value]);renderRecords();
  }
  function renderPersonStats() {
    if(!validScopeRange()){$('personStatsBody').innerHTML=emptyRow(12,'请修正日期区间');return;}
    const result = new Map();
    const person=(groupId,name)=>{if(!name)return null;const key=JSON.stringify([groupId,name]);if(!result.has(key))result.set(key,{name,groupId,initial:0,rework:0,accepted:0,first:0,pass:0,P0:0,P1:0,P2:0,tags:new Map()});return result.get(key);};
    allTasks().filter(task=>inCurrentScope(task,false)).forEach(task => {
      person(task.groupId,task.assignee);
      const contribution=window.WorkbenchReports.annotationContributors(eventsForTask(task.id)),day=event=>inDateRange(eventDate(event));
      contribution.submissions.forEach(event=>{const row=person(task.groupId,event.name);if(row&&day(event))row[event.kind==='initial'?'initial':'rework']++;});
      const accept=contribution.firstAcceptance;if(accept&&day(accept)){const row=person(task.groupId,accept.name);if(row)row.accepted++;}
      const qc=contribution.firstQc;if(qc&&day(qc)){const row=person(task.groupId,qc.name);if(row){row.first++;if(qc.type==='qc_pass')row.pass++;else if(qc.type==='qc_fail'&&['P0','P1','P2'].includes(qc.pLevel)){row[qc.pLevel]++;(qc.tags||[]).forEach(tag=>row.tags.set(tag,(row.tags.get(tag)||0)+1));}}}
    });
    $('personStatsBody').innerHTML=[...result.values()].map(row=>{const chips=[...row.tags.entries()].sort((a,b)=>b[1]-a[1]).slice(0,2).map(([tag,count])=>`<button type="button" class="error-chip" data-action="error-person" data-key="${encodeURIComponent(JSON.stringify([row.groupId,row.name]))}" title="查看 ${escapeHtml(row.name)} 的错误标签分布">${escapeHtml(tag)}×${count}</button>`).join(' ');return `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(groupLabel(row.groupId))}</td>${['initial','rework','accepted','first','pass','P0','P1','P2'].map(key=>`<td>${row[key]}</td>`).join('')}<td>${row.first?`${(row.pass/row.first*100).toFixed(1)}%`:'暂无首检'}</td><td class="error-chip-cell">${chips||'<span class="muted">—</span>'}</td></tr>`;}).join('')||emptyRow(12,'当前范围还没有人员作业记录。');
  }
  function errorTagStats(tasks) {
    const stats=new Map();
    tasks.forEach(task=>{
      const qc=window.WorkbenchReports.annotationContributors(eventsForTask(task.id)).firstQc;
      if(!qc||qc.type!=='qc_fail'||!inDateRange(eventDate(qc))||!Array.isArray(qc.tags)||!qc.tags.length)return;
      const key=JSON.stringify([task.groupId,qc.name]);
      if(!stats.has(key))stats.set(key,{groupId:task.groupId,name:qc.name,items:[]});
      stats.get(key).items.push({pLevel:['P0','P1','P2'].includes(qc.pLevel)?qc.pLevel:'',tags:qc.tags});
    });
    return stats;
  }
  function renderErrorAnalysis(tasks) {
    const details=$('errorAnalysisDetails');
    if(!details||!details.open)return;
    const stats=errorTagStats(tasks),scopeSel=$('errorScope');
    const groups=new Map(),people=[];
    [...stats.entries()].forEach(([key,row])=>{groups.set(row.groupId,groupLabel(row.groupId));people.push({key,label:`${row.name}（${groupLabel(row.groupId)}）`});});
    people.sort((a,b)=>a.label.localeCompare(b.label,'zh-Hans-CN'));
    const prev=scopeSel.value;
    scopeSel.innerHTML='<option value="all">整体</option>'+[...groups.entries()].sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'zh-Hans-CN')).map(([id,label])=>`<option value="group:${escapeHtml(id)}">小组：${escapeHtml(label)}</option>`).join('')+people.map(p=>`<option value="person:${encodeURIComponent(p.key)}">${escapeHtml(p.label)}</option>`).join('');
    if([...scopeSel.options].some(option=>option.value===prev))scopeSel.value=prev;
    const scope=scopeSel.value,level=$('errorLevel').value,merged=new Map();
    let total=0,firstChecks=0;
    [...stats.entries()].forEach(([key,row])=>{
      if(scope.startsWith('group:')&&row.groupId!==scope.slice(6))return;
      if(scope.startsWith('person:')&&key!==JSON.parse(decodeURIComponent(scope.slice(7))))return;
      row.items.forEach(item=>{if(level!=='all'&&item.pLevel!==level)return;firstChecks++;item.tags.forEach(tag=>{merged.set(tag,(merged.get(tag)||0)+1);total++;});});
    });
    const body=$('errorAnalysisBody');
    if(!total){body.innerHTML='<p class="overview-detail-note">当前范围暂无首次质检打回的标签数据（质检拒绝不计入）。</p>';return;}
    const colorOf=tag=>QC_TAG_COLORS[QC_TAGS.indexOf(tag)]||'#8a8f98';
    const list=[...merged.entries()].map(([tag,count])=>({tag,count})).sort((a,b)=>b.count-a.count);
    let acc=0;
    const stops=list.map(item=>{const start=(acc/total*100).toFixed(2);acc+=item.count;return `${colorOf(item.tag)} ${start}% ${(acc/total*100).toFixed(2)}%`;});
    const rows=list.map(item=>{const pct=item.count/total*100;return `<div class="error-rank-row"><span class="error-dot" style="background:${colorOf(item.tag)}"></span><span class="error-rank-label" title="${escapeHtml(item.tag)}">${escapeHtml(item.tag)}</span><span class="error-rank-num"><strong>${item.count}</strong><small>${pct.toFixed(1)}%</small></span><span class="error-rank-bar"><span style="width:${pct.toFixed(2)}%;background:${colorOf(item.tag)}"></span></span></div>`;}).join('');
    body.innerHTML=`<div class="error-analysis-grid"><div class="error-pie-wrap"><div class="error-pie" style="background:conic-gradient(${stops.join(',')})" role="img" aria-label="错误标签占比饼图"></div><p class="muted">首检打回 ${firstChecks} 条 · 标签共 ${total} 个</p></div><div class="error-rank">${rows}</div></div>`;
  }
  function matchesStatus(task,status) { return status.startsWith('overview_')?matchesOverviewBucket(task,status.slice(9)):status==='all'||(status==='unclaimed'?['unclaimed','annotating'].includes(task.status):task.status===status); }
  function matchesStatusList(task,list) { return !list.length||list.some(status=>status==='rejections'?['rejected','rejection_pending'].includes(task.status):matchesStatus(task,status)); }
  function matchesQcRound(task,round) { return round==='all'||(round==='3plus'?task.qcRound>=3:String(task.qcRound)===round); }
  function renderTaskSearch() {
    const query=$('taskSearchInput').value.trim().toUpperCase();
    if(!query){$('taskSearchResult').innerHTML='';return;}
    const task=allTasks().find(task=>inCurrentScope(task,false)&&task.tid.toUpperCase()===query);
    $('taskSearchResult').innerHTML=task?`<div class="search-hit"><div>${tidMarkup(task)} <strong>${escapeHtml(task.movie)}</strong><p>${escapeHtml(groupLabel(task.groupId))} · ${statusPill(task)} · ${escapeHtml(task.assignee||'尚未登记到标注人')}</p></div></div>`:'<p class="muted">未找到完整 TID，请核对编号或先导入任务。</p>';
  }
  function renderMyTasks() {
    const filter=$('myTaskFilter').value;
    const rows=allTasks().filter(task=>task.mode===activeMode&&task.groupId===profile.groupId&&ownsTask(task)&&(filter==='actionable'?annotationStatuses.includes(task.status):matchesStatus(task,filter)));
    $('myTasksBody').innerHTML=rows.map(task=>{const actionable=annotationStatuses.includes(task.status);return `<tr><td>${actionable?`<input type="checkbox" name="annotationTask" value="${escapeHtml(task.id)}" aria-label="选择 ${escapeHtml(task.tid)}">`:''}</td><td>${tidMarkup(task)}</td><td>${escapeHtml(task.movie)}</td><td>${groupLabel(task.groupId)}</td><td>${modePill(task.mode)}</td><td>质检 ${task.qcRound} / 验收 ${task.acceptanceRound}</td><td>${statusPill(task)}</td><td>${formatDateTime(task.updatedAt)}</td><td><div class="row-actions">${actionable?`<button type="button" class="btn primary small" data-action="submit" data-task-id="${escapeHtml(task.id)}">${['annotating','unclaimed'].includes(task.status)?'提交完成':'返修完成'}</button><button type="button" class="btn ghost small" data-action="reject" data-task-id="${escapeHtml(task.id)}">拒绝</button>`:''}<button type="button" class="btn ghost small" data-action="open-timeline" data-task-id="${escapeHtml(task.id)}">详情</button></div></td></tr>`;}).join('')||emptyRow(9,'暂无符合条件的本人任务，可在上方登记 TID 或调整状态筛选。');$('annotationSelectAll').checked=false;
  }
  async function registerAnnotationTid() {
    const tid=$('taskSearchInput').value.trim().toUpperCase(),mode=activeMode,identity=JSON.stringify(profile);
    let alreadyOwned=false;
    if(await mutate(source=>{
      if(mode!==activeMode||identity!==JSON.stringify(profile)||tid!==$('taskSearchInput').value.trim().toUpperCase())throw new Error('身份、模块或 TID 已变化，请重新确认登记。');
      requireRole('annotation');if(!IO.validateTid(tid))throw new Error('请输入一个完整 TID 后登记。');
      const task=allTasks(source).find(task=>task.tid.toUpperCase()===tid);
      if(!task)throw new Error('未找到完整 TID，请核对编号或先导入任务。');
      requireRole('annotation',task);
      if(ownsTask(task)){alreadyOwned=true;return{events:[]};}
      if(task.status!=='unclaimed'||task.assignee)throw new Error('此 TID 已有标注人或不在可登记状态，不能覆盖。');
      return{events:[newEvent(source,task,'claim',{assignee:profile.name,note:'输入 TID 确认登记到本人'})]};
    })){$('myTaskFilter').value='all';renderTaskSearch();renderMyTasks();showToast(alreadyOwned?'这条任务已在本人名下，当前状态保持不变。':'已认领到本人名下，状态保持进行中。完成后请点击“提交完成”。');}
  }
  async function submitTask(id) { if(await mutate(source=>({events:annotationCompletion(source,findTask(source,id))}),'已提交完成，等待组长建质检包。')){renderMyTasks();renderTaskSearch();} }
  function showRejectForm(id) {
    const task=findTask(state,id), row=qsa('#myTasksBody tr').find(row=>row.querySelector(`[data-action="reject"][data-task-id="${CSS.escape(id)}"]`));
    if(!row)return;
    qsa('.inline-reject-row').forEach(node=>node.remove());const tr=document.createElement('tr');tr.className='inline-reject-row';
    tr.innerHTML=`<td colspan="9"><form id="rejectForm" data-task-id="${escapeHtml(id)}" data-expected="${escapeHtml(task.updatedAt)}"><label class="field"><span>拒绝原因（必填）</span><textarea name="note" required maxlength="2000" placeholder="说明这条 case 无法继续标注的原因"></textarea></label><div class="row-actions"><button class="btn primary" type="submit">提交拒绝，交质检确认</button><button class="btn ghost" type="button" data-action="cancel-reject">取消</button></div></form></td>`;row.after(tr);tr.querySelector('textarea').focus();
  }
  async function saveReject(form) {
    const note=form.elements.note.value.trim(); if(!note){showToast('请填写拒绝原因。','error');return;}
    if(await mutate(source=>{const task=findTask(source,form.dataset.taskId);requireRole('annotation',task);assertFresh(task,form.dataset.expected);if(!ownsTask(task)||!annotationStatuses.includes(task.status)||task.status==='unclaimed')throw new Error('此任务现在不能申请拒绝。');return{events:[newEvent(source,task,'annotator_reject',{note,assignee:profile.name,previousAssignee:task.assignee,resumeStatus:task.status})]};},'标注拒绝已提交，等待质检确认。'))renderMyTasks();
  }
  function renderQcQueue(preserveWorkbench=false) {
    renderReworkAssignments();const filter=$('qcTaskFilter').value;
    const statuses=['pending_qc','pending_reqc','rejection_pending','acceptance_return_pending','qc_self_rework'];
    const rows=allTasks().filter(task=>task.mode===activeMode&&task.groupId===profile.groupId&&statuses.includes(task.status)&&(filter==='all'||filter==='review'&&['pending_qc','pending_reqc'].includes(task.status)||filter==='return'&&['acceptance_return_pending','qc_self_rework'].includes(task.status)||filter===task.status)).sort((a,b)=>String(a.updatedAt).localeCompare(String(b.updatedAt)));
    $('qcQueueBody').innerHTML=rows.map(task=>{const reviewable=['pending_qc','pending_reqc'].includes(task.status);return `<tr><td><input type="checkbox" name="qcTask" value="${escapeHtml(task.id)}" data-expected="${escapeHtml(task.updatedAt)}" aria-label="选择 ${escapeHtml(task.tid)}"></td><td>${tidMarkup(task)}</td><td>${escapeHtml(task.assignee)}</td><td>${escapeHtml(task.movie)}</td><td>${statusPill(task)}</td><td>${formatDateTime(task.updatedAt)}</td><td><button type="button" class="btn primary small" data-action="review" data-task-id="${escapeHtml(task.id)}">${task.status==='rejection_pending'?'确认标注拒绝':task.status==='acceptance_return_pending'?'处理验收打回':task.status==='qc_self_rework'?'登记修改完成':reviewable?'开始质检':'查看处理'}</button></td></tr>`;}).join('')||emptyRow(7,'当前没有匹配的本组待办。标注提交完成后会实时进入这里，无需建质检包。');
    $('qcSelectAll').checked=false;if(selectedQcTaskId&&!rows.some(task=>task.id===selectedQcTaskId))selectedQcTaskId='';if(!preserveWorkbench)renderQcWorkbench(selectedQcTaskId);
  }
  function reworkAssignmentScope() { return JSON.stringify({profile,mode:activeMode}); }
  function reworkAssignmentSelection() {
    return qsa('input[name="reworkAssignmentTask"]:checked').map(input=>({id:input.value,expected:input.dataset.expected,assignee:input.dataset.assignee})).sort((a,b)=>a.id.localeCompare(b.id));
  }
  function syncReworkAssignmentSelection() {
    const inputs=qsa('input[name="reworkAssignmentTask"]'),selected=inputs.filter(input=>input.checked).length;
    setText('reworkAssignmentSelectedCount',selected);$('reworkAssignmentSubmit').disabled=!selected||$('reworkAssignmentForm').dataset.saving==='true';
    $('reworkAssignmentSelectAll').checked=!!inputs.length&&selected===inputs.length;
    $('reworkAssignmentSelectAll').indeterminate=selected>0&&selected<inputs.length;
  }
  function renderReworkAssignments() {
    const form=$('reworkAssignmentForm'),scope=reworkAssignmentScope();
    if(form.dataset.scope)reworkAssignmentDrafts.set(form.dataset.scope,{assignee:form.elements.assignee.value,reason:form.elements.reason.value,selected:reworkAssignmentSelection()});
    const draft=reworkAssignmentDrafts.get(scope)||{assignee:'',reason:'请假代修',selected:[]},selected=new Map(draft.selected.map(row=>[row.id,row]));
    if(form.dataset.scope!==scope){form.elements.assignee.value=draft.assignee;form.elements.reason.value=draft.reason;$('reworkAssignmentResult').textContent='';}
    form.dataset.scope=scope;
    const tasks=allTasks().filter(task=>profile?.role==='qc'&&task.mode===activeMode&&task.groupId===profile.groupId),eligible=task=>['rework','acceptance_rework'].includes(task.status)&&!!task.assignee;
    const rows=tasks.filter(task=>eligible(task)||selected.has(task.id)).sort((a,b)=>String(a.updatedAt).localeCompare(String(b.updatedAt)));
    setText('reworkAssignableCount',tasks.filter(eligible).length);
    $('reworkAssignmentBody').innerHTML=rows.map(task=>{
      const prior=selected.get(task.id),stale=prior&&prior.expected!==task.updatedAt;
      const latest=task.assignmentId?`<div class="rework-assignment-note"><strong>${escapeHtml(task.assignedFrom)} → ${escapeHtml(task.assignee)}</strong><small>${escapeHtml(task.assignmentReason)} · ${escapeHtml(task.assignedBy)} · ${formatDateTime(task.assignedAt)}</small></div>`:'<span class="muted">暂无</span>';
      return `<tr><td><input type="checkbox" name="reworkAssignmentTask" value="${escapeHtml(task.id)}" data-expected="${escapeHtml(prior?.expected||task.updatedAt)}" data-assignee="${escapeHtml(prior?.assignee||task.assignee)}" aria-label="选择代修 ${escapeHtml(task.tid)}"${prior?' checked':''}></td><td>${tidMarkup(task)}</td><td>${escapeHtml(task.movie)}</td><td>${escapeHtml(task.assignee)}</td><td>${statusPill(task)}${stale||!eligible(task)?'<small class="muted">记录已变化，请取消勾选后重新核对。</small>':''}</td><td>${latest}</td></tr>`;
    }).join('')||emptyRow(6,'本组暂无待标注返修任务。验收打回需先选择退给标注。');
    syncReworkAssignmentSelection();
  }
  async function saveReworkAssignment(form) {
    if(form.dataset.saving==='true')return;
    const scope=reworkAssignmentScope(),selected=reworkAssignmentSelection(),assignee=form.elements.assignee.value.trim(),note=form.elements.reason.value.trim();
    if(!selected.length){showToast('请先勾选需要分配的返修任务。','error');return;}
    const selection=JSON.stringify(selected);
    form.dataset.saving='true';syncReworkAssignmentSelection();
    if(await mutate(source=>{
      requireRole('qc');
      if(!form.isConnected||form!==$('reworkAssignmentForm')||form.dataset.scope!==scope||reworkAssignmentScope()!==scope||JSON.stringify(reworkAssignmentSelection())!==selection||form.elements.assignee.value.trim()!==assignee||form.elements.reason.value.trim()!==note)throw new Error('身份、模块、勾选任务或分配内容已变化，请重新确认。');
      if(!/^\p{Script=Han}{1,20}$/u.test(assignee))throw new Error('请填写接手人的中文名，1至20个汉字。');
      if(!note||note.length>500)throw new Error('请填写分配原因，最长500字。');
      if(new Set(selected.map(row=>row.id)).size!==selected.length)throw new Error('勾选任务重复，请重新选择。');
      return{events:selected.map(row=>{
        const task=findTask(source,row.id);requireRole('qc',task);assertFresh(task,row.expected);
        if(!['rework','acceptance_rework'].includes(task.status)||!task.assignee)throw new Error(`${task.tid} 当前不在可分配的标注返修状态，本次均未分配。`);
        if(task.assignee!==row.assignee)throw new Error(`${task.tid} 的标注人已变化，请重新核对。`);
        if(task.assignee===assignee)throw new Error(`${task.tid} 已由 ${assignee} 负责，无需重复分配。`);
        return newEvent(source,task,'claim',{workflowVersion:4,assignmentKind:'rework_transfer',fromAssignee:task.assignee,assignee,assignmentStatus:task.status,groupId:task.groupId,mode:task.mode,note});
      })};
    })){
      qsa('input[name="reworkAssignmentTask"]').forEach(input=>input.checked=false);
      renderReworkAssignments();$('reworkAssignmentResult').textContent=`已分配 ${selected.length} 条给 ${assignee} · ${note}`;
      showToast(`已分配 ${selected.length} 条返修任务，状态和原作业记录保留。`);
    }else if(refreshState())renderReworkAssignments();
    delete form.dataset.saving;syncReworkAssignmentSelection();
  }
  function renderQcWorkbench(id) {
    const target=$('qcWorkbench');if(!id){target.innerHTML='<div class="empty"><strong>选择任务处理</strong><span>同样的操作可先勾选多条，再批量通过、打回或拒绝。</span></div>';return;}
    const task=findTask(state,id);let fields='';
    if(task.status==='rejection_pending')fields=`<p><strong>标注拒绝原因：</strong>${escapeHtml(task.rejectionReason)}</p><label><input type="radio" name="decision" value="reject_confirm" required> 同意拒绝，不送验收</label><label><input type="radio" name="decision" value="reject_return" required> 不同意拒绝，退回标注继续做</label><label class="field"><span>确认说明（必填）</span><textarea name="note" required maxlength="2000"></textarea></label>`;
    else if(task.status==='acceptance_return_pending')fields=`<p><strong>验收打回：</strong>${escapeHtml(task.acceptanceNote)}</p><label><input type="radio" name="decision" value="acceptance_route_qc" required> 我来修改（质检自行返修）</label><label><input type="radio" name="decision" value="acceptance_route_annotation" required> 退给标注修改，改完重新质检</label><label class="field"><span>处理说明（必填）</span><textarea name="note" required maxlength="2000"></textarea></label>`;
    else if(task.status==='qc_self_rework')fields=`<p><strong>验收问题：</strong>${escapeHtml(task.acceptanceNote)}</p><input type="hidden" name="decision" value="qc_repair_done"><label class="field"><span>修改说明（必填）</span><textarea name="note" required maxlength="2000"></textarea></label>`;
    else if(['pending_qc','pending_reqc'].includes(task.status))fields=qcReviewFields();
    else{target.innerHTML='<p class="muted">标注提交完成后会自动进入质检队列，无需建包或领取。</p>';return;}
    target.innerHTML=`<div class="panel-heading"><div><h3>${escapeHtml(task.tid)}</h3><p>${escapeHtml(task.movie)} · ${escapeHtml(task.assignee)}</p></div>${statusPill(task)}</div><form id="qcDecisionForm" class="workbench-form" data-task-id="${escapeHtml(id)}" data-expected="${escapeHtml(task.updatedAt)}">${fields}<button class="btn primary" type="submit">${task.status==='qc_self_rework'?'我已修改完成':'保存处理结果'}</button></form>`;
  }
  async function saveQcDecision(form) {
    const decision=(form.querySelector('input[name="decision"]:checked')||form.querySelector('input[name="decision"][type="hidden"]'))?.value,note=form.elements.note.value.trim(),pLevel=form.elements.pLevel?.value,tags=qsa('input[name="tags"]:checked',form).map(input=>input.value);
    if(await mutate(source=>{const task=findTask(source,form.dataset.taskId);assertFresh(task,form.dataset.expected);return{events:[qcDecisionEvent(source,task,decision,note,pLevel,tags)]};},'处理已保存，待办状态已更新。')){selectedQcTaskId='';renderQcQueue();}
  }
  function dispatchValues() {const f=$('dispatchForm');return{date:f.elements.date.value,groupId:f.elements.group.value,mode:activeMode,movie:f.elements.movie.value.trim(),text:f.elements.tids.value};}
  function evaluateTaskImport(values,source) {
    requireImportAdmin();
    if(values.mode!==activeMode||groupById(values.groupId)?.defaultMode!==activeMode)throw new Error('请在对应的单镜头或多镜头模块导入，并选择该业务的小组。');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(values.date)||!groupById(values.groupId))throw new Error('请填写业务日期和小组。');
    if(!values.movie||values.movie.length>200)throw new Error('请单独填写影片名，最长200字。');
    const mixed=IO.parseTable(values.text).records.find(row=>row.cells.length!==1||row.cells.some(cell=>/[\t,]/.test(cell)));
    if(mixed)throw new Error(`第 ${mixed.line} 行包含多列。影片名请填写在上方，TID 区域只能保留一列编号；本次尚未导入。`);
    const rows=IO.parseTaskRows(values.text,values.movie),existing=new Set(allTasks(source).map(task=>task.tid.toUpperCase())),seen=new Set();
    return rows.map(row=>{let error=row.error;if(!error&&(!row.movie||row.movie.length>200))error='影片名必填，且不能超过200字';if(!error&&!IO.validateTid(row.tid))error='TID 格式不正确';let outcome=error?'failed':'success';if(!error&&(seen.has(row.tid.toUpperCase())||existing.has(row.tid.toUpperCase())))outcome='duplicate';if(row.tid)seen.add(row.tid.toUpperCase());return{...row,outcome,error};});
  }
  function importReport(rows,committed=false) {
    const success=rows.filter(row=>row.outcome==='success').length,duplicates=rows.filter(row=>row.outcome==='duplicate').length,failed=rows.length-success-duplicates;
    return `<div class="import-result"><strong>${committed?'成功':'可导入'} ${success} 条</strong><span>重复跳过 ${duplicates} 条 · 失败 ${failed} 条 · 共 ${rows.length} 条</span></div>${rows.some(row=>row.outcome!=='success')?`<details open><summary>查看跳过与失败明细</summary><div class="table-wrap"><table><thead><tr><th>行号</th><th>TID</th><th>原因</th></tr></thead><tbody>${rows.filter(row=>row.outcome!=='success').map(row=>`<tr><td>${row.line}</td><td>${escapeHtml(row.tid||'空')}</td><td>${escapeHtml(row.error||(row.outcome==='duplicate'?'TID 重复，未修改原记录':'状态不允许更新'))}</td></tr>`).join('')}</tbody></table></div></details>`:''}`;
  }
  function previewDispatch() {
    try {requireImportAdmin();dispatchDraft=null;$('dispatchCommitBtn').disabled=true;if(!refreshState())return;const values=dispatchValues(),rows=evaluateTaskImport(values,state);if(!rows.length)throw new Error('请粘贴本次 TID，每行一个。');dispatchDraft={signature:JSON.stringify(values),rows};$('dispatchPreview').innerHTML=dispatchImportContext(values)+importReport(rows);$('dispatchCommitBtn').disabled=!rows.some(row=>row.outcome==='success');}catch(error){$('dispatchCommitBtn').disabled=true;$('dispatchPreview').textContent=error.message;showToast(error.message,'error');}
  }
  function dispatchImportContext(values) {return `<p id="dispatchImportContext" class="dispatch-import-context"><strong>影片：${escapeHtml(values.movie)}</strong><span>${escapeHtml(groupLabel(values.groupId))} · 分配日期 ${escapeHtml(values.date)}</span></p>`;}
  async function commitDispatch() {
    try{requireImportAdmin();}catch(error){showToast(error.message,'error');return;}
    const values=dispatchValues();if(!dispatchDraft||dispatchDraft.signature!==JSON.stringify(values)){previewDispatch();showToast('内容发生变化，请确认新的预检结果后再导入。','warning');return;}
    let imported=[];
    if(await mutate(source=>{
      requireImportAdmin();imported=evaluateTaskImport(values,source);const valid=imported.filter(row=>row.outcome==='success');if(!valid.length)throw new Error('没有可导入的新 TID。');
      const tasks=[],events=[],batches=[],now=new Date().toISOString(),movies=[...new Set(valid.map(row=>row.movie))];
      for(const movie of movies){const batch={id:uid('batch'),date:values.date,groupId:values.groupId,mode:values.mode,movie,taskIds:[],createdAt:now,createdBy:profile.name};
        for(const row of valid.filter(row=>row.movie===movie)){const task={id:uid('task'),tid:row.tid,movie,date:values.date,groupId:values.groupId,mode:values.mode,batchId:batch.id,createdAt:now,createdBy:profile.name};tasks.push(task);batch.taskIds.push(task.id);events.push(newEvent(source,task,'dispatch',{note:'影片与 TID 批量导入'}));}batches.push(batch);
      }return{tasks,events,batches};
    },'任务导入完成。')){$('dispatchPreview').innerHTML=dispatchImportContext(values)+importReport(imported,true);$('dispatchCommitBtn').disabled=true;dispatchDraft=null;renderDispatch();}
  }
  function importBatchInfo(id,source=state) {
    const batch=source.batches.find(item=>item.id===id&&item.kind!=='handoff');
    if(!batch)throw new Error('未找到这次导入。');
    const tasks=allTaskHistory(source).filter(task=>task.batchId===id||batch.taskIds?.includes(task.id));
    const memberIds=new Set(tasks.map(task=>task.id)),declared=new Set(batch.taskIds||[]);
    const complete=tasks.length>0&&tasks.length===declared.size&&declared.size===(batch.taskIds||[]).length&&tasks.every(task=>task.batchId===id&&declared.has(task.id));
    const deleted=tasks.length>0&&tasks.every(task=>task.deleted),partial=tasks.some(task=>task.deleted)&&!deleted;
    const started=source.events.some(event=>memberIds.has(event.taskId)&&!['dispatch','metadata_edit','task_deleted'].includes(event.type));
    const linked=source.batches.some(item=>item.kind==='handoff'&&(item.taskIds||[]).some(taskId=>memberIds.has(taskId)));
    const reason=deleted?'这次导入已删除':!complete||partial?'记录关联不完整，请先核对':started||linked?'已有认领或作业记录，不能整批删除':'';
    return {batch,tasks,deleted,started,reason,canDelete:!reason};
  }
  function renderDispatch() {
    const filter=$('batchRecordFilter').value;
    const batches=state.batches.filter(batch=>batch.kind!=='handoff'&&(batch.mode||groupById(batch.groupId)?.defaultMode)===activeMode&&(selectedGroup()==='all'||batch.groupId===selectedGroup())).slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    const records=batches.map(batch=>importBatchInfo(batch.id)).filter(info=>filter==='all'||(filter==='deleted'?info.deleted:!info.deleted));
    setText('batchRecordCount','共 '+records.length+' 次导入 · 全部分配日期');
    $('batchBody').innerHTML=records.map(info=>{
      const {batch,tasks,deleted,canDelete,reason}=info,movie=[...new Set(tasks.map(task=>task.movie))].join('、')||batch.movie;
      const last=tasks.find(task=>task.deleted),status=deleted?'已删除':info.started?'已开始作业':'未开始作业';
      const deletion=deleted?'<small>'+escapeHtml(last.deletedBy)+' · '+formatDateTime(last.deletedAt)+'</small>':'';
      const actions='<button class="btn ghost small" type="button" data-action="batch-details" data-batch-id="'+escapeHtml(batch.id)+'">查看 TID</button>'+(!deleted?'<button class="btn ghost small" type="button" data-action="edit-batch" data-batch-id="'+escapeHtml(batch.id)+'">修改</button>':'')+(profile?.role==='admin'&&!deleted?'<button class="btn ghost small text-danger" type="button" data-action="delete-batch" data-batch-id="'+escapeHtml(batch.id)+'" '+(!canDelete?'disabled title="'+escapeHtml(reason)+'"':'')+'>删除本次</button>':'');
      return '<tr data-batch-id="'+escapeHtml(batch.id)+'" class="'+(deleted?'import-record-deleted':'')+'"><td>'+escapeHtml(movie)+'</td><td>'+escapeHtml(batch.date)+'</td><td>'+escapeHtml(groupLabel(batch.groupId))+'</td><td>'+tasks.length+'</td><td>'+escapeHtml(batch.createdBy)+'</td><td>'+formatDateTime(batch.createdAt)+'</td><td><span class="tag '+(deleted?'neutral':info.started?'info':'')+'">'+status+'</span>'+deletion+'</td><td><div class="row-actions">'+actions+'</div></td></tr>';
    }).join('')||emptyRow(8,'没有符合条件的导入记录。');
  }
  function showBatchDetails(id,scroll=true) {
    requireManager();const {batch,tasks,deleted}=importBatchInfo(id);
    if((batch.mode||groupById(batch.groupId)?.defaultMode)!==activeMode)throw new Error('请先切换到这次导入所属模块。');
    const target=$('batchDetail');target.dataset.batchId=id;target.classList.remove('hidden');
    target.innerHTML='<div class="panel-heading"><div><h3>本次导入 · '+tasks.length+' 条 TID</h3><p>'+escapeHtml(groupLabel(batch.groupId))+' · '+formatDateTime(batch.createdAt)+' · '+escapeHtml(batch.createdBy)+'</p></div><button class="btn ghost small" type="button" data-action="close-batch-detail">收起</button></div>'+(deleted?'<p class="import-record-note">这次导入已删除，原始任务与历史仍保留。</p>':'')+'<div class="table-wrap"><table><thead><tr><th>TID</th><th>影片</th><th>当前状态</th><th>历史记录</th></tr></thead><tbody>'+tasks.map(task=>'<tr><td>'+tidMarkup(task)+'</td><td>'+escapeHtml(task.movie)+'</td><td>'+statusPill(task)+'</td><td><details><summary>查看 '+eventsForTask(task.id).length+' 条记录</summary><ol class="import-event-list">'+eventsForTask(task.id).map(event=>'<li><span>'+formatDateTime(event.at)+' · '+escapeHtml(event.actor)+' · '+escapeHtml(eventLabel(event))+'</span><small>'+escapeHtml(eventDetail(event))+'</small></li>').join('')+'</ol></details></td></tr>').join('')+'</tbody></table></div>';
    if(scroll)target.scrollIntoView({block:'nearest'});
  }
  function requireImportDelete(info) {
    if(profile?.role!=='admin')throw new Error('仅管理员可以删除导入记录中的任务。');
    if((info.batch.mode||groupById(info.batch.groupId)?.defaultMode)!==activeMode)throw new Error('请切换回这次导入所属模块。');
    if(!info.canDelete)throw new Error(info.reason+'。');
  }
  function showBatchDelete(id) {
    batchEditorTicket+=1;
    const info=importBatchInfo(id);requireImportDelete(info);
    const target=$('batchEditor'),movie=[...new Set(info.tasks.map(task=>task.movie))].join('、');
    target.classList.remove('hidden');
    target.innerHTML='<div class="panel-heading"><div><h3>删除本次导入</h3><p>'+escapeHtml(movie)+' · '+escapeHtml(groupLabel(info.batch.groupId))+' · <strong>'+info.tasks.length+' 条 TID</strong></p></div></div><form id="batchDeleteForm" class="workbench-form" data-batch-id="'+escapeHtml(id)+'"><p class="import-delete-note">整批任务将退出待办和统计，导入记录与历史仍保留。已有认领或作业记录时不能删除。</p><details><summary>核对本次 TID</summary><p class="import-tid-list">'+info.tasks.map(task=>escapeHtml(task.tid)).join('<br>')+'</p></details><label class="field"><span>删除原因（可选）</span><input name="note" maxlength="2000" placeholder="例如：导错影片或小组"></label><label class="field"><span>再次输入管理密码</span><input name="pin" type="password" inputmode="numeric" required autocomplete="new-password" value=""></label><p id="batchDeleteError" class="text-danger" role="alert"></p><div class="row-actions"><button type="submit" class="btn danger">验证密码并删除</button><button type="button" class="btn ghost" data-action="close-batch-editor">取消</button></div></form>';
    const form=$('batchDeleteForm');form.__expected=Object.fromEntries(info.tasks.map(task=>[task.id,task.updatedAt]));form.__identity=JSON.stringify(profile);form.__mode=activeMode;form.elements.pin.focus();target.scrollIntoView({block:'nearest'});
  }
  async function saveBatchDelete(form) {
    const pin=form.elements.pin.value,note=form.elements.note.value.trim()||'误导入，删除本次导入';
    form.elements.pin.value='';form.dataset.busy='true';setText('batchDeleteError','');
    try {
      const saved=await mutate(source=>{
        if(!form.isConnected||form.__mode!==activeMode||form.__identity!==JSON.stringify(profile))throw new Error('身份或模块已变化，请重新打开删除确认。');
        const info=importBatchInfo(form.dataset.batchId,source);requireImportDelete(info);requirePin(pin);
        if(info.tasks.length!==Object.keys(form.__expected).length||info.tasks.some(task=>!Object.hasOwn(form.__expected,task.id)))throw new Error('本次导入的任务已变化，请重新核对。');
        for(const task of info.tasks)assertFresh(task,form.__expected[task.id]);
        return {events:info.tasks.map(task=>newEvent(source,task,'task_deleted',{batchId:info.batch.id,expectedUpdatedAt:task.updatedAt,note}))};
      },'本次导入已删除，导入记录与历史已保留。',{pin,form,errorTarget:'batchDeleteError'});
      if(saved){if($('batchDeleteForm')===form){$('batchEditor').replaceChildren();$('batchEditor').classList.add('hidden');}if($('batchDetail').dataset.batchId===form.dataset.batchId&&!$('batchDetail').classList.contains('hidden'))showBatchDetails(form.dataset.batchId,false);renderDispatch();}
      else if(form.isConnected)form.elements.pin.focus();
    }finally{delete form.dataset.busy;}
  }
  function showBatchEditor(id) {
    batchEditorTicket+=1;
    const info=importBatchInfo(id),{batch,tasks}=info;if(info.deleted)throw new Error('这次导入已删除，不能修改。');
    const movies=[...new Set(tasks.map(task=>task.movie))],target=$('batchEditor');
    target.classList.remove('hidden');target.innerHTML=`<div class="panel-heading"><div><h3>修改导入内容</h3><p>共 ${tasks.length} 条。按原 TID 对应新 TID 纠错，保留人员、状态和全部流水。</p></div></div><form id="batchEditForm" class="workbench-form" data-batch-id="${escapeHtml(id)}"><label class="field"><span>影片名（留空保持原名）</span><input name="movie" maxlength="200" value="${escapeHtml(movies.length===1?movies[0]:'')}"></label><label class="field"><span>TID 纠错，每行：原 TID,新 TID（不改编号可留空）</span><textarea name="corrections" rows="5" placeholder="原TID,新TID"></textarea></label><label class="field"><span>修改原因</span><input name="note" required maxlength="2000"></label><label class="field"><span>修改 PIN</span><input name="pin" type="password" inputmode="numeric" required autocomplete="off"></label><div class="row-actions"><button type="submit" class="btn primary">验证 PIN 并保存</button><button type="button" class="btn ghost" data-action="close-batch-editor">取消</button></div></form>`;
    target.querySelector('form').__expected=Object.fromEntries(tasks.map(task=>[task.id,task.updatedAt]));target.scrollIntoView({block:'nearest'});
  }
  function validateEdits(source,edits) {
    const tasks=allTasks(source),next=new Map(tasks.map(task=>[task.id,task.tid.toUpperCase()]));
    for(const edit of edits){if(!IO.validateTid(edit.after.tid))throw new Error('新 TID 只能包含字母、数字、下划线和连字符，最长128位。');if(!edit.after.movie||edit.after.movie.length>200)throw new Error('影片名必填，最长200字。');next.set(edit.id,edit.after.tid.toUpperCase());}
    const seen=new Set();for(const tid of next.values()){if(seen.has(tid))throw new Error('修改后 TID 重复，请核对，尚未保存任何修改。');seen.add(tid);}
  }
  async function saveBatchEdit(form) {
    const movie=form.elements.movie.value.trim(),note=form.elements.note.value.trim(),pin=form.elements.pin.value,raw=form.elements.corrections.value.trim();
    if(!note){showToast('请填写修改原因。','error');return;}
    const parsed=raw?IO.parseTable(raw).records:[];
    if(await mutate(source=>{
      requireManager();requirePin(pin);const tasks=allTasks(source).filter(task=>Object.hasOwn(form.__expected,task.id)),edits=new Map();if(tasks.length!==Object.keys(form.__expected).length)throw new Error('这次导入已变化或删除，请重新核对。');
      for(const task of tasks){if(task.mode!==activeMode)throw new Error('请切换回导入批次所属业务模块后再保存，草稿已保留。');assertFresh(task,form.__expected[task.id]);if(movie&&movie!==task.movie)edits.set(task.id,{id:task.id,before:{tid:task.tid,movie:task.movie},after:{tid:task.tid,movie}});}
      const correctionIds=new Set();for(const row of parsed){if(row.error||row.cells.length!==2)throw new Error(`第 ${row.line} 行需要原 TID 和新 TID 两列。`);const [before,after]=row.cells.map(value=>value.trim()),task=tasks.find(task=>task.tid.toUpperCase()===before.toUpperCase());if(!task)throw new Error(`原 TID ${before} 不属于这批导入。`);if(correctionIds.has(task.id))throw new Error('同一个原 TID 不能重复填写。');correctionIds.add(task.id);edits.set(task.id,{id:task.id,before:{tid:task.tid,movie:task.movie},after:{tid:after,movie:movie||task.movie}});}
      const changed=[...edits.values()].filter(edit=>JSON.stringify(edit.before)!==JSON.stringify(edit.after));if(!changed.length)throw new Error('内容没有变化。');validateEdits(source,changed);return{events:changed.map(edit=>newEvent(source,findTask(source,edit.id),'metadata_edit',{before:edit.before,after:edit.after,note,batchId:form.dataset.batchId}))};
    },'导入内容已修正，原作业记录完整保留。',{pin,form})){$('batchEditor').classList.add('hidden');$('batchEditor').innerHTML='';renderDispatch();}
  }
  function renderAcceptance() {
    const selected=new Map(checkedAcceptanceTasks().map(row=>[row.id,row.expected]));
    const rows=allTasks().filter(task=>task.status==='pending_acceptance'&&inCurrentScope(task,false)).sort((a,b)=>String(a.updatedAt).localeCompare(String(b.updatedAt)));
    $('acceptanceBody').innerHTML=rows.map(task=>`<tr><td><input type="checkbox" name="acceptanceTask" value="${escapeHtml(task.id)}" data-expected="${escapeHtml(selected.get(task.id)||task.updatedAt)}" ${selected.has(task.id)?'checked':''} aria-label="选择 ${escapeHtml(task.tid)}"></td><td>${tidMarkup(task)}</td><td>${escapeHtml(task.movie)}</td><td>${escapeHtml(groupLabel(task.groupId))}</td><td>${escapeHtml(task.assignee)}</td><td>${statusPill(task)}</td><td><button class="btn primary small" type="button" data-action="acceptance-review" data-task-id="${escapeHtml(task.id)}">查看 / 验收</button></td></tr>`).join('')||emptyRow(7,'当前范围没有待验收任务。质检通过后会直接流入这里。');
    setText('acceptanceQueueCount',rows.length);setText('acceptanceQueueScope',`${modeLabel(activeMode)} · ${selectedGroup()==='all'?'全部小组':groupLabel(selectedGroup())} · 全部日期`);
    if(selectedAcceptanceTaskId&&!rows.some(task=>task.id===selectedAcceptanceTaskId))selectedAcceptanceTaskId='';
    renderAcceptanceWorkbench(selectedAcceptanceTaskId);syncAcceptanceSelection();syncAcceptanceChoice();
  }
  function acceptanceScopeKey() {return JSON.stringify({identity:batchIdentityScope(),group:selectedGroup()});}
  function checkedAcceptanceTasks() {return qsa('input[name="acceptanceTask"]:checked',$('acceptanceBody')).map(input=>({id:input.value,expected:input.dataset.expected}));}
  function acceptanceSelectionKey(rows) {return JSON.stringify(rows.map(row=>row.id).sort());}
  function syncAcceptanceSelection() {
    const inputs=qsa('input[name="acceptanceTask"]',$('acceptanceBody')),selected=inputs.filter(input=>input.checked).length,all=$('acceptanceSelectAll');
    setText('acceptanceSelectionSummary',`已选 ${selected} / ${inputs.length} 条`);
    all.checked=!!inputs.length&&selected===inputs.length;all.indeterminate=selected>0&&selected<inputs.length;all.disabled=acceptanceBusy||!inputs.length;
    $('acceptanceSelectAllButton').disabled=acceptanceBusy||!inputs.length;
    ['acceptanceBulkPass','acceptanceBulkFail','acceptanceBulkReject'].forEach(id=>$(id).disabled=acceptanceBusy||!selected);
  }
  function rememberAcceptanceForm() {
    const form=$('acceptanceForm');if(!form)return;
    const decision=qs('input[name="decision"]:checked',form)?.value||'',note=form.elements.note.value;
    if(decision||note)acceptanceSingleDrafts.set(form.dataset.draftKey,{decision,note,expected:form.dataset.expected});
  }
  function renderAcceptanceWorkbench(id) {
    rememberAcceptanceForm();
    const target=$('acceptanceWorkbench');if(!id){target.innerHTML='<div class="empty"><strong>选择一条任务查看</strong><span>也可在左侧勾选多条，统一提交验收结果。</span></div>';return;}const task=findTask(state,id);
    if(task.status!=='pending_acceptance'||!inCurrentScope(task,false)){target.innerHTML='<div class="empty">该任务已处理或不在当前范围，请重新选择。</div>';return;}
    const draftKey=`${batchIdentityScope()}|${id}`,draft=acceptanceSingleDrafts.get(draftKey),stale=!!draft&&draft.expected!==task.updatedAt;
    target.innerHTML=`<div class="panel-heading"><div><h3>${escapeHtml(task.tid)}</h3><p>${escapeHtml(task.movie)} · ${escapeHtml(groupLabel(task.groupId))}</p></div>${statusPill(task)}</div><form id="acceptanceForm" class="workbench-form" data-task-id="${escapeHtml(id)}" data-draft-key="${escapeHtml(draftKey)}" data-scope="${escapeHtml(acceptanceScopeKey())}" data-expected="${escapeHtml(draft?.expected||task.updatedAt)}">${stale?`<div class="inline-result" role="status"><p>任务已有更新，原说明和选择已保留。请核对上方影片、小组与当前状态，再继续验收。</p><button type="button" class="btn small" data-action="reconfirm-acceptance-task" data-latest="${escapeHtml(task.updatedAt)}">已核对最新状态，继续验收</button></div>`:''}<div class="decision-options"><label><input type="radio" name="decision" value="acceptance_pass" required> 验收通过</label><label><input type="radio" name="decision" value="acceptance_fail" required> 不通过，退回质检</label><label><input type="radio" name="decision" value="acceptance_reject" required> 拒绝，结束流转</label></div><label class="field"><span>验收说明（不通过或拒绝时必填）</span><textarea name="note" maxlength="2000"></textarea><small>拒绝后不退回质检或标注，任务与历史记录仍保留。</small></label><button type="submit" class="btn primary" ${stale?'disabled':''}>保存验收结果</button></form>`;
    const form=$('acceptanceForm');if(draft){form.elements.note.value=draft.note;const choice=qsa('input[name="decision"]',form).find(input=>input.value===draft.decision);if(choice)choice.checked=true;dirtyForms.add(form);}syncAcceptanceSingleChoice();
  }
  function syncAcceptanceSingleChoice() {const form=$('acceptanceForm');if(form)form.elements.note.required=['acceptance_fail','acceptance_reject'].includes(qs('input[name="decision"]:checked',form)?.value);}
  function acceptanceTransition(task,type,note) {
    requireRole('acceptance',task);
    if(task.mode!==activeMode)throw new Error('此 TID 属于另一业务模块，请切换模块后处理。');
    if(!inCurrentScope(task,false))throw new Error('此 TID 不在当前小组范围，请重新选择。');
    if(!['acceptance_pass','acceptance_fail','acceptance_reject'].includes(type))throw new Error('请选择验收通过、不通过或拒绝。');
    if(task.status!=='pending_acceptance')throw new Error('当前任务不在待验收状态，或已有结果，不能覆盖状态。');
    if(type!=='acceptance_pass'&&!note)throw new Error(type==='acceptance_reject'?'验收拒绝需要填写原因。':'请填写不通过的原因，任务将退回质检。');
    if(type==='acceptance_fail'&&/^\[验收拒绝\]/.test(note))throw new Error('不通过说明不能以“[验收拒绝]”开头，请直接填写需要修改的问题。');
  }
  function acceptanceEvent(source,task,type,note,details={}) {
    acceptanceTransition(task,type,note);
    return newEvent(source,task,type==='acceptance_reject'?'acceptance_fail':type,{...details,note:type==='acceptance_reject'?`[验收拒绝] ${note}`:note,acceptanceRound:task.acceptanceRound,expectedUpdatedAt:task.updatedAt});
  }
  async function withAcceptanceSave(action) {
    if(acceptanceBusy)return false;acceptanceBusy=true;
    const controls=[...qsa('input,textarea,button',$('acceptanceView')),$('scopeGroup'),$('changeIdentity'),...qsa('[data-mode]')],disabled=controls.map(control=>control.disabled);
    controls.forEach(control=>control.disabled=true);syncAcceptanceSelection();syncAcceptanceChoice();
    try{return await action();}finally{controls.forEach((control,index)=>{if(control.isConnected)control.disabled=disabled[index];});acceptanceBusy=false;syncAcceptanceSelection();syncAcceptanceChoice();}
  }
  async function saveAcceptance(form) {
    if(acceptanceBusy)return;
    const decision=(form.querySelector('input[name="decision"]:checked')||form.querySelector('input[name="decision"][type="hidden"]'))?.value,note=form.elements.note.value.trim();if(!decision){showToast('请选择验收结果。','error');return;}
    const saved=await withAcceptanceSave(()=>mutate(source=>{if(form.dataset.scope!==acceptanceScopeKey())throw new Error('查看范围已变化，请回到原范围后提交，说明已保留。');const task=findTask(source,form.dataset.taskId);assertFresh(task,form.dataset.expected);return{events:[acceptanceEvent(source,task,decision,note)]};},decision==='acceptance_fail'?'已登记不通过，任务已退回质检。':decision==='acceptance_reject'?'已拒绝并结束流转，记录已保留。':'验收通过已保存。',{form}));
    if(saved){acceptanceSingleDrafts.delete(form.dataset.draftKey);form.remove();selectedAcceptanceTaskId='';renderAcceptance();}
    else if(form.isConnected&&refreshState()){
      const task=findTask(state,form.dataset.taskId);
      if(task.status==='pending_acceptance'&&inCurrentScope(task,false)&&task.updatedAt!==form.dataset.expected)renderAcceptanceWorkbench(task.id);
    }
  }
  async function reconfirmAcceptanceTask(button) {
    if(acceptanceBusy)return;
    const form=button.closest('form'),id=form.dataset.taskId,scope=form.dataset.scope,latest=button.dataset.latest;
    const confirmed=await withAcceptanceSave(async()=>{
      await refreshBatchSource();
      if(!form.isConnected||$('acceptanceForm')!==form||scope!==acceptanceScopeKey())throw new Error('当前任务或范围已变化，说明已保留，请重新打开核对。');
      const task=findTask(state,id);requireRole('acceptance',task);
      if(task.status!=='pending_acceptance'||!inCurrentScope(task,false))throw new Error('此任务已不在当前待验收范围，不能继续提交；原说明已保留。');
      if(task.updatedAt!==latest)return false;
      form.dataset.expected=task.updatedAt;rememberAcceptanceForm();return true;
    });
    renderAcceptanceWorkbench(id);
    showToast(confirmed?'已核对最新状态，说明和选择已保留，可继续保存。':'任务再次更新，请核对最新内容后再确认。',confirmed?'':'error');
  }
  function batchIdentityScope() {return JSON.stringify({profile,mode:activeMode});}
  async function refreshBatchSource() {if(typeof store.refresh==='function')await store.refresh();state=store.read();}
  function resolveTidRows(text,source) {
    const tasks=new Map(allTasks(source).map(task=>[task.tid.toUpperCase(),task]));
    return IO.parseTidRows(text).map(row=>{const task=tasks.get(row.tid.toUpperCase());return{...row,task,error:row.error||(!task?'尚未导入此 TID，请核对编号或先在任务导入中登记。':'')};});
  }
  function batchRoleError(task,role) {
    try {requireRole(role,task);if(task.mode!==(profile.mode||groupById(profile.groupId)?.defaultMode))throw new Error('此 TID 属于另一镜头类型，请使用对应作业身份。');return '';}catch(error){return error.message;}
  }
  function evaluateAcceptance(text,source) {
    return resolveTidRows(text,source).map(row=>{
      let error=row.error;
      if(!error)error=batchRoleError(row.task,'acceptance');
      if(!error&&!inCurrentScope(row.task,false))error='此 TID 不在当前小组范围，请调整查看小组后重新匹配。';
      if(!error&&row.task.status!=='pending_acceptance')error=`当前为“${window.WorkbenchFlow.label(row.task)}”，不可登记验收结果。`;
      return{...row,error,outcome:error?'failed':'success',taskId:row.task?.id,expected:row.task?.updatedAt};
    });
  }
  function invalidateAcceptancePreview() {
    acceptancePreviewTicket+=1;acceptanceDraft=null;
    $('acceptancePreviewBtn').disabled=false;
    $('acceptancePreview').textContent='只需 TID，校验后自动显示影片和当前状态。';
    setText('acceptanceImportFeedback','');syncAcceptanceChoice();
  }
  function acceptanceDraftCurrent() {return !!acceptanceDraft&&acceptanceDraft.text===$('acceptanceText').value&&acceptanceDraft.scope===acceptanceScopeKey();}
  function syncAcceptanceChoice() {
    const current=acceptanceDraftCurrent(),inputs=qsa('input[name="acceptanceImportTask"]'),selected=inputs.filter(input=>input.checked&&!input.disabled).length;
    const type=qs('input[name="acceptanceResult"]:checked')?.value||'',note=$('acceptanceChoiceNote').value.trim(),blocked=!!acceptanceDraft?.structureError;
    $('acceptanceChoiceNote').required=['acceptance_fail','acceptance_reject'].includes(type);
    $('acceptanceCommitBtn').disabled=acceptanceBusy||!current||blocked||!selected||!type||(type!=='acceptance_pass'&&!note);
    $('acceptanceCommitBtn').textContent=acceptanceBusy?'正在保存…':`保存所选 ${selected} 条`;
    setText('acceptanceChoiceSummary',current?`已选 ${selected} 条${blocked?' · 请先修正多列内容':''}`:'请先校验 TID');
    const selectAll=$('acceptanceImportSelectAll');if(selectAll){const enabled=inputs.filter(input=>!input.disabled);selectAll.disabled=acceptanceBusy||!enabled.length||blocked;selectAll.checked=!!enabled.length&&selected===enabled.length;selectAll.indeterminate=selected>0&&selected<enabled.length;}
  }
  function renderAcceptancePreview(selectedIds) {
    const draft=acceptanceDraft;if(!draft)return;
    const rows=draft.rows,eligible=rows.filter(row=>row.outcome==='success'),failed=rows.filter(row=>row.outcome==='failed').length,saved=rows.filter(row=>row.outcome==='saved').length;
    const selection=new Set(selectedIds||eligible.map(row=>row.taskId));
    $('acceptancePreview').innerHTML=`<div class="import-result"><strong>匹配 ${eligible.length} 条</strong><span>异常 ${failed} 条 · 已更新 ${saved} 条 · 共 ${rows.length} 条</span></div>${draft.structureError?'<p class="tid-input-error">检测到多列或分隔内容，本批不能提交。请只保留一列 TID，状态在下方选择。</p>':''}<div class="table-wrap tid-match-table"><table><thead><tr><th class="selection-cell"><input id="acceptanceImportSelectAll" type="checkbox" aria-label="全选匹配的待验收 TID"></th><th>TID</th><th>影片（自动匹配）</th><th>当前状态</th><th>校验结果</th></tr></thead><tbody>${rows.map(row=>`<tr class="${row.error?'tid-match-error':''}"><td>${row.outcome==='success'?`<input type="checkbox" name="acceptanceImportTask" value="${escapeHtml(row.taskId)}" ${selection.has(row.taskId)&&!draft.structureError?'checked':''} ${draft.structureError?'disabled':''} aria-label="选择 ${escapeHtml(row.tid)}">`:''}</td><td><span class="mono">${escapeHtml(row.tid||'空')}</span><small class="muted">第 ${row.line} 行</small></td><td>${escapeHtml(row.task?.movie||'未匹配')}</td><td>${row.task?statusPill(row.task):'—'}</td><td>${escapeHtml(row.error||(row.outcome==='saved'?row.savedLabel:'可更新'))}</td></tr>`).join('')}</tbody></table></div>`;
    syncAcceptanceChoice();
  }
  async function previewAcceptance() {
    if(acceptanceBusy)return;
    const ticket=++acceptancePreviewTicket,text=$('acceptanceText').value,scope=acceptanceScopeKey();
    acceptanceDraft=null;$('acceptancePreview').textContent='正在匹配 TID…';setText('acceptanceImportFeedback','');syncAcceptanceChoice();
    $('acceptancePreviewBtn').disabled=true;
    try {
      requireRole('acceptance');await refreshBatchSource();
      if(ticket!==acceptancePreviewTicket||text!==$('acceptanceText').value||scope!==acceptanceScopeKey())return;
      const rows=evaluateAcceptance(text,state);if(!rows.length)throw new Error('请粘贴本次 TID，每行一个。');
      acceptanceDraft={text,scope,rows,structureError:rows.some(row=>row.structureError)};setText('acceptanceImportFeedback','');renderAcceptancePreview();
    }catch(error){if(ticket===acceptancePreviewTicket){acceptanceDraft=null;$('acceptancePreview').textContent=error.message;showToast(error.message,'error');}}
    finally{if(ticket===acceptancePreviewTicket){$('acceptancePreviewBtn').disabled=false;syncAcceptanceChoice();}}
  }
  async function commitAcceptance() {
    if(acceptanceBusy)return;
    const draft=acceptanceDraft,scope=acceptanceScopeKey(),type=qs('input[name="acceptanceResult"]:checked')?.value,note=$('acceptanceChoiceNote').value.trim();
    if(!acceptanceDraftCurrent()||draft.structureError){showToast('请先校验当前 TID，修正多列内容后再选择状态。','error');return;}
    const ids=new Set(qsa('input[name="acceptanceImportTask"]:checked:not(:disabled)').map(input=>input.value)),selected=draft.rows.filter(row=>row.outcome==='success'&&ids.has(row.taskId));
    if(!selected.length||!['acceptance_pass','acceptance_fail','acceptance_reject'].includes(type)){showToast('请勾选匹配的 TID，并选择验收结果。','error');return;}
    if(type!=='acceptance_pass'&&!note){showToast('不通过或拒绝需要填写原因。','error');$('acceptanceChoiceNote').focus();return;}
    const form=$('acceptanceImportForm'),labels={acceptance_pass:'验收通过',acceptance_fail:'不通过，已退回质检',acceptance_reject:'已拒绝并结束流转'};
    const saved=await withAcceptanceSave(()=>mutate(source=>{
      requireRole('acceptance');if(scope!==acceptanceScopeKey()||draft!==acceptanceDraft||draft.text!==$('acceptanceText').value)throw new Error('作业身份、范围或输入已变化，请重新校验；草稿已保留。');
      return{events:selected.map(row=>{const task=findTask(source,row.taskId);assertFresh(task,row.expected);return acceptanceEvent(source,task,type,note,{source:'acceptance_import'});})};
    },`已更新 ${selected.length} 条：${labels[type]}。`,{form}));
    if(saved&&draft===acceptanceDraft){selected.forEach(row=>{row.outcome='saved';row.savedLabel=labels[type];row.task=findTask(state,row.taskId);});setText('acceptanceImportFeedback',`成功更新 ${selected.length} 条；其余 TID 可继续选择状态。`);renderAcceptancePreview([]);renderAcceptance();}
  }
  async function matchQcTids() {
    if(qcMatchBusy)return;const text=$('qcMatchTids').value,scope=batchIdentityScope();qcMatchBusy=true;$('qcMatchBtn').disabled=true;
    try {
      requireRole('qc');if($('qcBulkDecisionForm'))throw new Error('请先完成或取消当前批量打回，再选择另一批 TID。当前说明和勾选已保留。');await refreshBatchSource();if(text!==$('qcMatchTids').value||scope!==batchIdentityScope())throw new Error('输入或作业身份已变化，请重新校验。');if($('qcBulkDecisionForm'))throw new Error('请先完成或取消当前批量打回，再选择另一批 TID。当前说明和勾选已保留。');
      const rows=resolveTidRows(text,state).map(row=>{let error=row.error;if(!error)error=batchRoleError(row.task,'qc');if(!error&&!['pending_qc','pending_reqc'].includes(row.task.status))error=`当前为“${window.WorkbenchFlow.label(row.task)}”，不可登记质检结果。`;return{...row,error,outcome:error?'failed':'success'};});
      if(!rows.length)throw new Error('请先粘贴需要质检的 TID。');
      $('qcMatchResult').innerHTML=importReport(rows).replace('可导入','匹配');
      if(rows.some(row=>row.error)){showToast('存在异常 TID，本次没有改变勾选，请核对提示。','error');return;}
      $('qcTaskFilter').value='review';renderQcQueue(true);const ids=new Set(rows.map(row=>row.task.id));qsa('input[name="qcTask"]').forEach(input=>input.checked=ids.has(input.value));$('qcSelectAll').checked=qsa('input[name="qcTask"]').every(input=>input.checked);
      $('qcMatchResult').innerHTML=`<p class="tid-match-success">已勾选 ${rows.length} 条，影片已自动匹配。请在下方选择质检通过、打回或拒绝。</p>`;
      showToast(`已勾选 ${rows.length} 条质检任务。`);
    }catch(error){$('qcMatchResult').textContent=error.message;showToast(error.message,'error');}
    finally{qcMatchBusy=false;$('qcMatchBtn').disabled=false;}
  }

  const EVENT_LABELS={task_deleted:'删除本次导入',dispatch:'导入任务',claim:'认领',submit:'提交',qc_fail:'质检打回',qc_pass:'质检通过并流入验收',qc_reject:'质检拒绝并废弃',annotator_reject:'标注拒绝，待质检确认',reject_confirm:'质检确认标注拒绝',reject_return:'质检不同意拒绝，退回标注',sent_acceptance:'历史送验收记录',acceptance_pass:'验收通过',acceptance_fail:'验收不通过，退回质检',acceptance_reject:'验收拒绝并废弃',package_built:'登记已建包',package_claimed:'登记已领取包',acceptance_route:'分派验收返修',qc_repair_done:'质检自行修改完成并流入验收',metadata_edit:'修改任务资料'};
  function eventLabel(event) {return window.WorkbenchFlow.isReworkAssignment(event)?'分配代修':window.WorkbenchFlow.isQcReject(event)?'质检拒绝并废弃':window.WorkbenchFlow.isAcceptanceReject(event)?'验收拒绝并废弃':event.type==='group_daily_edit'?'修改每日小组人数与总量':EVENT_LABELS[event.type]||event.type;}
  function eventDetail(event) {
    if(event.type==='group_daily_edit')return `${event.date} · ${groupLabel(event.groupId)} · 负责人 ${event.after.leader} · 总量 ${event.after.total} · 人数 ${event.after.headcount===null?'自动识别':event.after.headcount} · ${event.note||''}`;
    if(window.WorkbenchFlow.isReworkAssignment(event))return `${event.fromAssignee} → ${event.assignee} · ${event.note||'请假代修'}`;
    const parts=[];if(event.round)parts.push(`第 ${event.round} 轮`);if(event.pLevel)parts.push(event.pLevel);if(event.tags?.length)parts.push(event.tags.join('、'));
    if(event.before&&event.after){if(event.before.tid!==event.after.tid)parts.push(`TID：${event.before.tid} → ${event.after.tid}`);if(event.before.movie!==event.after.movie)parts.push(`影片：${event.before.movie} → ${event.after.movie}`);}
    if(event.previousAssignee&&event.assignee&&event.previousAssignee!==event.assignee)parts.push(`接续演示身份：${event.previousAssignee} → ${event.assignee}`);
    if(event.packageName)parts.push(`建包批次：${event.packageName}`);if(event.stage)parts.push(event.stage==='qc'?'送质检':'送验收');if(event.packageRound)parts.push(`第 ${event.packageRound} 轮`);if(event.route)parts.push(event.route==='qc'?'质检自行修改':'标注修改后重新质检');
    if(event.note)parts.push(event.note);return parts.join(' · ')||'已记录';
  }
  let recordsGateOpen=false;
  function renderRecords() {
    const names=[...new Set(allTasks().filter(task=>inCurrentScope(task,false)).map(task=>task.movie))].sort(),movieOptions=names.map(movie=>({value:movie,label:movie}));
    if(recordWholeMovie){let value=`__whole_movie__:${encodeURIComponent(recordWholeMovie.title)}`;while(names.includes(value))value=`_${value}`;recordWholeMovie.value=value;movieOptions.push({value,label:`整片：${recordWholeMovie.title}`});}
    multiOptions('recordMovie',movieOptions);
    const dateMode=$('recordDateMode').value;$('recordDateFrom').disabled=dateMode!=='range';$('recordDateTo').disabled=dateMode!=='range';
    let base=[];try{base=recordBaseTasks();}catch(error){setText('recordSummary',error.message);$('recordBody').innerHTML=emptyRow(11,error.message);$('recordStatusBoard').innerHTML='';return;}
    const c=counts(base),statusList=multiGet('recordStatus'),round=$('recordQcRound').value;
    const gateActive=recordsGateOpen||statusList.length>0||multiGet('recordMovie').length>0||round!=='all'||$('recordSearch').value.trim().length>0;
    const rows=base.filter(task=>matchesStatusList(task,statusList)&&matchesQcRound(task,round)).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
    setText('recordSummary',`${modeLabel(activeMode)} · 筛选范围 ${new Set(base.map(task=>window.WorkbenchReports.movieTitle(task))).size} 部影片 / ${base.length} 条 TID · ${gateActive?`当前显示 ${rows.length} 条。${statusList.length>1?`已选 ${statusList.length} 个状态。` : ''}`:'为避免卡顿，默认不展开全部任务：请先选择影片 / 包或点击状态标签，再列出明细。'}状态均为最新状态。`);
    const single=statusList.length===1?statusList[0]:'',bucketKey=single.startsWith('overview_')?single.slice(9):'',bucket=bucketKey?OVERVIEW_BUCKETS[bucketKey]:null;
    const bucketChip=bucket?`<button type="button" class="status-count active" data-action="record-state" data-status="${escapeHtml(single)}">${escapeHtml(bucket.label)} <strong>${base.filter(task=>matchesOverviewBucket(task,bucketKey)).length}</strong></button>`:'';
    $('recordStatusBoard').innerHTML=bucketChip+`<button type="button" class="status-count ${statusList.length===0?'active':''}" data-action="record-state" data-status="all">全部 <strong>${base.length}</strong></button>`+Object.entries(STATUS_META).filter(([key])=>key!=='annotating'&&key!=='qc_pack_unclaimed').map(([key,meta])=>`<button type="button" class="status-count ${single===key?'active':''}" data-action="record-state" data-status="${key}" data-tone="${overviewStateTone(key)}">${escapeHtml(meta.label)} <strong>${key==='unclaimed'?c.annotation:c[key]}</strong></button>`).join('')+`<button type="button" class="status-count" data-action="record-state" data-status="pending_reqc" data-round="2">其中：待二次质检 <strong>${c.qcSecond}</strong></button><button type="button" class="status-count" data-action="record-state" data-status="pending_reqc" data-round="3plus">其中：待三次及以上质检 <strong>${c.qcThirdPlus}</strong></button>`;
    if(gateActive)renderRowsBatched($('recordBody'),rows.map(task=>{const qc=firstEvent(task.id,event=>['qc_pass','qc_fail','qc_reject'].includes(event.type)),operator=window.WorkbenchReports.qcOperator(eventsForTask(task.id)),operatorHint=operator.name?`${eventLabel({type:operator.type})} · ${formatDateTime(operator.at)}`:'尚无质检操作记录';return `<tr><td>${tidMarkup(task)}</td><td>${escapeHtml(task.movie)}</td><td>${groupLabel(task.groupId)}</td><td>${modePill(task.mode)}</td><td>${escapeHtml(task.assignee||'未认领')}</td><td class="records-qc-operator" title="${escapeHtml(operatorHint)}">${escapeHtml(operator.name||'暂无')}</td><td>质检 ${task.qcRound} / 验收 ${task.acceptanceRound}</td><td>${statusPill(task)}</td><td>${qc?(qc.type==='qc_pass'?'通过':window.WorkbenchFlow.isQcReject(qc)?'拒绝':escapeHtml(qc.pLevel||'打回')):'暂无'}</td><td>${formatDateTime(task.updatedAt)}</td><td><div class="row-actions"><button type="button" class="btn ghost small" data-action="timeline" data-task-id="${escapeHtml(task.id)}">查看</button><button type="button" class="btn ghost small" data-action="edit-task" data-task-id="${escapeHtml(task.id)}">修改 TID</button></div></td></tr>`;}),11,'当前筛选没有任务。');else $('recordBody').innerHTML=emptyRow(11,'为避免卡顿，默认不展开全部任务：请先在上方选择影片 / 包、点击状态标签，或输入搜索、质检轮次后再列出。');renderTimeline(selectedTimelineTaskId);
  }
  function renderTimeline(id) {
    if(!id){$('timelinePanel').innerHTML='<div class="empty"><strong>选择任务查看完整流水</strong><span>保留历次提交、质检、拒绝确认、验收和资料修改。</span></div>';return;}
    const raw=state.tasks.find(task=>task.id===id);
    if(!raw||!canViewGroup(raw.groupId)||taskSnapshot(raw).deleted){selectedTimelineTaskId='';$('timelinePanel').innerHTML='<div class="empty"><strong>当前身份无法查看该任务</strong><span>普通作业身份只能查看所属小组的数据。</span></div>';return;}
    const task=findTask(state,id),events=eventsForTask(id).slice().reverse();
    const ownership=task.assignmentId?`<p>初标：${escapeHtml(window.WorkbenchReports.annotationContributors(eventsForTask(id)).initial?.name||'暂无提交')} · 当前处理：${escapeHtml(task.assignee)}</p>`:'';
    const conflicts=new Map((task.legacyConflicts||[]).map(item=>[item.eventId,item.reason]));
    $('timelinePanel').innerHTML=`<div class="panel-heading"><div><h3>${tidMarkup(task)}</h3><p>${escapeHtml(task.movie)} · ${groupLabel(task.groupId)} · ${escapeHtml(task.assignee||'未认领')}</p>${ownership}</div>${statusPill(task)}</div><ol class="timeline">${events.map(event=>`<li class="timeline-item${conflicts.has(event.id)?' timeline-conflict':''}"><div class="timeline-title">${escapeHtml(eventLabel(event))}${conflicts.has(event.id)?' <span class="tag">未计入进度</span>':''}</div><div class="timeline-meta">${formatDateTime(event.at)} · ${escapeHtml(event.actor||'演示系统')}</div><div class="timeline-note">${escapeHtml(eventDetail(event))}</div>${conflicts.has(event.id)?`<div class="timeline-conflict-reason">${escapeHtml(conflicts.get(event.id))} 原记录已保留。</div>`:''}</li>`).join('')}</ol>`;
  }
  function showTaskEditor(id) {
    const task=findTask(state,id),target=$('taskEditor');target.classList.remove('hidden');
    target.innerHTML=`<div class="panel-heading"><div><h3>修改 TID</h3><p>影片包：${escapeHtml(task.movie)}。仅修正编号，保留认领人、状态和全部流水。</p></div></div><form id="taskEditForm" class="workbench-form" data-task-id="${escapeHtml(id)}" data-expected="${escapeHtml(task.updatedAt)}"><label class="field"><span>原 TID</span><input value="${escapeHtml(task.tid)}" readonly></label><label class="field"><span>新 TID</span><input name="tid" value="${escapeHtml(task.tid)}" required maxlength="128"></label><label class="field"><span>修改原因</span><input name="note" required maxlength="2000"></label><label class="field"><span>修改 PIN</span><input name="pin" type="password" required inputmode="numeric" autocomplete="off"></label><div class="row-actions"><button type="submit" class="btn primary">验证 PIN 并保存</button><button type="button" class="btn ghost" data-action="close-task-editor">取消</button></div></form>`;target.querySelector('input[name="tid"]').focus();target.scrollIntoView({block:'nearest'});
  }
  async function saveTaskEdit(form) {
    const tid=form.elements.tid.value.trim(),pin=form.elements.pin.value,note=form.elements.note.value.trim();if(!note){showToast('请填写修改原因。','error');return;}
    if(await mutate(source=>{requireManager();requirePin(pin);const task=findTask(source,form.dataset.taskId);if(task.mode!==activeMode)throw new Error('请切换回任务所属业务模块后再保存，草稿已保留。');assertFresh(task,form.dataset.expected);if(tid===task.tid)throw new Error('TID 没有变化。');const edit={id:task.id,before:{tid:task.tid,movie:task.movie},after:{tid,movie:task.movie}};validateEdits(source,[edit]);return{events:[newEvent(source,task,'metadata_edit',{before:edit.before,after:edit.after,note})]};},'TID 已修正，完整历史记录已保留。',{pin,form})){$('taskEditor').classList.add('hidden');$('taskEditor').innerHTML='';selectedTimelineTaskId=form.dataset.taskId;renderRecords();}
  }
  function reassignSearchValue() { return String($('reassignSearchInput')?.value || '').trim(); }
  function renderReassignNames() {
    const list=$('reassignNameList');if(!list)return;
    const names=new Set(),ids=new Set();
    for(const task of allTasks()){if(task.deleted||task.mode!==activeMode)continue;ids.add(task.id);if(task.assignee)names.add(task.assignee);}
    for(const event of state.events)if(ids.has(event.taskId)&&event.actor&&event.actor!=='admin')names.add(event.actor);
    list.innerHTML=[...names].sort((a,b)=>a.localeCompare(b,'zh')).slice(0,300).map(name=>`<option value="${escapeHtml(name)}"></option>`).join('');
  }
  function hideReassignForm() {
    const form=$('reassignForm');if(!form)return;form.classList.add('hidden');form.reset();form.dataset.taskId='';form.dataset.expected='';setText('reassignTarget','');
  }
  function renderReassignResults() {
    const target=$('reassignResults');if(!target)return;
    const needle=reassignSearchValue().toUpperCase();
    if(!needle){target.innerHTML='<span>输入 TID 后搜索，最多显示 20 条。</span>';hideReassignForm();return;}
    const rows=allTasks().filter(task=>!task.deleted&&task.mode===activeMode&&String(task.tid).toUpperCase().includes(needle)).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,20);
    if(!rows.length){target.innerHTML=`<span>${escapeHtml(modeLabel(activeMode))}模块没有匹配的 TID，请确认单镜头 / 多镜头是否切换正确。</span>`;hideReassignForm();return;}
    target.innerHTML=`<ul>${rows.map(task=>`<li><button type="button" class="btn ghost small" data-action="reassign-pick" data-task-id="${escapeHtml(task.id)}"><span class="mono">${escapeHtml(task.tid)}</span> · ${escapeHtml(task.movie)} · ${escapeHtml(groupLabel(task.groupId))} · ${escapeHtml(task.assignee||'未认领')} · ${escapeHtml(STATUS_META[task.status]?.label||task.status)}</button></li>`).join('')}</ul>`;
  }
  function pickReassignTask(id) {
    if(!refreshState())return;
    const task=findTask(state,id),form=$('reassignForm');if(!task||!form)return;
    form.classList.remove('hidden');form.dataset.taskId=id;form.dataset.expected=task.updatedAt||'';
    form.querySelector('select[name="toRole"]').value=['pending_qc','pending_reqc','qc_self_rework','pending_acceptance','rejection_pending','accepted','rejected'].includes(task.status)?'qc':'annotation';
    setText('reassignTarget',`即将改派：${task.tid} · ${task.movie} · ${groupLabel(task.groupId)} · 当前处理人 ${task.assignee||'未认领'} · 当前状态 ${STATUS_META[task.status]?.label||task.status}`);
    form.querySelector('input[name="assignee"]').focus();form.scrollIntoView({behavior:'smooth',block:'center'});
  }
  async function saveReassign(form) {
    const assignee=form.elements.assignee.value.trim(),pin=form.elements.pin.value,toRole=form.elements.toRole.value,note=form.elements.note.value.trim(),taskId=form.dataset.taskId;
    if(!assignee){showToast('请填写新处理人姓名。','error');return;}
    if(await mutate(source=>{
      requireManager();requirePin(pin);
      const task=findTask(source,taskId);
      if(!task)throw new Error('未找到这条任务，请重新搜索。');
      if(task.mode!==activeMode)throw new Error('请切换回任务所属业务模块后再改派，填写内容已保留。');
      assertFresh(task,form.dataset.expected);
      if(assignee===task.assignee&&toRole==='annotation')throw new Error('新处理人与当前处理人相同。');
      return{events:[newEvent(source,task,'admin_reassign',{assignee,toRole,note})]};
    },toRole==='qc'?`已改派给 ${assignee}，状态变为待质检。`:`已改派给 ${assignee}，状态回到待标注。`,{pin,form})){hideReassignForm();renderReassignResults();}
  }
  function bindReassignEvents() {
    if(!$('reassignSearchForm'))return;
    $('reassignSearchForm').addEventListener('submit',event=>{event.preventDefault();if(!refreshState())return;renderReassignNames();renderReassignResults();});
    $('reassignSearchInput').addEventListener('input',()=>{if(refreshState())renderReassignResults();});
    $('reassignCancel').addEventListener('click',hideReassignForm);
    document.addEventListener('click',event=>{const button=event.target.closest('[data-action="reassign-pick"]');if(!button)return;try{pickReassignTask(button.dataset.taskId);}catch(error){showToast(error.message,'error');}});
  }
  function syncReassignModule() {
    if(!$('reassignModeLabel'))return;
    try{setText('reassignModeLabel',modeLabel(activeMode));$('reassignSearchInput').value='';renderReassignNames();renderReassignResults();}catch(error){}
  }
  function download(name,content,type) {const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  async function exportData(kind,range='all') {
    try {
      const rangeKey=scopeRangeKey(),groupId=selectedGroup(),mode=activeMode;
      if(range==='scope'&&!validScopeRange())throw new Error('请修正日期区间后再导出。');
      if(kind==='backup'){if(profile?.role!=='admin')throw new Error('完整备份仅管理员可下载。普通作业身份只能查看和导出所属范围的数据。');const backup=await store.backup();if(backup.state)backup.latestTasks=backup.state.tasks.map(task=>({...task,...window.WorkbenchFlow.project(task,backup.state.events)}));download(`作业流程完整备份-单多全部-${todayString()}.json`,JSON.stringify(backup,null,2),'application/json;charset=utf-8');showToast('完整备份已下载，包含单、多镜头全部原始数据和最新任务状态。');return;}
      await store.refresh();if(!refreshState())return;const reports=scopedReports();let report=reports[kind];
      if(range==='scope'&&(rangeKey!==scopeRangeKey()||groupId!==selectedGroup()||mode!==activeMode))throw new Error('日期或小组范围已变化，请按当前范围重新导出。');
      if(kind==='summary'){const columns=new Map([...reports.groups.columns,...reports.movies.columns].map(column=>[column.key,column]));report={columns:[{key:'scope',label:'汇总层级'},...columns.values()],rows:[...reports.groups.rows.map(row=>({...row,scope:'小组'})),...reports.movies.rows.map(row=>({...row,scope:'影片'}))]};}
      if(!report)throw new Error('未找到此导出类型。');
      if(range==='scope')report={...report,rows:report.rows.filter(row=>inDateRange(String(row.date)))};
      const names={imports:'导入记录',tasks:'任务明细',events:'操作流水',packages:'建包记录',movies:'影片汇总',groups:'小组汇总',daily:'每日统计',personDaily:'个人每日明细',summary:'小组影片综合汇总'},dateLabel=range==='scope'?scopeRangeLabel():'全部日期';
      download(`${modeLabel(activeMode)}-${names[kind]}-${dateLabel}-${todayString()}.csv`,IO.csv(report.columns,report.rows),'text/csv;charset=utf-8');showToast(range==='scope'?`已导出当前范围的${names[kind]}，共 ${report.rows.length} 条。`:`已导出${modeLabel(activeMode)}全部日期的${names[kind]}，不受当前日期筛选限制。`);
    }catch(error){showToast(error.message||'导出失败。','error');}
  }
  function summaryExportRow(level,date,group,movie,c) {
    const row={汇总层级:level,业务日期:date,小组:group,影片包:movie,任务总数:c.total};
    Object.entries(STATUS_META).filter(([key])=>key!=='annotating').forEach(([key,meta])=>row[meta.label]=key==='unclaimed'?c.annotation:c[key]);
    return{...row,其中待二次质检:c.qcSecond,其中待三次及以上质检:c.qcThirdPlus,验收通过率:c.total?`${(c.accepted/c.total*100).toFixed(1)}%`:'0%',闭环率:c.total?`${((c.accepted+c.rejected)/c.total*100).toFixed(1)}%`:'0%'};
  }
  async function copyTid(tid) {
    try {await navigator.clipboard.writeText(tid);showToast('TID 已复制。');}
    catch {const area=document.createElement('textarea');area.value=tid;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();const copied=document.execCommand('copy');area.remove();showToast(copied?'TID 已复制。':'复制失败，请选中 TID 手动复制。',copied?'':'error');}
  }
  function initializeWorkflowControls() {
    options($('myTaskFilter'),[{value:'actionable',label:'待我处理'},{value:'all',label:'全部状态'},...Object.entries(STATUS_META).filter(([key])=>key!=='annotating').map(([value,meta])=>({value,label:meta.label}))],'actionable');
    options($('qcTaskFilter'),[{value:'all',label:'全部待办'},{value:'review',label:'待质检'},{value:'return',label:'返修处理'},{value:'rejection_pending',label:'拒绝待确认'}],'all');
  }

  function eventSequence(source,task,definitions) {
    const start=Math.max(Date.now(),...eventsForTask(task.id,source).map(event=>(Date.parse(event.at)||0)+1));
    return definitions.map(([type,details],index)=>newEvent(source,task,type,{...details,at:new Date(start+index).toISOString()}));
  }

  function annotationCompletion(source,task) {
    requireRole('annotation',task);if(!annotationStatuses.includes(task.status))throw new Error('当前任务已提交完成或不在可标注状态');
    if(task.status==='unclaimed')throw new Error('请先通过“认领 TID”登记到本人名下，再提交完成');
    if(!ownsTask(task))throw new Error('已由其他人员认领，不能覆盖');
    const round=task.round+1,definitions=[];
    definitions.push(['submit',{round,assignee:profile.name,previousAssignee:task.assignee,submissionKind:round===1?'initial':'rework',note:round===1?'标注完成，实时进入质检':'返修完成，实时进入第 '+(task.qcRound+1)+' 次质检'}]);
    return eventSequence(source,task,definitions);
  }

  function requestedTasks(text,checkboxName,source,selection) {
    if(text.trim())return resolveTidRows(text,source);
    const tasks=allTasks(source);return (selection||qsa(`input[name="${checkboxName}"]:checked`).map(input=>input.value)).map((id,index)=>{const task=tasks.find(task=>task.id===id);return{line:index+1,tid:task?.tid||'',task,error:task?'':'任务已变化，请重新选择。'};});
  }
  function batchInputSnapshot(textId,checkboxName) {return{text:$(textId).value,scope:batchIdentityScope(),selection:qsa(`input[name="${checkboxName}"]:checked`).map(input=>input.value).sort()};}
  function assertBatchInput(snapshot,textId,checkboxName) {const current=batchInputSnapshot(textId,checkboxName);if(snapshot.scope!==current.scope||snapshot.text!==current.text||!snapshot.text.trim()&&JSON.stringify(snapshot.selection)!==JSON.stringify(current.selection))throw new Error('输入、勾选或作业身份已变化，本批未提交，请核对后重试。');}

  async function completeAnnotationBulk() {
    const snapshot=batchInputSnapshot('annotationBulkTids','annotationTask');
    let report=[];
    const saved=await mutate(source=>{requireRole('annotation');assertBatchInput(snapshot,'annotationBulkTids','annotationTask');report=requestedTasks(snapshot.text,'annotationTask',source,snapshot.selection);if(!report.length)throw new Error('请先勾选任务或粘贴 TID。');const events=[];
      report.forEach(row=>{try{if(row.error)throw new Error(row.error);events.push(...annotationCompletion(source,row.task));row.outcome='success';}catch(error){row.error=error.message;row.outcome='failed';}});
      if(report.some(row=>row.error)){report=report.map(row=>({...row,outcome:'failed',error:row.error||'本批未提交，请先修正异常 TID。'}));throw new Error('TID 存在异常，整批尚未提交，请核对明细。');}if(!events.length)throw new Error('没有可登记的任务，请查看失败原因。');return{events};
    },'已提交完成，实时进入质检队列。');if(saved){renderMyTasks();renderTaskSearch();}else report=report.map(row=>({...row,outcome:'failed',error:row.error||'本次未确认保存成功，请刷新状态后核对并重试。'}));
    if(report.length)$('annotationBulkResult').innerHTML=importReport(report,true).replace('成功','成功提交');
  }

  function packageRows(source=state) {return source.batches.filter(batch=>batch.kind==='handoff');}

  function selectedPackageRequests(source) { return requestedTasks($('packageTids').value,'qcTask',source); }

  async function buildPackages(claim) {
    const snapshot=batchInputSnapshot('packageTids','qcTask');
    const form=$('packageForm'),stage=form.elements.stage.value,packageName=form.elements.packageName.value.trim();let report=[],built=0;
    if(await mutate(source=>{requireRole('qc');assertBatchInput(snapshot,'packageTids','qcTask');if(stage!=='qc')throw new Error('当前只需要登记质检包；质检通过后会自动流入验收台。');if(stage!==form.elements.stage.value||packageName!==form.elements.packageName.value.trim())throw new Error('建包去向或编号已变化，本批未提交，请核对后重试。');const rows=requestedTasks(snapshot.text,'qcTask',source,snapshot.selection);if(!rows.length)throw new Error('请勾选待建质检包任务或粘贴本次实际建包的 TID。');
      const valid=[];report=rows.map(row=>{let error=row.error;if(!error&&row.task.mode!==activeMode)error='不能混入另一业务模块';if(!error&&row.task.groupId!==profile.groupId)error='不能为其他小组建包';if(!error&&!window.WorkbenchFlow.canBuild(row.task,stage))error=`当前为“${window.WorkbenchFlow.label(row.task)}”，不能重复建包或越过检查`;if(!error)valid.push(row.task);return{...row,outcome:error?'failed':'success',error};});
      if(report.some(row=>row.error))throw new Error('建包内容存在不匹配项，整批尚未保存，请核对明细。');
      const grouped=new Map();valid.forEach(task=>{const key=JSON.stringify([task.movie,task.groupId]);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(task);});
      if(packageName&&grouped.size>1)throw new Error('填写具体通航包名或编号时，请一次只登记一个影片；未填写时可按影片自动分批。');
      const batches=[],events=[];for(const tasks of grouped.values()){
        const first=tasks[0],id=uid('package'),name=packageName||`${first.movie} · ${stage==='qc'?'质检':'验收'} · ${new Date().toLocaleTimeString('zh-CN')}`;
        batches.push({id,kind:'handoff',stage,mode:first.mode,movie:first.movie,groupId:first.groupId,date:first.date,packageName:name,taskIds:tasks.map(task=>task.id),tids:tasks.map(task=>task.tid),createdAt:new Date().toISOString(),createdBy:profile.name});
        tasks.forEach(task=>{const packageRound=(stage==='qc'?task.qcRound:task.acceptanceRound)+1,details={stage,packageId:id,packageName:name,packageRound,builder:profile.name};const definitions=[['package_built',details]];if(claim)definitions.push(['package_claimed',{...details,claimer:profile.name}]);events.push(...eventSequence(source,task,definitions));});
      }built=batches.length;return{batches,events};
    },'建包记录已保存。')){$('packageResult').innerHTML=`<div class="import-result"><strong>已登记 ${built} 个批次，共 ${report.length} 条 TID</strong><span>${claim?'建包与领取均已记录':'仅记录建包，等待原建包人领取'}</span></div>`;if(snapshot.text===$('packageTids').value&&snapshot.scope===batchIdentityScope())$('packageTids').value='';renderQcQueue();}
    else if(report.length)$('packageResult').innerHTML=importReport(report.map(row=>({...row,outcome:'failed',error:row.error||'本批未保存，请先处理其他不匹配项'})));
  }

  async function claimPackage(id) {
    if(await mutate(source=>{requireRole('qc');const batch=packageRows(source).find(batch=>batch.id===id);if(!batch)throw new Error('建包批次不存在。');if(batch.createdBy!==profile.name||batch.groupId!==profile.groupId)throw new Error('请由本批次的原建包人领取。');
      const events=batch.taskIds.map(taskId=>{const task=findTask(source,taskId),stage=batch.stage,prefix=stage==='qc'?'qc':'acceptance';if(task.status!==`${prefix}_pack_unclaimed`||task[`${prefix}PackageId`]!==id)throw new Error('本批次已有任务被处理，不能重复领取或覆盖。');return newEvent(source,task,'package_claimed',{stage,packageId:id,packageName:batch.packageName,packageRound:task[`${prefix}PackageRound`],claimer:profile.name,builder:batch.createdBy});});return{events};
    },'领取已登记，任务进入检查队列。'))renderQcQueue();
  }

  function renderPackages() {
    const rows=packageRows().filter(batch=>batch.groupId===profile.groupId&&(batch.mode||groupById(batch.groupId)?.defaultMode)===activeMode).slice().reverse();
    $('packageBody').innerHTML=rows.map(batch=>{const claims=state.events.filter(event=>event.type==='package_claimed'&&event.packageId===batch.id),claimed=new Set(claims.map(event=>event.taskId)),complete=claimed.size===batch.taskIds.length;return `<tr><td>${escapeHtml(batch.packageName)}<small class="muted mono">${escapeHtml(batch.id.slice(-8))}</small></td><td>${escapeHtml(batch.movie)}</td><td>${batch.stage==='qc'?'送质检':'送验收'}</td><td>${batch.taskIds.length}</td><td>${escapeHtml(batch.createdBy)}</td><td>${escapeHtml([...new Set(claims.map(event=>event.actor))].join('、')||'未领取')}</td><td>${complete?'已建包并领取':'已建包待领取'}</td><td>${!complete?`<button class="btn primary small" type="button" data-action="claim-package" data-package-id="${escapeHtml(batch.id)}">登记已领取</button>`:'<span class="muted">已记录</span>'}</td></tr>`;}).join('')||emptyRow(8,'尚无建包记录。只登记已在通航实际完成的动作。');
  }

  function qcReviewFields(bulk=false) {
    return `${bulk?'<input type="hidden" name="decision" value="fail">':'<div class="decision-options"><label><input type="radio" name="decision" value="pass" required> 质检通过，直接流入验收</label><label><input type="radio" name="decision" value="fail" required> 打回标注返修</label><label><input type="radio" name="decision" value="reject" required> 质检拒绝，直接废弃</label></div>'}<div ${bulk?'':'id="qcFailFields"'} class="${bulk?'':'hidden'}"><label class="field"><span>最高错误等级</span><select name="pLevel"><option value="">请选择</option><option>P0</option><option>P1</option><option>P2</option></select></label><fieldset><legend>错误标签（可多选）</legend>${QC_TAGS.map(tag=>`<label><input type="checkbox" name="tags" value="${escapeHtml(tag)}"> ${escapeHtml(tag)}</label>`).join('')}</fieldset></div><label class="field"><span>处理说明（打回或拒绝时必填）</span><textarea name="note" maxlength="2000"></textarea></label>`;
  }

  function qcDecisionEvent(source,task,decision,note,pLevel,tags) {
    requireRole('qc',task);let type,details={note};
    if(['reject_confirm','reject_return'].includes(decision)){if(task.status!=='rejection_pending')throw new Error('此任务不在拒绝待确认状态。');if(!note)throw new Error('请填写质检确认说明。');type=decision;if(decision==='reject_return')details.resumeStatus=task.rejectionResumeStatus||'annotating';}
    else if(['acceptance_route_qc','acceptance_route_annotation'].includes(decision)){if(task.status!=='acceptance_return_pending')throw new Error('此任务不在待选择验收返修去向的状态。');if(!note)throw new Error('请填写返修处理说明。');type='acceptance_route';details.route=decision==='acceptance_route_qc'?'qc':'annotation';}
    else if(decision==='qc_repair_done'){if(task.status!=='qc_self_rework')throw new Error('此任务不在质检自行返修状态。');if(!note)throw new Error('请填写修改说明。');type=decision;}
    else {if(!['pass','fail','reject'].includes(decision))throw new Error('请选择处理结果。');if(!['pending_qc','pending_reqc'].includes(task.status))throw new Error('只有已领取且待质检的任务才能记录质检结果。');if(decision==='fail'&&(!['P0','P1','P2'].includes(pLevel)||!tags?.length||!note))throw new Error('打回需要填写错误等级、至少一个标签和问题说明。');if(decision==='reject'&&!note)throw new Error('质检拒绝需要填写拒绝原因。');type=decision==='pass'?'qc_pass':'qc_fail';details={note:decision==='reject'?`[质检拒绝] ${note}`:note,round:task.qcRound,qcRound:task.qcRound,...(decision==='fail'?{pLevel,tags}:decision==='reject'?{pLevel:'P0',tags:['其他']}:{})};}
    return newEvent(source,task,type,details);
  }

  function checkedTasks(name) {return qsa(`input[name="${name}"]:checked`).map(input=>({id:input.value,expected:input.dataset.expected}));}

  async function passQcBulk() {
    if(qcBulkReturnBusy)return;
    if($('qcBulkDecisionForm')){showToast('请先保存或取消当前批量打回，已填写说明和勾选保留。','error');return;}
    const selected=checkedTasks('qcTask');if(!selected.length){showToast('请先勾选待质检任务。','error');return;}
    if(await mutate(source=>({events:selected.map(row=>{const task=findTask(source,row.id);assertFresh(task,row.expected);return qcDecisionEvent(source,task,'pass','批量质检通过，直接流入验收');})}),`已通过 ${selected.length} 条，并直接流入验收台。`))renderQcQueue();
  }

  function showBulkQcFail() {
    if(qcBulkReturnBusy)return;
    if($('qcBulkDecisionForm')||$('qcBulkRejectForm')){showToast('请先保存或取消当前批量处理，已填写说明和勾选保留。','error');return;}
    try{
      const selected=checkedTasks('qcTask');if(!selected.length)throw new Error('请先勾选待质检或验收退回的任务，本批未保存。');
      if(!refreshState())return;
      const tasks=qcBulkReturnTasks(state,selected),qc=tasks.filter(task=>task.status!=='acceptance_return_pending').length,acceptance=tasks.length-qc,target=$('qcBulkWorkbench');
      const fields=qc?qcReviewFields(true):'<label class="field"><span>处理说明（适用于全部勾选任务）</span><textarea name="note" required maxlength="2000"></textarea></label>';
      target.innerHTML=`<form id="qcBulkDecisionForm" class="workbench-form" data-scope="${escapeHtml(batchIdentityScope())}"><h3>批量转交标注返修 ${selected.length} 条</h3><p>普通待质检 ${qc} 条 · 验收退回 ${acceptance} 条。同一处理说明适用于全部勾选任务。${qc?'错误等级和标签仅用于普通待质检任务。':'验收退回直接转交标注，无需重新填写质检错误等级。'}</p>${fields}<p id="qcBulkReturnError" class="text-danger" role="alert"></p><div class="row-actions"><button type="submit" class="btn primary">确认转交标注返修</button><button type="button" class="btn ghost" data-action="cancel-bulk-qc">取消</button></div></form>`;
      const form=target.firstElementChild;form.__selected=selected;form.__counts={qc,acceptance};form.elements.note.required=true;if(qc)form.elements.pLevel.required=true;dirtyForms.add(form);target.scrollIntoView({block:'nearest'});
    }catch(error){showToast(error.message,'error');}
  }

  function qcBulkReturnTasks(source,selected) {
    return selected.map(row=>{
      let task;
      try{task=findTask(source,row.id);requireRole('qc',task);assertFresh(task,row.expected);if(!['pending_qc','pending_reqc','acceptance_return_pending'].includes(task.status))throw new Error(`当前为“${window.WorkbenchFlow.label(task)}”，不能批量转交标注返修。`);return task;}
      catch(error){const tid=task?.tid||source.tasks.find(item=>item.id===row.id)?.tid||row.id;throw new Error(`${tid}：${error.message} 本批均未保存，说明和勾选已保留。`);}
    });
  }
  function assertQcBulkReturnSelection(form) {
    requireRole('qc');
    const selectionKey=rows=>JSON.stringify(rows.map(row=>row.id).sort());
    if($('qcBulkDecisionForm')!==form||form.dataset.scope!==batchIdentityScope()||selectionKey(form.__selected)!==selectionKey(checkedTasks('qcTask')))throw new Error('作业身份、模块或勾选任务已变化，本批未保存。请恢复原选择或取消后重新选择，说明已保留。');
  }
  async function withQcBulkReturnSave(form,action) {
    if(qcBulkReturnBusy)return false;qcBulkReturnBusy=true;form.dataset.saving='true';
    const controls=[...qsa('input,select,textarea,button',$('qcView')),$('scopeGroup'),$('scopeDateFrom'),$('scopeDateTo'),$('changeIdentity'),...qsa('[data-mode],[data-date-preset],nav [data-view]')],disabled=controls.map(control=>control.disabled);
    controls.forEach(control=>control.disabled=true);
    try{return await action();}finally{controls.forEach((control,index)=>{if(control.isConnected)control.disabled=disabled[index];});qcBulkReturnBusy=false;delete form.dataset.saving;}
  }
  async function saveBulkQcFail(form) {
    if(qcBulkReturnBusy)return;
    try{assertQcBulkReturnSelection(form);}catch(error){setText('qcBulkReturnError',error.message);showToast(error.message,'error');return;}
    const note=form.elements.note.value.trim(),pLevel=form.elements.pLevel?.value,tags=qsa('input[name="tags"]:checked',form).map(input=>input.value);
    setText('qcBulkReturnError','');
    const counts=form.__counts,message=`已转交标注返修 ${form.__selected.length} 条（普通质检打回 ${counts.qc} 条，验收退回转交 ${counts.acceptance} 条）。`;
    if(await withQcBulkReturnSave(form,()=>mutate(source=>{
      assertQcBulkReturnSelection(form);const tasks=qcBulkReturnTasks(source,form.__selected);
      return{events:tasks.map(task=>{try{if(task.status!=='acceptance_return_pending'&&/^\[质检拒绝\]/.test(note))throw new Error('“[质检拒绝]”是拒绝专用标记，不能用于转交标注，请直接填写返修问题。');return{...qcDecisionEvent(source,task,task.status==='acceptance_return_pending'?'acceptance_route_annotation':'fail',note,pLevel,tags),expectedUpdatedAt:task.updatedAt};}catch(error){throw new Error(`${task.tid}：${error.message} 本批均未保存，说明和勾选已保留。`);}})};
    },message,{form,errorTarget:'qcBulkReturnError'}))){$('qcBulkWorkbench').innerHTML='';renderQcQueue();}
  }

  function showBulkQcReject() {
    if(qcBulkReturnBusy)return;
    if($('qcBulkDecisionForm')){showToast('请先保存或取消当前批量打回，已填写说明和勾选保留。','error');return;}
    const selected=checkedTasks('qcTask');if(!selected.length){showToast('请先勾选待质检任务。','error');return;}
    const target=$('qcBulkWorkbench');target.innerHTML=`<form id="qcBulkRejectForm" class="workbench-form"><h3>批量质检拒绝 ${selected.length} 条</h3><p>拒绝后任务直接废弃，不进入验收，也不计为质检打回。</p><label class="field"><span>拒绝原因（适用于全部勾选任务）</span><textarea name="note" required maxlength="2000"></textarea></label><div class="row-actions"><button type="submit" class="btn danger">确认拒绝并废弃</button><button type="button" class="btn ghost" data-action="cancel-bulk-qc">取消</button></div></form>`;target.firstElementChild.__selected=selected;target.scrollIntoView({block:'nearest'});
  }

  async function saveBulkQcReject(form) {
    const note=form.elements.note.value.trim();if(!note){showToast('请填写质检拒绝原因。','error');return;}
    if(await mutate(source=>({events:form.__selected.map(row=>{const task=findTask(source,row.id);assertFresh(task,row.expected);return qcDecisionEvent(source,task,'reject',note);})}),`已质检拒绝 ${form.__selected.length} 条，任务已废弃且不会进入验收。`)){$('qcBulkWorkbench').innerHTML='';renderQcQueue();}
  }

  async function passAcceptanceBulk() {
    if(acceptanceBusy)return;
    if($('acceptanceBulkDecisionForm')){showToast('请先保存或取消当前批量处理，已填写的说明保留。','error');return;}
    const selected=checkedAcceptanceTasks(),scope=acceptanceScopeKey();if(!selected.length){showToast('请先勾选待验收任务。','error');return;}
    if(await withAcceptanceSave(()=>mutate(source=>{if(scope!==acceptanceScopeKey()||acceptanceSelectionKey(selected)!==acceptanceSelectionKey(checkedAcceptanceTasks()))throw new Error('当前范围或勾选已变化，请重新核对任务。');return{events:selected.map(row=>{const task=findTask(source,row.id);assertFresh(task,row.expected);return acceptanceEvent(source,task,'acceptance_pass','批量验收通过');})};},`已登记 ${selected.length} 条验收通过。`)))renderAcceptance();
  }

  function showBulkAcceptanceDecision(type) {
    if(acceptanceBusy)return;
    if($('acceptanceBulkDecisionForm')){showToast('请先保存或取消当前批量处理，已填写的说明保留。','error');return;}
    const selected=checkedAcceptanceTasks();if(!selected.length){showToast('请先勾选待验收任务。','error');return;}
    const reject=type==='acceptance_reject',target=$('acceptanceBulkWorkbench');
    target.innerHTML=`<form id="acceptanceBulkDecisionForm" class="workbench-form" data-decision="${type}" data-scope="${escapeHtml(acceptanceScopeKey())}"><h3>${reject?'拒绝并结束流转':'不通过，退回质检'} · ${selected.length} 条</h3><p>${reject?'拒绝后不退回质检或标注，任务与历史记录仍保留。':'任务退回质检处理；质检可自行修改，或交给标注返修。'}</p><label class="field"><span>${reject?'拒绝原因':'不通过的原因'}（适用于全部勾选任务）</span><textarea name="note" required maxlength="2000"></textarea></label><div class="row-actions"><button type="submit" class="btn ${reject?'danger':'primary'}">${reject?'确认拒绝并结束流转':'确认退回质检'}</button><button type="button" class="btn ghost" data-action="cancel-bulk-acceptance">取消</button></div></form>`;
    target.firstElementChild.__selected=selected;dirtyForms.add(target.firstElementChild);target.scrollIntoView({block:'nearest'});
  }

  async function saveBulkAcceptanceFail(form) {
    if(acceptanceBusy)return;
    if(form.dataset.scope!==acceptanceScopeKey()||acceptanceSelectionKey(form.__selected)!==acceptanceSelectionKey(checkedAcceptanceTasks())){showToast('范围或勾选任务已变化，请恢复原选择，或取消本次处理后重新选择。说明已保留。','error');return;}
    const note=form.elements.note.value.trim(),type=form.dataset.decision;if(!note){showToast('请填写不通过或拒绝的原因。','error');return;}
    if(await withAcceptanceSave(()=>mutate(source=>{if(form.dataset.scope!==acceptanceScopeKey()||acceptanceSelectionKey(form.__selected)!==acceptanceSelectionKey(checkedAcceptanceTasks()))throw new Error('范围或勾选已变化，说明已保留，请重新核对。');return{events:form.__selected.map(row=>{const task=findTask(source,row.id);assertFresh(task,row.expected);return acceptanceEvent(source,task,type,note);})};},type==='acceptance_reject'?`已拒绝 ${form.__selected.length} 条并结束流转，记录已保留。`:`已将 ${form.__selected.length} 条不通过任务退回质检。`,{form}))){$('acceptanceBulkWorkbench').innerHTML='';renderAcceptance();}
  }

  async function exportPackages() {
    try {
    await store.refresh();if(!refreshState())return;const tasks=allTasks(),visibleIds=new Set(tasks.map(task=>task.id)),rows=packageRows().filter(batch=>canViewGroup(batch.groupId)&&(batch.mode||groupById(batch.groupId)?.defaultMode)===activeMode).map(batch=>{const taskIds=(batch.taskIds||[]).filter(id=>visibleIds.has(id)),events=state.events.filter(event=>taskIds.includes(event.taskId)&&event.packageId===batch.id),claims=events.filter(event=>event.type==='package_claimed');return{建包记录ID:batch.id,通航包名或编号:batch.packageName,当时影片包:batch.movie,当前影片包:[...new Set(tasks.filter(task=>taskIds.includes(task.id)).map(task=>task.movie))].join('、'),小组:groupLabel(batch.groupId),去向:batch.stage==='qc'?'质检':'验收',任务数:taskIds.length,当时TID:JSON.stringify((batch.tids||[]).filter((tid,index)=>visibleIds.has((batch.taskIds||[])[index]))),当前TID:JSON.stringify(tasks.filter(task=>taskIds.includes(task.id)).map(task=>task.tid)),建包人:batch.createdBy,建包时间:batch.createdAt,领取人:[...new Set(claims.map(event=>event.actor))].join('、'),领取条数:new Set(claims.map(event=>event.taskId)).size,完整建包JSON:JSON.stringify({...batch,taskIds}),完整流水JSON:JSON.stringify(events)};});
    download(`全部建包记录-${todayString()}.csv`,IO.csv(Object.keys(rows[0]||{建包记录ID:'',通航包名或编号:''}),rows),'text/csv;charset=utf-8');showToast(`已导出全部 ${rows.length} 个建包批次。`);
    } catch(error) {showToast(error.message||'导出失败，请恢复连接后重试。','error');}
  }

  function bindBulkEvents() {
    $('annotationBulkForm').addEventListener('submit',event=>event.preventDefault());
    $('annotationBulkComplete').addEventListener('click',completeAnnotationBulk);
    $('qcBulkPass').addEventListener('click',passQcBulk);$('qcBulkFail').addEventListener('click',showBulkQcFail);$('qcBulkReject').addEventListener('click',showBulkQcReject);$('qcTaskFilter').addEventListener('change',()=>{refreshState();renderQcQueue();});
    $('reworkAssignmentSelectAll').addEventListener('change',event=>{qsa('input[name="reworkAssignmentTask"]').forEach(input=>{const task=findTask(state,input.value);input.checked=event.target.checked&&['rework','acceptance_rework'].includes(task.status);if(input.checked){input.dataset.expected=task.updatedAt;input.dataset.assignee=task.assignee;}});syncReworkAssignmentSelection();$('reworkAssignmentResult').textContent='';});
    $('reworkAssignmentBody').addEventListener('change',event=>{const input=event.target.closest('input[name="reworkAssignmentTask"]');if(input?.checked){const task=findTask(state,input.value);if(!['rework','acceptance_rework'].includes(task.status)){input.checked=false;showToast('该任务已不在待标注返修状态，请重新核对。','error');}else{input.dataset.expected=task.updatedAt;input.dataset.assignee=task.assignee;}}syncReworkAssignmentSelection();$('reworkAssignmentResult').textContent='';});
    $('reworkAssignmentForm').addEventListener('input',()=>{$('reworkAssignmentResult').textContent='';});
    $('acceptanceBulkPass').addEventListener('click',passAcceptanceBulk);$('acceptanceBulkFail').addEventListener('click',()=>showBulkAcceptanceDecision('acceptance_fail'));$('acceptanceBulkReject').addEventListener('click',()=>showBulkAcceptanceDecision('acceptance_reject'));
    $('acceptanceSelectAllButton').addEventListener('click',()=>{if(acceptanceBusy)return;const inputs=qsa('input[name="acceptanceTask"]',$('acceptanceBody'));inputs.forEach(input=>input.checked=true);syncAcceptanceSelection();});
    $('acceptanceSelectAll').addEventListener('change',event=>{if(acceptanceBusy)return;qsa('input[name="acceptanceTask"]',$('acceptanceBody')).forEach(input=>input.checked=event.target.checked);syncAcceptanceSelection();});
    $('acceptanceBody').addEventListener('change',syncAcceptanceSelection);
    [['annotationSelectAll','annotationTask'],['qcSelectAll','qcTask']].forEach(([id,name])=>$(id).addEventListener('change',event=>qsa(`input[name="${name}"]`).forEach(input=>input.checked=event.target.checked)));
    $('recordQcRound').addEventListener('change',()=>{refreshState();renderRecords();});
    document.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;const action=button.dataset.action;
      // New QC flow has no package build or claim action; historical package
      // records remain read-only in exports and old timelines.
      if(action==='cancel-bulk-qc'&&!qcBulkReturnBusy)$('qcBulkWorkbench').innerHTML='';if(action==='cancel-bulk-acceptance'&&!acceptanceBusy)$('acceptanceBulkWorkbench').innerHTML='';
      if(action==='state-details'){if(button.dataset.groupId)$('scopeGroup').value=button.dataset.groupId;$('recordDateMode').value='all';$('recordSearch').value='';multiSet('recordMovie',[]);$('recordQcRound').value=button.dataset.round||'all';multiSet('recordStatus',[button.dataset.status]);activateView('records');}
    });
  }

  function selectedMode() { return activeMode; }

  function applyModule(mode,render=true) {
    const previousMode=activeMode,fixedMode=profile&&!canViewAllGroups()?groupById(profile.groupId)?.defaultMode:'',nextMode=fixedMode||(mode==='multi'?'multi':'single');
    const dispatchForm=$('dispatchForm');
    if(previousMode!==nextMode){
      batchEditorTicket+=1;
      $('batchDetail').replaceChildren();$('batchDetail').classList.add('hidden');
      if($('batchDeleteForm')){$('batchEditor').replaceChildren();$('batchEditor').classList.add('hidden');}
      dispatchModuleDrafts.set(previousMode,{date:dispatchForm.elements.date.value,groupId:dispatchForm.elements.group.value,movie:dispatchForm.elements.movie.value,text:dispatchForm.elements.tids.value});
      const draft=dispatchModuleDrafts.get(nextMode);dispatchForm.elements.date.value=draft?.date??todayString();dispatchForm.elements.movie.value=draft?.movie||'';dispatchForm.elements.tids.value=draft?.text||'';
      dispatchDraft=null;$('dispatchCommitBtn').disabled=true;$('dispatchPreview').textContent='预览后将显示可导入、重复及失败的条数与原因。';
      recordWholeMovie=null;multiSet('recordMovie',[]);recordsGateOpen=false;
      for(const id of ['taskEditor','batchEditor','groupDailyEditor']){
        const editor=$(id);moduleEditorDrafts.set(id+':'+previousMode,{nodes:Array.from(editor.childNodes),hidden:editor.classList.contains('hidden')});
        const draft=moduleEditorDrafts.get(id+':'+nextMode);editor.replaceChildren(...(draft?.nodes||[]));editor.classList.toggle('hidden',!draft||draft.hidden);
      }
    }
    activeMode=nextMode;const groups=GROUPS.filter(group=>group.defaultMode===activeMode),prior=$('scopeGroup').value;
    configureScopeGroup(groups.some(group=>group.id===prior)?prior:'all');
    const form=$('dispatchForm'),savedGroup=previousMode!==nextMode?dispatchModuleDrafts.get(nextMode)?.groupId:form.elements.group.value;options(form.elements.group,groups.map(group=>({value:group.id,label:group.name})),groups.some(group=>group.id===savedGroup)?savedGroup:groups.some(group=>group.id===profile?.groupId)?profile.groupId:groups[0].id);form.elements.mode.value=activeMode;setText('dispatchModeLabel',modeLabel(activeMode));
    qsa('[data-mode]').forEach(button=>{button.classList.toggle('active',button.dataset.mode===activeMode);button.setAttribute('aria-pressed',String(button.dataset.mode===activeMode));});setText('currentModeLabel',modeLabel(activeMode));
    selectedQcTaskId='';selectedAcceptanceTaskId='';selectedTimelineTaskId='';if($('recordQcRound'))$('recordQcRound').value='all';
    syncAcceptanceChoice();syncReassignModule();
    if(render&&refreshState())renderCurrentView();
  }

  function scopedReports() {
    const groupId=selectedGroup(),withinScope=task=>task.mode===activeMode&&(groupId==='all'||task.groupId===groupId)&&canViewGroup(task.groupId);
    const tasks=allTasks().filter(withinScope).map(task=>({...task,statusLabel:window.WorkbenchFlow.label(task)}));
    const auditTasks=allTaskHistory().filter(withinScope),groups=GROUPS.filter(group=>group.defaultMode===activeMode&&(groupId==='all'||group.id===groupId)&&canViewGroup(group.id));
    return window.WorkbenchReports.build({state,tasks,auditTasks,groups,mode:activeMode,statusMeta:STATUS_META,groupLabel,eventLabel,eventDetail,localDate:value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':localDateString(date);}});
  }

  function renderTodayMetrics(rows) {
    const ids=['metricTodayAnnotation','metricTodayQcPass','metricTodayAccept','metricTodayRework','metricTodayQcPending','metricTodayReworkPending','metricTodayAnnotators','metricTodayQcUsers','metricRejected'],hints=['metricTodayAnnotationHint','metricTodayQcPassHint','metricTodayAcceptHint','metricTodayReworkHint','metricTodayQcPendingHint','metricTodayReworkPendingHint','metricTodayAnnotatorsHint','metricTodayQcUsersHint','metricRejectedHint'];
    if(!rows){ids.forEach(id=>setText(id,'—'));hints.forEach(id=>setText(id,'请修正日期区间'));return;}
    const sum=(...keys)=>rows.reduce((total,row)=>total+keys.reduce((value,key)=>value+Number(row[key]||0),0),0);
    const dayWord=singleScopeDate()?'当日':'区间',pending=pendingReworkSplit();
    setText('metricTodayAnnotation',sum('initialAnnotationTIDs'));
    setText('metricTodayQcPass',sum('qcPassActions'));
    setText('metricTodayAccept',sum('completedTIDs'));
    setText('metricTodayRework',countRangeReworkTasks());
    setText('metricTodayQcPending',pending.qcPending);
    setText('metricTodayReworkPending',pending.reworkPending);
    setText('metricTodayAnnotators',countDayActors(['submit']));
    setText('metricTodayQcUsers',countDayActors(['qc_pass','qc_fail']));
    setText('metricRejected',countRangeRejected());
    setText('metricTodayAnnotationHint',`${dayWord}首次标完（条）· 不含返修`);
    setText('metricTodayQcPassHint',`${dayWord}质检通过（次）· 已闭环`);
    setText('metricTodayAcceptHint',`${dayWord}首次验收通过（条）`);
    setText('metricTodayReworkHint',`${dayWord}返修任务（条）· 一个 case 一次`);
    setText('metricTodayQcPendingHint',`${dayWord}首交待质检（条）`);
    setText('metricTodayReworkPendingHint',`${dayWord}打回待返修（条）`);
    setText('metricTodayAnnotatorsHint',`${dayWord}有标注提交（人）· 含返修`);
    setText('metricTodayQcUsersHint',`${dayWord}有质检判定（人）· 通过/打回`);
    setText('metricRejectedHint',`${dayWord}最终拒绝（条）· 按拒绝日期`);
  }

  function countDayActors(types) {
    const groupId=selectedGroup(),set=new Set();
    for(const task of allTasks()){
      if(task.mode!==activeMode)continue;
      if(groupId!=='all'&&task.groupId!==groupId)continue;
      for(const event of eventsForTask(task.id)){
        if(!types.includes(event.type))continue;
        if(!inDateRange(localDateString(new Date(event.at))))continue;
        const who=String(event.actor||'').trim();
        if(who)set.add(who);
      }
    }
    return set.size;
  }

  /* 未闭环拆分：所选日期内首交的任务，按当前最后一条质检判定分流 —— 待质检（还没质检）/ 待返修（最后被打回） */
  function pendingReworkSplit() {
    const groupId=selectedGroup();
    let qcPending=0,reworkPending=0;
    for(const task of allTasks()){
      if(task.mode!==activeMode)continue;
      if(groupId!=='all'&&task.groupId!==groupId)continue;
      const events=eventsForTask(task.id).slice().sort((a,b)=>String(a.at).localeCompare(String(b.at)));
      const first=events.find(event=>event.type==='submit');
      if(!first||!inDateRange(localDateString(new Date(first.at))))continue;
      let last=null;
      for(const event of events)if(event.type==='qc_pass'||event.type==='qc_fail')last=event.type;
      if(last==='qc_pass')continue;
      if(last==='qc_fail')reworkPending+=1;else qcPending+=1;
    }
    return {qcPending,reworkPending};
  }
  /* 返修量：所选日期内有过返修提交的任务去重条数 —— 一个 case 多次返修只算一条（区别于「返修提交（次）」） */
  function countRangeReworkTasks() {
    const groupId=selectedGroup(),set=new Set();
    for(const task of allTasks()){
      if(task.mode!==activeMode)continue;
      if(groupId!=='all'&&task.groupId!==groupId)continue;
      const events=eventsForTask(task.id).slice().sort((a,b)=>String(a.at).localeCompare(String(b.at)));
      let seen=false;
      for(const event of events){
        if(event.type!=='submit')continue;
        const isRework=seen||(event.submissionKind&&event.submissionKind!=='initial');
        seen=true;
        if(isRework&&inDateRange(localDateString(new Date(event.at)))){set.add(task.id);break;}
      }
    }
    return set.size;
  }
  function countRangeRejected() {
    const groupId=selectedGroup(),set=new Set();
    for(const task of allTasks()){
      if(task.mode!==activeMode)continue;
      if(groupId!=='all'&&task.groupId!==groupId)continue;
      for(const event of eventsForTask(task.id)){
        const finalReject=window.WorkbenchFlow.isQcReject(event)||window.WorkbenchFlow.isAcceptanceReject(event)||event.type==='reject_confirm';
        if(finalReject&&inDateRange(localDateString(new Date(event.at)))){set.add(task.id);break;}
      }
    }
    return set.size;
  }
  function renderDailyReport() {
    if(!validScopeRange()){$('overviewDailySummary').innerHTML=`<span>请修正日期区间</span>${['metricDailyNew','metricDailyAnnotation','metricDailyQc','metricDailyAccepted'].map(id=>`<strong id="${id}">—</strong>`).join('')}`;$('dailyStatsBody').innerHTML=emptyRow($('dailyStatsBody').closest('table').querySelectorAll('th').length,'请修正日期区间');renderTodayMetrics(null);return;}
    const labels={date:'日期',importedTIDs:'新增 TID',initialAnnotationTIDs:'首次标完（条）',annotationReworkActions:'标注返修（次）',qcPassActions:'质检通过（次）',qcFailActions:'质检打回（次）',qcRejectedTIDs:'质检拒绝（条）',completedTIDs:'首次验收通过（条）',annotationCompletedTIDs:'实际完成（条）',initialSubmissionTIDs:'首次完成（条）',reworkSubmissionActions:'返修提交（次）',personDayEfficiency:'人均日效率（条/人/天）',efficiencyIssue:'效率核对',acceptanceRejectedTIDs:'验收拒绝（条）',rejectedTIDs:'最终拒绝（条）',acceptanceFailActions:'验收不通过（次）',qcSelfRepairActions:'质检自行返修（次）',qcPackageCount:'建质检包（个）',acceptancePackageCount:'历史验收包（个）',activeTIDs:'有操作 TID',total:'登记总量',autoHeadcount:'自动人数',headcount:'采用人数',headcountSource:'人数口径'};
    const report=scopedReports().daily,rows=report.rows.filter(row=>inDateRange(String(row.date))&&(selectedGroup()==='all'||row.groupId===selectedGroup())),columns=report.columns.filter(column=>!['groupId','mode','latestEditId','isAggregate','initialSubmissionTIDs','reworkSubmissionActions','efficiencyIssue','efficiencyIssueDatesJSON'].includes(column.key)&&!/JSON|TID明细|任务编号/.test(column.label)).map(column=>({...column,title:column.label,label:labels[column.key]||column.label}));
    const sum=(...keys)=>rows.reduce((total,row)=>total+keys.reduce((value,key)=>value+Number(row[key]||0),0),0);
    renderTodayMetrics(rows);
    $('overviewDailySummary').innerHTML=`<span class="daily-summary-date">${escapeHtml(scopeRangeLabel())} · 作业记录</span><span>${singleScopeDate()?'当日':'区间'}新增分配 <strong id="metricDailyNew">${sum('importedTIDs')}</strong> 条</span><span>标注提交 <strong id="metricDailyAnnotation">${sum('initialAnnotationTIDs','annotationReworkActions')}</strong> 次</span><span>质检处理 <strong id="metricDailyQc">${sum('qcPassActions','qcFailActions','qcRejectedTIDs')}</strong> 次</span><span>验收通过 <strong id="metricDailyAccepted">${sum('completedTIDs')}</strong> 条</span><span>最终拒绝 <strong>${sum('rejectedTIDs')}</strong> 条</span>`;
    const body=$('dailyStatsBody');body.closest('table').querySelector('thead').innerHTML=`<tr>${columns.map(column=>`<th title="${escapeHtml(column.title)}">${escapeHtml(column.label)}</th>`).join('')}</tr>`;
    const value=(row,key)=>key==='personDayEfficiency'?efficiencyText(row):key==='efficiencyIssue'?(row.efficiencyIssue==='completed_without_headcount'?'人数待核对':row.efficiencyIssue==='no_person_days'?'暂无在班人数':'—'):key==='headcountSource'?(row.headcountSource==='manual'?'手动调整':'自动识别'):key==='total'&&row.total===null?'未填写':row[key]??'—';
    body.innerHTML=rows.map(row=>`<tr>${columns.map(column=>`<td>${escapeHtml(value(row,column.key))}</td>`).join('')}</tr>`).join('')||emptyRow(columns.length,'当前日期区间与小组没有作业记录。');
  }

  function recordBaseTasks() {
    const query=$('recordSearch').value.trim().toUpperCase(),movies=multiGet('recordMovie'),dateMode=$('recordDateMode').value,from=$('recordDateFrom').value,to=$('recordDateTo').value;
    if(dateMode==='range'&&from&&to&&from>to)throw new Error('分配开始日期不能晚于结束日期。');
    if(dateMode==='scope'&&!validScopeRange())throw new Error('请修正上方日期区间：开始日期不能晚于结束日期。');
    return allTasks().filter(task=>inCurrentScope(task,false)&&(!movies.length||movies.some(movie=>recordWholeMovie&&movie===recordWholeMovie.value?window.WorkbenchReports.movieTitle(task)===recordWholeMovie.title:task.movie===movie))&&(dateMode==='all'||dateMode==='scope'&&inDateRange(task.date)||dateMode==='range'&&inDateRange(task.date,{dateFrom:from,dateTo:to}))&&(!query||[task.tid,task.movie,task.assignee,window.WorkbenchReports.qcOperator(eventsForTask(task.id)).name,...eventsForTask(task.id).filter(event=>event.type==='metadata_edit').map(event=>event.before?.tid||'')].some(value=>String(value).toUpperCase().includes(query))));
  }

  function bindModuleEvents() {
    qsa('[data-mode]').forEach(button=>button.addEventListener('click',()=>applyModule(button.dataset.mode)));
    ['recordDateFrom','recordDateTo'].forEach(id=>$(id).addEventListener('change',()=>{refreshState();renderRecords();}));
    document.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;
      if(button.dataset.action==='record-state'){recordsGateOpen=true;multiSet('recordStatus',[button.dataset.status]);$('recordQcRound').value=button.dataset.round||'all';refreshState();renderRecords();}
      if(['group-details','movie-details'].includes(button.dataset.action)){$('scopeGroup').value=button.dataset.groupId||'all';$('recordDateMode').value='all';$('recordSearch').value='';multiSet('recordStatus',[]);$('recordQcRound').value='all';multiSet('recordMovie',[]);activateView('records');if(button.dataset.movie){multiSet('recordMovie',[button.dataset.movie]);renderRecords();}}
    });
  }

  function bindOverviewEvents() {
    $('personDailyDetails').addEventListener('toggle',()=>{if($('personDailyDetails').open)renderPersonDaily();});
    $('errorAnalysisDetails').addEventListener('toggle',()=>{if($('errorAnalysisDetails').open)renderErrorAnalysis(allTasks().filter(task=>inCurrentScope(task,false)));});
    ['errorScope','errorLevel'].forEach(id=>$(id).addEventListener('change',()=>renderErrorAnalysis(allTasks().filter(task=>inCurrentScope(task,false)))));
    $('movieProgressSearch').addEventListener('input',()=>{if(refreshState())renderMovieProgress();});
    $('movieProgressFilter').addEventListener('change',()=>{if(refreshState())renderMovieProgress(true);});
    document.addEventListener('click',event=>{
      const movie=event.target.closest('[data-action="movie-progress-details"]');
      if(movie){openWholeMovie(movie.dataset.movie,movie.dataset.status||'all');return;}
      const chip=event.target.closest('[data-action="error-person"]');
      if(chip){const details=$('errorAnalysisDetails');details.open=true;$('errorScope').value='person:'+chip.dataset.key;renderErrorAnalysis(allTasks().filter(task=>inCurrentScope(task,false)));if(!$('overviewPanel-people').classList.contains('hidden'))requestAnimationFrame(()=>details.scrollIntoView({behavior:'smooth',block:'center'}));return;}
      const tab=event.target.closest('[data-overview-tab]');
      if(tab){selectOverviewTab(tab.dataset.overviewTab);return;}
      const button=event.target.closest('[data-action="overview-bucket"]');
      if(button)openOverviewBucket(button.dataset.bucket,button.dataset.groupId);
    });
    qsa('[role="tab"][data-overview-tab]').forEach(button=>button.addEventListener('keydown',event=>{
      const tabs=['groups','movies','daily','people'],index=tabs.indexOf(button.dataset.overviewTab);
      const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;
      if(next>=0){event.preventDefault();selectOverviewTab(tabs[next],true);}
    }));
  }

  function bindEvents() {
    ['input','change'].forEach(type=>$('batchEditor').addEventListener(type,()=>{batchEditorTicket+=1;}));
    $('batchRecordFilter').addEventListener('change',()=>{if(refreshState())renderDispatch();});
    $('identityForm').addEventListener('submit',event=>{event.preventDefault();const next={name:$('identityName').value.trim(),mode:$('identityMode').value,groupId:$('identityGroup').value,role:$('identityRole').value};if(!validWorkerProfile(next)){showToast('请填写1至20个中文汉字姓名，并选择对应小组和角色。','error');return;}saveIdentity(next,$('identityRolePin').value);});
    $('identityAdminForm').addEventListener('submit',event=>{event.preventDefault();saveIdentity({name:$('identityAdminName').value.trim(),role:'admin'},$('identityAdminPin').value);});
    $('identityRole').addEventListener('change',syncIdentityRole);
    $('sharedRefreshBtn').addEventListener('click',()=>syncShared(true));
    ['input','change'].forEach(type=>document.addEventListener(type,event=>{const form=event.target.closest('form');if(form&&!form.closest('#identityGate'))dirtyForms.add(form);}));
    store.subscribe(detail=>{if(detail.kind==='sync'&&detail.changed)sharedHasUpdates=true;});
    setInterval(()=>{if(!document.hidden)syncShared();},8000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncShared();});
    $('workerEntry').addEventListener('click',()=>selectIdentityEntry('worker'));
    $('adminEntry').addEventListener('click',()=>selectIdentityEntry('admin'));
    $('changeIdentity').addEventListener('click',showIdentity);
    $('identityMode').addEventListener('change',()=>populateIdentityGroups($('identityMode').value));
    $('identityGroup').addEventListener('change',populateLegacyIdentity);
    qsa('nav [data-view]').forEach(button=>button.addEventListener('click',()=>activateView(button.dataset.view)));
    ['scopeDateFrom','scopeDateTo','scopeGroup'].forEach(id=>$(id).addEventListener('change',()=>{syncScopeControls();if(refreshState())renderCurrentView();}));
    qsa('[data-date-preset]').forEach(button=>button.addEventListener('click',()=>{const range=presetRange(button.dataset.datePreset);$('scopeDateFrom').value=range.dateFrom;$('scopeDateTo').value=range.dateTo;syncScopeControls();if(refreshState())renderCurrentView();}));
    $('taskSearchForm').addEventListener('submit',event=>{event.preventDefault();registerAnnotationTid();});$('taskSearchInput').addEventListener('input',renderTaskSearch);
    $('myTaskFilter').addEventListener('change',()=>{refreshState();renderMyTasks();});
    $('recordDateMode').addEventListener('change',()=>{refreshState();renderRecords();});$('recordSearch').addEventListener('input',renderRecords);
    ['recordMovie','recordStatus'].forEach(id=>{const box=$(id);if(!box)return;box.addEventListener('click',event=>{event.stopPropagation();toggleMultiSelect(id);});box.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();toggleMultiSelect(id);}});});
    document.addEventListener('click',event=>{
      /* 选项列表会被重建，被点节点可能已脱离 DOM，此时不要当成「点击外部」误关面板 */
      const target=event.target;
      if(target&&target.nodeType===1&&!target.isConnected)return;
      if(!target.closest('.multi-select')&&!target.closest('#multiSelectLayer'))closeMultiSelect();
    });
    window.addEventListener('resize',closeMultiSelect);
    /* 滚动时不再直接关闭（避免误关），改为跟随锚点重新定位；锚点滚出视口才关闭 */
    window.addEventListener('scroll',()=>{
      const layer=$('multiSelectLayer');
      if(!layer||layer.classList.contains('hidden'))return;
      const box=$(layer.dataset.owner||'');
      if(!box){closeMultiSelect();return;}
      const rect=box.getBoundingClientRect();
      if(rect.bottom<0||rect.top>window.innerHeight){closeMultiSelect();return;}
      const panel=layer.querySelector('.multi-select-panel');
      if(panel)panel.style.top=`${Math.round(rect.bottom+6)}px`;
    },true);
    $('dispatchForm').addEventListener('submit',event=>event.preventDefault());$('dispatchForm').addEventListener('input',()=>{dispatchDraft=null;$('dispatchCommitBtn').disabled=true;$('dispatchPreview').textContent='内容已更改，请重新预览确认影片和 TID。';});
    $('dispatchPreviewBtn').addEventListener('click',previewDispatch);$('dispatchCommitBtn').addEventListener('click',commitDispatch);
    $('acceptanceText').addEventListener('input',invalidateAcceptancePreview);
    $('acceptanceImportForm').addEventListener('submit',event=>event.preventDefault());
    $('acceptanceChoice').addEventListener('change',syncAcceptanceChoice);$('acceptanceChoiceNote').addEventListener('input',syncAcceptanceChoice);
    $('acceptancePreview').addEventListener('change',event=>{if(event.target.id==='acceptanceImportSelectAll')qsa('input[name="acceptanceImportTask"]:not(:disabled)').forEach(input=>input.checked=event.target.checked);syncAcceptanceChoice();});
    $('qcMatchForm').addEventListener('submit',event=>{event.preventDefault();matchQcTids();});$('qcMatchBtn').addEventListener('click',matchQcTids);
    $('qcMatchTids').addEventListener('input',()=>setText('qcMatchResult','内容已变化，请重新校验并勾选。'));
    $('acceptancePreviewBtn').addEventListener('click',previewAcceptance);$('acceptanceCommitBtn').addEventListener('click',commitAcceptance);
    document.addEventListener('click',async event=>{
      const button=event.target.closest('[data-action],[data-export]');if(!button)return;
      try {
        if(button.dataset.export){exportData(button.dataset.export,button.dataset.exportRange||'all');return;}
        const action=button.dataset.action,id=button.dataset.taskId;
        if(action==='copy'){await copyTid(button.dataset.tid);return;}
        if(action==='submit')await submitTask(id);
        if(action==='reject')showRejectForm(id);
        if(action==='cancel-reject')button.closest('tr').remove();
        if(action==='review'){refreshState();selectedQcTaskId=id;renderQcWorkbench(id);}
        if(action==='acceptance-review'&&!acceptanceBusy){refreshState();selectedAcceptanceTaskId=id;renderAcceptanceWorkbench(id);}
        if(action==='reconfirm-acceptance-task')await reconfirmAcceptanceTask(button);
        if(action==='timeline'){selectedTimelineTaskId=id;renderTimeline(id);}
        if(action==='open-timeline'){selectedTimelineTaskId=id;activateView('records');}
        if(action==='edit-task'){requireManager();refreshState();showTaskEditor(id);}
        if(action==='edit-batch'){requireManager();refreshState();showBatchEditor(button.dataset.batchId);}
        if(action==='batch-details'){refreshState();showBatchDetails(button.dataset.batchId);}
        if(action==='delete-batch'){const ticket=++batchEditorTicket,identity=JSON.stringify(profile),mode=activeMode;await store.refresh();if(ticket!==batchEditorTicket||identity!==JSON.stringify(profile)||mode!==activeMode)return;refreshState();showBatchDelete(button.dataset.batchId);}
        if(action==='close-batch-detail'){$('batchDetail').classList.add('hidden');$('batchDetail').replaceChildren();}
        if(action==='edit-group-day'){if(refreshState())showGroupDailyEditor(button.dataset.groupId,button.dataset.field);}
        if(action==='close-group-day'){const form=$('groupDailyForm');if(form)groupDayDrafts.delete(`${form.dataset.groupId}|${form.dataset.date}`);$('groupDailyEditor').classList.add('hidden');$('groupDailyEditor').innerHTML='';}
        if(action==='close-task-editor'){$('taskEditor').classList.add('hidden');$('taskEditor').innerHTML='';}
        if(action==='close-batch-editor'){if($('batchDeleteForm')?.dataset.busy)return;batchEditorTicket+=1;$('batchEditor').classList.add('hidden');$('batchEditor').innerHTML='';}
        if(action==='package-rejections'){$('recordQcRound').value='all';$('scopeGroup').value=button.dataset.groupId;$('recordDateMode').value='all';$('recordSearch').value='';activateView('records');multiSet('recordMovie',[button.dataset.movie]);multiSet('recordStatus',['rejections']);renderRecords();}
      }catch(error){showToast(error.message,'error');}
    });
    document.addEventListener('submit',event=>{
      const form=event.target,handlers={rejectForm:saveReject,qcDecisionForm:saveQcDecision,acceptanceForm:saveAcceptance,batchEditForm:saveBatchEdit,batchDeleteForm:saveBatchDelete,taskEditForm:saveTaskEdit,reassignForm:saveReassign,groupDailyForm:saveGroupDaily,qcBulkDecisionForm:saveBulkQcFail,qcBulkRejectForm:saveBulkQcReject,acceptanceBulkDecisionForm:saveBulkAcceptanceFail,reworkAssignmentForm:saveReworkAssignment};if(!handlers[form.id])return;event.preventDefault();
      const button=form.querySelector('button[type="submit"]');if(button.disabled)return;button.disabled=true;Promise.resolve(handlers[form.id](form)).catch(error=>showToast(error.message,'error')).finally(()=>{button.disabled=false;});
    });
    document.addEventListener('change',event=>{if(event.target.matches('#qcDecisionForm input[name="decision"]')&&$('qcFailFields'))$('qcFailFields').classList.toggle('hidden',event.target.value!=='fail');});
    document.addEventListener('change',event=>{if(event.target.matches('#acceptanceForm input[name="decision"]'))syncAcceptanceSingleChoice();});
    document.addEventListener('change',event=>{if(!event.target.matches('#groupDailyForm [name="date"]'))return;const form=event.target.form,date=event.target.value;try{if(!date)throw new Error('请选择具体登记日期。');if(refreshState())showGroupDailyEditor(form.dataset.groupId,'date',date);}catch(error){event.target.value=form.dataset.date;showToast(error.message,'error');}});
  }
  async function init() {
    try {state=await store.init();profile=store.profile();const retiredProfile=profile&&!validProfile(profile);initializeControls();initializeWorkflowControls();bindEvents();bindBulkEvents();bindModuleEvents();bindOverviewEvents();bindReassignEvents();if(profile&&!retiredProfile)enterApp();else{profile=null;showIdentity();if(retiredProfile)showToast('组别已更新，请按新的单镜头1—3组或多镜头1—8组重新选择身份。');}}
    catch(error){$('appShell').classList.add('hidden');$('identityGate').classList.remove('hidden');const box=document.createElement('div');box.className='panel';const text=document.createElement('p');text.textContent='共享服务暂时无法连接，云端数据未清空。'+error.message;const button=document.createElement('button');button.type='button';button.className='btn primary';button.textContent='重试连接';button.addEventListener('click',()=>location.reload());box.append(text,button);$('identityGate').replaceChildren(box);}
  }
  window.GroupWorkbench={getState:()=>visibleStateSnapshot(),getTasks:()=>allTasks(),version:'20260921-prod14-error-analysis',revision:()=>store.revision(),rules:()=>({...FLOW}),activeMode:()=>activeMode,statusCounts:()=>counts(allTasks().filter(task=>task.mode===activeMode)),reports:()=>scopedReports()};
  init();
})();
