(function (root) {
  'use strict';
  const SESSION_KEY = 'r2v-group-workbench-shared-v1:session';
  const collections = ['tasks', 'events', 'batches'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const empty = () => ({ version: 3, createdAt: '', tasks: [], events: [], batches: [], preferences: {} });
  function create() {
    const base = '/group-workbench-api/';
    let session = null, state = empty(), revision = -1, queue = Promise.resolve(), syncPromise = null;
    const listeners = new Set();
    const notify = detail => listeners.forEach(listener => listener(detail));
    function saveSession(value) {
      session = value;
      try { if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); else sessionStorage.removeItem(SESSION_KEY); } catch (_) { /* The open tab can still work. */ }
    }
    async function request(path, options = {}, retry = false) {
      const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(session ? { 'X-Workbench-Session': session.token } : {}), ...options.headers, 'X-Workbench-Client': 'import-delete-v1' };
      let response;
      try {
        response = await fetch(base + path, { ...options, headers, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20000) });
      } catch (cause) {
        if (retry) return request(path, options, false);
        const error = new Error('暂时无法连接共享服务，请保留填写内容，恢复网络后重试。');
        error.cause = cause; error.code = 'NETWORK_ERROR'; throw error;
      }
      let body;
      try { body = await response.json(); } catch (_) { throw new Error('共享服务返回异常，填写内容已保留。'); }
      if (!response.ok) {
        const error = new Error(body.error?.message || body.message || (typeof body.error === 'string' ? body.error : '') || '操作未保存，请核对后重试。');
        error.code = body.code || body.error?.code || ''; error.status = response.status; throw error;
      }
      return body;
    }
    function apply(result) {
      if (!Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('共享数据版本异常，未替换现有数据。');
      if (result.revision < revision) return false;
      const changed = result.revision !== revision;
      if (result.state) {
        if (!collections.every(name => Array.isArray(result.state[name]))) throw new Error('共享数据格式不完整，未替换现有数据。');
        state = { ...clone(result.state), preferences: {} };
      } else if (result.delta && changed) {
        const next = { ...state };
        for (const name of collections) {
          const records = new Map(state[name].map(row => [row.id, row]));
          for (const row of result.delta[name] || []) {
            const prior = records.get(row.id);
            if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error('共享历史记录存在冲突，未覆盖原始数据。');
            records.set(row.id, clone(row));
          }
          next[name] = Array.from(records.values());
        }
        state = next;
      }
      revision = result.revision;
      return changed;
    }
    async function refresh() {
      if (!session) return false;
      if (syncPromise) return syncPromise;
      const token = session.token;
      syncPromise = (async () => {
        try {
          const result = await request('state' + (revision >= 0 ? `?after=${revision}` : ''));
          if (session?.token !== token) return false;
          const changed = apply(result);
          notify({ kind: 'sync', changed, revision });
          return changed;
        } catch (error) { notify({ kind: 'error', error }); throw error; }
        finally { syncPromise = null; }
      })();
      return syncPromise;
    }
    async function init() {
      try { const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); if (saved?.token && saved?.profile) session = saved; } catch (_) { /* Start at identity registration. */ }
      if (session) {
        try {
          const value = await request('session');
          saveSession({ token: session.token, profile: value.profile });
          await refresh();
        } catch (error) {
          if (error.status === 401 || error.status === 403) { saveSession(null); state = empty(); revision = -1; }
          else throw error;
        }
      }
      return state;
    }
    async function signIn(profile, pin) {
      await queue.catch(() => {});
      const result = await request('session', { method: 'POST', body: JSON.stringify({ profile, pin: pin || undefined }) });
      if (!result.token || !result.profile) throw new Error('身份验证未完成，请重试。');
      if (syncPromise) await syncPromise.catch(() => {});
      saveSession({ token: result.token, profile: result.profile });
      state = empty(); revision = -1;
      await refresh();
      return result.profile;
    }
    function transact(builder, options = {}) {
      const identity = session?.token;
      const operation = async () => {
        if (!identity || session?.token !== identity) throw new Error('作业身份已变化，请重新核对后提交。');
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await refresh();
          if (session?.token !== identity) throw new Error('作业身份已变化，未保存。');
          const delta = clone(await builder(state));
          if (!collections.some(name => delta[name]?.length)) return state;
          const body = JSON.stringify({ id: crypto.randomUUID(), revision, delta, pin: options.pin || undefined });
          try {
            // A transport retry sends the identical id and payload. Never infer success from a toast or local write.
            const result = await request('transactions', { method: 'POST', body }, true);
            if (session?.token !== identity) throw new Error('操作已保存，请切回原身份查看最新记录。');
            if (result.revision === revision + 1) apply(result);
            try { await refresh(); } catch (_) { if (result.revision > revision) throw new Error('操作已保存到云端，网络恢复后请同步查看，勿重复提交。'); }
            notify({ kind: 'saved', revision });
            return state;
          } catch (error) {
            if ((error.code === 'REVISION_CONFLICT' || error.status === 409 && error.code === 'STALE_REVISION') && attempt < 2) continue;
            throw error;
          }
        }
        throw new Error('其他同学正在更新任务，请核对后重试，填写内容已保留。');
      };
      const pending = queue.catch(() => {}).then(operation);
      queue = pending.catch(() => {});
      return pending;
    }
    async function backup() { return request('backup'); }
    return Object.freeze({ init, read: () => state, refresh, transact, backup, signIn, profile: () => session?.profile || null, revision: () => revision, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } });
  }
  root.WorkbenchStore = Object.freeze({ create, sessionKey: SESSION_KEY });
}(window));
