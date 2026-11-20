'use strict';

const cloud = (() => {
  const web = location.protocol === 'https:' || location.protocol === 'http:';
  const enabled = web && new URLSearchParams(location.search).get('local') !== '1';
  const preferences = ['dayW', 'weekend', 'today', 'orient', 'theme', 'panelW', 'labelW', 'ownerW'];
  const prefsKey = 'gantt-studio-display-v1';
  const activeProjectKey = 'gantt-studio-active-project-v1';
  let client;
  let authorized = false;
  let busy = false;
  let accountCheck = 0;
  let revision = null;
  let baseline = '';
  let pendingCreate = null;
  let status = '';
  let projects = [];

  function blank() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(prefsKey)) || {}; } catch {}
    const ui = { ...DEFAULT_UI };
    for (const key of preferences) {
      if (Object.hasOwn(stored, key)) ui[key] = stored[key];
    }
    return normalizeState({ project: '未命名專案', start: todayISO(), tasks: [], ui });
  }

  function payload(project = state.project, source = state) {
    return { project, start: source.start, tasks: source.tasks };
  }

  function dirty() {
    return baseline !== JSON.stringify(payload());
  }

  function updateStatus() {
    const el = $('#saveState');
    const saved = authorized && !status && revision !== null && !dirty();
    el.classList.toggle('saved', saved);
    el.textContent = !authorized ? '尚未登入' : status ||
      (saved ? '已儲存 · ' + timeLabel(state.savedAt) : dirty() ? '有未儲存變更' : '尚未存檔');
  }

  function changed() {
    try {
      const prefs = Object.fromEntries(preferences.map(key => [key, state.ui[key]]));
      localStorage.setItem(prefsKey, JSON.stringify(prefs));
    } catch {}
    updateStatus();
  }

  function updateControls() {
    $('.layout').inert = !authorized || busy;
    $('#libModal').inert = !authorized || busy;
    const panel = $('#cloudPanel');
    const form = $('#cloudLogin');
    const showForm = !!client && !authorized;
    const focusLogin = showForm && (form.hidden || !panel.open);
    form.hidden = !showForm;
    form.querySelector('button').disabled = busy;
    if (authorized && panel.open) panel.close();
    if (!authorized && !panel.open) panel.showModal();
    if (focusLogin) $('#cloudEmail').focus();
    $('#cloudLogout').hidden = !authorized;
    $('#cloudLogout').disabled = busy;
    for (const id of ['btnPdf', 'btnJpg', 'btnXlsx']) {
      $('#' + id).disabled = !authorized || busy;
    }
    updateStatus();
  }

  function loadEditor(next, row = null) {
    state = next;
    state.id = row?.id ?? null;
    state.savedAt = row ? Date.parse(row.updated_at) : 0;
    revision = row?.revision ?? null;
    baseline = JSON.stringify(payload());
    pendingCreate = null;
    status = '';
    rememberProject(state.id);
    closeColorPop();
    hideTip();
    syncControls();
  }

  function rememberProject(id) {
    try {
      if (id) sessionStorage.setItem(activeProjectKey, id);
      else sessionStorage.removeItem(activeProjectKey);
    } catch {}
  }

  function rememberedProject() {
    try { return sessionStorage.getItem(activeProjectKey); } catch { return null; }
  }

  function confirmDiscard() {
    return !dirty() || confirm('目前有未儲存的變更。確定放棄並繼續？可先匯出專案 JSON 備份。');
  }

  function canEdit() {
    return authorized && !busy;
  }

  async function run(action, operation, { requireLogin = true, saving = false } = {}) {
    if (busy || (requireLogin && !authorized)) return;
    const check = accountCheck;
    busy = true;
    if (saving) status = '儲存中…';
    if (!requireLogin) $('#cloudMessage').textContent = '正在登入…';
    closeColorPop();
    updateControls();
    try {
      await operation(() => check === accountCheck && authorized);
    } catch (error) {
      const message = error.message || '無法連線，請稍後再試';
      if (saving && check === accountCheck) status = '儲存失敗';
      const feedback = action + '失敗：' + message;
      if (requireLogin) toast(feedback);
      else $('#cloudMessage').textContent = feedback;
    } finally {
      busy = false;
      updateControls();
    }
  }

  function unwrap(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  function validateProject(data) {
    if (!data || typeof data.project !== 'string' || !parseISO(data.start) || !Array.isArray(data.tasks)) {
      throw new Error('專案檔缺少有效的名稱、開始日期或任務清單');
    }
    const tasks = new Map();
    for (const task of data.tasks) {
      if (!task || typeof task.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(task.id) || tasks.has(task.id) ||
          !parseISO(task.start) || !parseISO(task.end) || task.start > task.end ||
          ['name', 'owner', 'note'].some(key => task[key] != null && typeof task[key] !== 'string') ||
          (task.deps != null && !Array.isArray(task.deps))) {
        throw new Error('任務資料不完整、日期無效或任務編號重複');
      }
      tasks.set(task.id, task);
    }
    for (const task of tasks.values()) {
      for (const id of task.deps || []) {
        const predecessor = tasks.get(id);
        if (!predecessor || predecessor.end >= task.start) {
          throw new Error('請修正前置任務連結，後續任務必須在前置任務結束後開始');
        }
      }
    }
  }

  async function persist(data, creating) {
    validateProject(data);
    if (creating) {
      const signature = JSON.stringify(data);
      if (pendingCreate?.signature !== signature) pendingCreate = { signature, id: crypto.randomUUID() };
    }
    const rows = unwrap(await client.rpc('gantt_save_project', {
      p_id: creating ? pendingCreate.id : state.id,
      p_revision: creating ? null : revision,
      p_payload: data
    }));
    return rows[0] || null;
  }

  function saveProject(copyName) {
    return run('儲存', async stillAuthorized => {
      const creating = revision === null || copyName !== undefined;
      const data = payload(copyName);
      const row = await persist(data, creating);
      if (!stillAuthorized()) return;
      if (!row) {
        status = '版本衝突';
        toast('雲端專案已更新或刪除。可另存新檔保留變更，或重新開啟雲端版本。');
        return;
      }
      loadEditor({ ...state, project: data.project }, row);
      closeLibrary();
      toast('已儲存「' + state.project + '」');
    }, { saving: true });
  }

  function listMarkup(row) {
    return `<div class="lib-item${row.id === state.id ? ' current' : ''}">
      <div class="lib-main">
        <div class="lib-name">${esc(row.payload.project || '未命名專案')}</div>
        <div class="lib-meta">更新 ${timeLabel(Date.parse(row.updated_at))} · 版本 ${row.revision}</div>
      </div>
      <div class="lib-actions">
        <button class="btn tiny" type="button" data-open="${esc(row.id)}">開啟</button>
        <button class="btn tiny" type="button" data-del="${esc(row.id)}">刪除</button>
      </div>
    </div>`;
  }

  async function refreshLibrary(stillAuthorized) {
    const rows = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const page = unwrap(await client.from('gantt_projects').select('id, revision, updated_at, payload')
        .order('updated_at', { ascending: false }).order('id').range(offset, offset + pageSize - 1));
      if (!stillAuthorized()) return;
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    projects = rows;
    $('#libList').innerHTML = projects.length ? projects.map(listMarkup).join('') :
      '<p class="empty">尚無雲端專案。請儲存目前的專案或匯入 JSON。</p>';
    $('#libModal').hidden = false;
  }

  function openLibrary() {
    return run('載入專案庫', refreshLibrary);
  }

  async function fetchProject(id) {
    return unwrap(await client.from('gantt_projects').select().eq('id', id).maybeSingle());
  }

  function loadProject(row) {
    validateProject(row.payload);
    const next = normalizeState({ ...row.payload, ui: state.ui });
    next.ui.selectedId = null;
    loadEditor(next, row);
  }

  function openProject(id) {
    if (!canEdit() || !confirmDiscard()) return;
    return run('開啟專案', async stillAuthorized => {
      const row = await fetchProject(id);
      if (!stillAuthorized()) return;
      if (!row) throw new Error('此專案已不存在，請重新開啟專案庫');
      loadProject(row);
      closeLibrary();
      toast('已開啟「' + state.project + '」');
    });
  }

  function deleteProject(id) {
    const row = projects.find(item => item.id === id);
    if (!canEdit() || !row || !confirm('確定從雲端刪除「' + row.payload.project + '」？所有使用者都會失去此專案。')) return;
    return run('刪除專案', async stillAuthorized => {
      const deleted = unwrap(await client.rpc('gantt_delete_project', { p_id: id, p_revision: row.revision }));
      if (!stillAuthorized()) return;
      if (deleted && state.id === id) {
        state.id = null;
        state.savedAt = 0;
        revision = null;
        baseline = '';
        status = '';
        rememberProject(null);
      }
      toast(deleted ? '已刪除雲端專案' : '專案已更新或刪除，請確認最新清單');
      await refreshLibrary(stillAuthorized);
    });
  }

  function newProject() {
    if (!canEdit() || !confirmDiscard()) return;
    loadEditor(blank());
    $('#projName').focus();
    $('#projName').select();
  }

  function importFile(file) {
    if (!canEdit() || !confirmDiscard()) return;
    return run('匯入', async stillAuthorized => {
      let data = JSON.parse(await file.text());
      if (data?.state && !data.tasks) data = data.state;
      validateProject(data);
      const next = normalizeState({ ...data, ui: state.ui });
      next.ui.selectedId = null;
      if (!stillAuthorized()) return;
      const row = await persist(payload(next.project, next), true);
      if (!stillAuthorized()) return;
      if (!row) throw new Error('無法建立雲端專案');
      loadEditor(next, row);
      closeLibrary();
      toast('已匯入並儲存「' + state.project + '」');
    });
  }

  async function acceptSession(session) {
    const check = ++accountCheck;
    if (!session) {
      authorized = false;
      projects = [];
      $('#libList').replaceChildren();
      closeLibrary();
      loadEditor(blank());
      $('#cloudMessage').textContent = '請使用共用帳號登入。';
      updateControls();
      return;
    }
    const allowed = await client.rpc('gantt_access_allowed');
    if (check !== accountCheck) return;
    if (allowed.error || allowed.data !== true) {
      await client.auth.signOut({ scope: 'local' });
      throw new Error(allowed.error?.message || '這個帳號未獲授權使用專案庫');
    }
    const lastProject = rememberedProject();
    if (lastProject) {
      try {
        const row = await fetchProject(lastProject);
        if (check !== accountCheck) return;
        if (row) loadProject(row);
        else {
          rememberProject(null);
          toast('上次開啟的專案已不存在。請從「開啟專案」查看清單。');
        }
      } catch {
        if (check !== accountCheck) return;
        toast('無法載入上次開啟的專案。請從「開啟專案」重試。');
      }
    }
    authorized = true;
    updateControls();
  }

  function loadSdk() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      script.onload = resolve;
      script.onerror = () => reject(new Error('無法載入 Supabase 連線元件'));
      document.head.append(script);
    });
  }

  async function init() {
    const message = $('#cloudMessage');
    $('#cloudPanel').addEventListener('cancel', event => event.preventDefault());
    $('#libraryStorageHint').textContent = 'Supabase 共用專案庫';
    baseline = JSON.stringify(payload());
    updateControls();
    const config = window.GANTT_SUPABASE;
    if (!config?.url || !config?.publishableKey) {
      message.textContent = '網站尚未設定 Supabase。請填寫 supabase-config.js。';
      return;
    }

    message.textContent = '正在連線…';
    try {
      await loadSdk();
      client = window.supabase.createClient(config.url, config.publishableKey);
      client.auth.onAuthStateChange(event => {
        if (event === 'SIGNED_OUT') {
          acceptSession(null).catch(error => { message.textContent = error.message; });
        }
      });
      $('#cloudLogin').addEventListener('submit', event => {
        event.preventDefault();
        run('登入', async () => {
          const input = $('#cloudPassword');
          const password = input.value;
          input.value = '';
          const { session } = unwrap(await client.auth.signInWithPassword({
            email: $('#cloudEmail').value.trim(), password
          }));
          await acceptSession(session);
        }, { requireLogin: false });
      });
      $('#cloudLogout').addEventListener('click', () => {
        if (!confirmDiscard()) return;
        run('登出', async () => {
          unwrap(await client.auth.signOut({ scope: 'local' }));
        });
      });
      window.addEventListener('beforeunload', event => {
        if (authorized && (dirty() || status === '儲存中…')) {
          event.preventDefault();
          event.returnValue = '';
        }
      });
      const { session } = unwrap(await client.auth.getSession());
      await acceptSession(session);
    } catch (error) {
      message.textContent = error.message;
      updateControls();
    }
  }

  return { enabled, blank, init, canEdit, changed, updateStatus, saveProject, openLibrary,
    openProject, deleteProject, newProject, importFile };
})();
