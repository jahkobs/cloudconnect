'use strict';

/**
 * FusionQuery Studio — renderer shell controller.
 *
 * A multi-panel SQL IDE: activity bar → side panels (Connections, Schema,
 * Library, History, AI, Audit), an editor with tabs + bind-parameter prompts,
 * and a result grid with execution metadata and multi-format export. All
 * privileged work is brokered to the main process through `window.fqs`; the
 * gateway there enforces read-only SQL, row limits, and auditing.
 */

(function () {
  const fqs = window.fqs;
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const SAMPLE_SQL = `-- FusionQuery Studio — read-only SQL over Oracle Fusion via BI Publisher.
-- Ctrl+Enter to run · Ctrl+Shift+Enter to run selection · Ctrl+Shift+F to format.

SELECT person_number,
       full_name,
       email_address,
       effective_start_date
  FROM FUSION.PER_ALL_PEOPLE_F
 FETCH FIRST 100 ROWS ONLY`;

  const state = {
    ta: null,
    gutter: null,
    connections: [],
    connectionId: '',
    capabilities: null,
    tabs: [],
    activeTabId: null,
    tabSeq: 0,
    resultTabs: [],
    activeResultId: null,
    grid: null,
    panel: 'connections',
    schemaCache: [], // [{owner, table, columns:[{name,type}]}]
    settings: { maxRows: 10000, role: 'Query Developer' },
    encryptionAvailable: false,
  };

  // ------------------------------------------------------------ small utils
  function toast(msg, kind = 'info', ms = 3500) {
    const t = el('div', `toast toast-${kind}`, msg);
    $('#toasts').appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, ms);
  }
  function setStatus(msg, right) {
    $('#status-msg').textContent = msg;
    if (right !== undefined) $('#status-right').textContent = right;
  }

  // --------------------------------------------------------------- editor
  function activeTab() {
    return state.tabs.find((t) => t.id === state.activeTabId);
  }
  function getSql() {
    return state.ta ? state.ta.value : '';
  }
  function getSelectedOrAllSql() {
    const ta = state.ta;
    if (ta && ta.selectionEnd > ta.selectionStart) {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel.trim()) return sel;
    }
    return getSql();
  }
  function setEditorValue(v) {
    if (!state.ta) return;
    state.ta.value = v == null ? '' : v;
    updateGutter();
    scheduleValidate();
  }
  function insertAtCursor(text) {
    const ta = state.ta;
    if (!ta) return;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.focus();
    updateGutter();
  }
  function updateGutter() {
    if (!state.gutter || !state.ta) return;
    const lines = state.ta.value.split('\n').length || 1;
    if (state.gutter.childElementCount !== lines) {
      let html = '';
      for (let i = 1; i <= lines; i++) html += `<div class="gln">${i}</div>`;
      state.gutter.innerHTML = html;
    }
    state.gutter.scrollTop = state.ta.scrollTop;
  }

  function newTab(name, sql) {
    const id = `tab_${++state.tabSeq}`;
    state.tabs.push({ id, name: name || `Query ${state.tabSeq}`, sql: sql != null ? sql : '', jobId: null });
    switchTab(id);
    renderTabs();
  }
  function closeTab(id) {
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const cur = activeTab();
    if (cur) cur.sql = getSql();
    state.tabs.splice(idx, 1);
    if (state.tabs.length === 0) return newTab('Query', SAMPLE_SQL);
    if (state.activeTabId === id) switchTab(state.tabs[Math.max(0, idx - 1)].id);
    else renderTabs();
  }
  function switchTab(id) {
    const cur = activeTab();
    if (cur && cur.id !== id) cur.sql = getSql();
    state.activeTabId = id;
    const tab = activeTab();
    if (!tab) return;
    setEditorValue(tab.sql);
    if (state.ta) state.ta.focus();
    renderTabs();
  }
  function renderTabs() {
    const bar = $('#editor-tabs');
    bar.innerHTML = '';
    for (const tab of state.tabs) {
      const t = el('div', 'tab' + (tab.id === state.activeTabId ? ' active' : ''));
      t.appendChild(el('span', 'tab-label', tab.name));
      const close = el('span', 'tab-close', '×');
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      t.appendChild(close);
      t.addEventListener('click', () => switchTab(tab.id));
      bar.appendChild(t);
    }
    const add = el('div', 'tab tab-add', '＋');
    add.addEventListener('click', () => newTab('Query', ''));
    bar.appendChild(add);
  }

  function initEditor() {
    const ta = $('#sql-input');
    state.ta = ta;
    state.gutter = $('#gutter');
    ta.addEventListener('keydown', (e) => {
      const meta = e.ctrlKey || e.metaKey;
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart;
        const en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
        updateGutter();
      } else if (meta && e.key === 'Enter') {
        e.preventDefault();
        runQuery(e.shiftKey);
      } else if (meta && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        formatSql();
      }
    });
    ta.addEventListener('input', () => {
      updateGutter();
      scheduleValidate();
    });
    ta.addEventListener('scroll', () => {
      if (state.gutter) state.gutter.scrollTop = ta.scrollTop;
    });
    newTab('Query 1', SAMPLE_SQL);
  }

  function formatSql() {
    if (!window.SqlFormatter || !state.ta) return;
    const f = window.SqlFormatter.format(getSql());
    setEditorValue(f);
    const cur = activeTab();
    if (cur) cur.sql = f;
    setStatus('Formatted SQL.');
  }

  // live read-only validation feedback
  let validateTimer;
  function scheduleValidate() {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(validateNow, 350);
  }
  async function validateNow() {
    const bar = $('#validation-bar');
    const sql = getSql().trim();
    if (!sql) {
      bar.hidden = true;
      return;
    }
    try {
      const v = await fqs.query.validate(sql);
      if (v.valid) {
        bar.hidden = !v.bindParams.length;
        if (v.bindParams.length) {
          bar.className = 'validation-bar info';
          bar.textContent = `Bind parameters detected: ${v.bindParams.join(', ')}`;
        }
      } else {
        bar.hidden = false;
        bar.className = 'validation-bar error';
        bar.textContent = `⚠ ${v.error}`;
      }
    } catch {
      bar.hidden = true;
    }
  }

  // --------------------------------------------------------------- run query
  function setRunning(running) {
    $('#btn-run').disabled = running;
    $('#btn-run-sel').disabled = running;
    $('#btn-cancel').disabled = !running;
  }

  async function collectBinds(sql) {
    const v = await fqs.query.validate(sql);
    if (!v.valid) {
      toast(v.error, 'error', 6000);
      return null;
    }
    if (!v.bindParams.length) return {};
    return await promptBinds(v.bindParams);
  }

  async function runQuery(forceBackground) {
    if (!state.connectionId) return toast('Select a connection first.', 'warn');
    const sql = getSelectedOrAllSql().trim();
    if (!sql) return toast('Nothing to run.', 'warn');

    const binds = await collectBinds(sql);
    if (binds === null) return; // invalid or cancelled

    const maxRows = parseInt($('#max-rows').value, 10) || 10000;
    const background = forceBackground || $('#run-background').checked;

    if (background) {
      const tab = activeTab();
      const { jobId } = await fqs.query.runBackground({ connectionId: state.connectionId, sql, maxRows, binds, tabId: tab && tab.id });
      addJobChip(jobId, sql);
      setStatus(`Background job ${jobId} started…`);
      return;
    }

    setRunning(true);
    setStatus('Running…');
    const t0 = performance.now();
    try {
      const res = await fqs.query.run({ connectionId: state.connectionId, sql, maxRows, binds });
      if (!res.ok) {
        showError(res.error, res.detail);
        setStatus(res.rejected ? 'Query rejected (read-only policy).' : 'Query failed.');
        return;
      }
      showResult(res.result, sql, res.meta);
      const ms = Math.round(performance.now() - t0);
      setStatus(
        `${res.result.rowCount} row${res.result.rowCount === 1 ? '' : 's'}${res.result.truncated ? ' (truncated at row limit)' : ''}.`,
        `${(res.result.elapsedMs / 1000).toFixed(3)}s server · ${ms}ms client`
      );
    } catch (err) {
      showError(err.message);
      setStatus('Query failed.');
    } finally {
      setRunning(false);
    }
  }

  // ------------------------------------------------------------- results
  function ensureGrid() {
    if (!state.grid) state.grid = new window.DataGrid($('#grid'));
    return state.grid;
  }
  function showResult(result, sql, meta) {
    const snap = {
      id: `res_${Date.now()}`,
      name: deriveName(sql),
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      elapsedMs: result.elapsedMs,
      meta: meta || {},
      locked: false,
    };
    state.resultTabs = state.resultTabs.filter((r) => r.locked);
    state.resultTabs.push(snap);
    state.activeResultId = snap.id;
    renderResultTabs();
    ensureGrid().setData(result.columns, result.rows);
    renderResultMeta(snap);
    $('#grid-search').value = '';
  }
  function deriveName(sql) {
    const m = String(sql).match(/from\s+([a-z0-9_$#.]+)/i);
    return (m ? m[1].split('.').pop() : 'Result').slice(0, 24);
  }
  function renderResultMeta(snap) {
    const m = snap.meta || {};
    const bits = [
      `${snap.rowCount} rows`,
      m.environment ? `env: ${m.environment}` : null,
      m.connectionName ? `conn: ${m.connectionName}` : null,
      (m.params && m.params.length) ? `params: ${m.params.join(', ')}` : null,
      snap.truncated ? '⚠ truncated at row limit' : null,
    ].filter(Boolean);
    $('#result-meta').textContent = bits.join('   ·   ');
  }
  function renderResultTabs() {
    const bar = $('#result-tabs');
    bar.innerHTML = '';
    state.resultTabs.forEach((r) => {
      const t = el('div', 'rtab' + (r.id === state.activeResultId ? ' active' : '') + (r.locked ? ' locked' : ''));
      const lock = el('span', 'rtab-lock', r.locked ? '🔒' : '🔓');
      lock.title = r.locked ? 'Unlock' : 'Lock this result';
      lock.addEventListener('click', (e) => {
        e.stopPropagation();
        r.locked = !r.locked;
        renderResultTabs();
      });
      t.appendChild(lock);
      t.appendChild(el('span', 'rtab-label', `${r.name} (${r.rowCount})`));
      t.addEventListener('click', () => {
        state.activeResultId = r.id;
        ensureGrid().setData(r.columns, r.rows);
        renderResultMeta(r);
        renderResultTabs();
      });
      bar.appendChild(t);
    });
  }
  function showError(message, detail) {
    const rows = [[message]];
    if (detail) rows.push([String(detail).slice(0, 2000)]);
    ensureGrid().setData(['ERROR'], rows);
    $('#result-meta').textContent = 'Query error — see the grid. Use 🩺 Diagnose on the connection to pinpoint the cause.';
    if (detail) console.error('Detail:', detail);
    toast(message, 'error', 7000);
  }

  // ------------------------------------------------------------- jobs tray
  function addJobChip(jobId, sql) {
    const chip = el('div', 'job-chip');
    chip.dataset.jobId = jobId;
    chip.innerHTML = '<span class="job-spin"></span><span class="job-text">Running…</span>';
    const cancel = el('button', 'job-cancel', '×');
    cancel.addEventListener('click', () => fqs.query.cancel(jobId));
    chip.appendChild(cancel);
    chip.title = sql.slice(0, 120);
    $('#jobs-tray').appendChild(chip);
  }
  function updateJobChip(jobId, text, kind) {
    const chip = document.querySelector(`.job-chip[data-job-id="${jobId}"]`);
    if (!chip) return;
    chip.classList.add(kind);
    const spin = chip.querySelector('.job-spin');
    if (spin) spin.remove();
    chip.querySelector('.job-text').textContent = text;
    setTimeout(() => chip.remove(), 5000);
  }

  // ------------------------------------------------------------- bind prompt
  function promptBinds(params) {
    return new Promise((resolve) => {
      const modal = $('#modal');
      modal.innerHTML = '';
      modal.appendChild(el('div', 'modal-title', 'Query parameters'));
      const form = el('div', 'form-grid');
      const inputs = {};
      for (const p of params) {
        const f = el('label', 'form-field');
        f.appendChild(el('span', 'form-label', p));
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'value';
        inputs[p] = input;
        f.appendChild(input);
        form.appendChild(f);
      }
      modal.appendChild(form);
      const footer = el('div', 'modal-footer');
      const cancel = el('button', 'btn btn-ghost', 'Cancel');
      cancel.addEventListener('click', () => {
        hideModal();
        resolve(null);
      });
      const ok = el('button', 'btn btn-run', 'Run');
      ok.addEventListener('click', () => {
        const binds = {};
        for (const p of params) binds[p.replace(/^:/, '')] = inputs[p].value;
        hideModal();
        resolve(binds);
      });
      footer.append(cancel, ok);
      modal.appendChild(footer);
      $('#modal-backdrop').hidden = false;
      const first = inputs[params[0]];
      if (first) first.focus();
    });
  }
  function hideModal() {
    $('#modal-backdrop').hidden = true;
    $('#modal').innerHTML = '';
  }

  // ------------------------------------------------------------- export
  function toggleExport(show) {
    $('#export-dropdown').hidden = show === undefined ? !$('#export-dropdown').hidden : !show;
  }
  async function doExport(format) {
    toggleExport(false);
    if (!state.grid) return toast('No results to export.', 'warn');
    const { columns, rows } = state.grid.getExportData();
    if (!columns.length) return toast('No results to export.', 'warn');
    const snap = state.resultTabs.find((r) => r.id === state.activeResultId);
    const res = await fqs.export({ columns, rows, format, defaultName: 'fusionquery_export', meta: snap && snap.meta });
    if (res.ok) toast(`Exported ${rows.length} rows → ${res.filePath}`, 'success', 5000);
    else if (!res.canceled) toast(`Export failed: ${res.error}`, 'error');
  }

  // =====================================================================
  //  SIDE PANELS
  // =====================================================================
  const PANEL_TITLES = { connections: 'Connections', schema: 'Schema Browser', library: 'Query Library', history: 'Query History', ai: 'AI SQL Assistant', audit: 'Audit Log' };

  function switchPanel(name) {
    state.panel = name;
    document.querySelectorAll('.activity-bar .act').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
    $('#side-title').textContent = PANEL_TITLES[name] || name;
    const action = $('#side-action');
    action.style.display = name === 'connections' ? '' : 'none';
    renderPanel(name);
  }

  function renderPanel(name) {
    const body = $('#side-body');
    body.innerHTML = '';
    if (name === 'connections') renderConnectionsPanel(body);
    else if (name === 'schema') renderSchemaPanel(body);
    else if (name === 'library') renderLibraryPanel(body);
    else if (name === 'history') renderHistoryPanel(body);
    else if (name === 'ai') renderAiPanel(body);
    else if (name === 'audit') renderAuditPanel(body);
  }

  // ---- Connections panel -----------------------------------------------
  function renderConnectionsPanel(body) {
    if (!state.connections.length) {
      const empty = el('div', 'panel-empty');
      empty.innerHTML = 'No connections yet.<br/>';
      const demo = el('button', 'btn btn-run small', '＋ Add demo connection');
      demo.addEventListener('click', addDemoConnection);
      const add = el('button', 'btn btn-ghost small', 'New connection…');
      add.addEventListener('click', () => openConnectionForm());
      empty.append(demo, document.createElement('br'), add);
      body.appendChild(empty);
      return;
    }
    for (const c of state.connections) {
      const row = el('div', 'conn-card' + (c.id === state.connectionId ? ' active' : ''));
      const badge = `<span class="env-badge env-${c.environment}">${c.environment}</span>`;
      const prod = c.production ? '<span class="prod-flag" title="Production">PROD</span>' : '';
      const typ = `<span class="type-badge">${c.type}</span>`;
      row.innerHTML = `<div class="conn-card-main"><div class="conn-card-name">${esc(c.name)} ${prod}</div>
        <div class="conn-card-sub">${badge} ${typ} ${esc(c.username || '')}</div></div>`;
      row.addEventListener('click', () => selectConnection(c.id));
      const actions = el('div', 'conn-card-actions');
      actions.append(
        iconBtn('🩺', 'Diagnose', (e) => { e.stopPropagation(); runDiagnostics(c.id, c.name); }),
        iconBtn('✎', 'Edit', (e) => { e.stopPropagation(); openConnectionForm(c.id); }),
        iconBtn('⧉', 'Clone', async (e) => { e.stopPropagation(); await fqs.connections.clone(c.id); await reloadConnections(); }),
        iconBtn('🗑', 'Delete', async (e) => { e.stopPropagation(); if (confirm(`Delete connection "${c.name}"?`)) { await fqs.connections.delete(c.id); await reloadConnections(); } })
      );
      row.appendChild(actions);
      body.appendChild(row);
    }
    const add = el('button', 'btn btn-ghost small block', '＋ New connection…');
    add.addEventListener('click', () => openConnectionForm());
    body.appendChild(add);
  }
  function iconBtn(txt, title, fn) {
    const b = el('button', 'icon-btn', txt);
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  }
  async function addDemoConnection() {
    await fqs.connections.save({ name: 'Demo Fusion (synthetic)', type: 'demo', environment: 'DEV', username: 'demo', password: 'demo' });
    await reloadConnections();
    const demo = state.connections.find((c) => c.type === 'demo');
    if (demo) selectConnection(demo.id);
    toast('Demo connection added.', 'success');
  }

  function openConnectionForm(id) {
    const existing = id ? state.connections.find((c) => c.id === id) : null;
    const c = existing
      ? { ...existing, password: '' }
      : { name: '', type: 'fusion-bip', environment: 'DEV', pod: '', biPublisherUrl: '', username: '', password: '', restBaseUrl: '', authMethod: 'basic', reportPath: '/Custom/FusionQueryStudio/SQLRunner.xdo', catalogFolder: '/Custom/FusionQueryStudio', dataSource: 'ApplicationDB_FSCM', rowLimit: 10000, timeoutSec: 300, dynamicMode: false, adw: { tnsAlias: '', serviceLevel: 'Medium', username: '', walletPath: '' } };
    if (!c.adw) c.adw = { tnsAlias: '', serviceLevel: 'Medium', username: '', walletPath: '' };

    const modal = $('#modal');
    const draw = () => {
      modal.innerHTML = '';
      modal.appendChild(el('div', 'modal-title', existing ? 'Edit connection' : 'New connection'));
      const grid = el('div', 'form-grid');
      // get/set that understand dotted keys like 'adw.tnsAlias'
      const getK = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), c);
      const setK = (key, val) => {
        const parts = key.split('.');
        let o = c;
        for (let i = 0; i < parts.length - 1; i++) {
          if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
          o = o[parts[i]];
        }
        o[parts[parts.length - 1]] = val;
      };
      const field = (label, key, type = 'text', ph = '') => {
        const f = el('label', 'form-field');
        f.appendChild(el('span', 'form-label', label));
        const input = document.createElement('input');
        input.type = type;
        input.value = getK(key) || '';
        input.placeholder = ph;
        input.addEventListener('input', () => setK(key, input.value));
        f.appendChild(input);
        return f;
      };
      const select = (label, key, opts) => {
        const f = el('label', 'form-field');
        f.appendChild(el('span', 'form-label', label));
        const s = document.createElement('select');
        for (const o of opts) {
          const opt = el('option', null, o.label || o);
          opt.value = o.value != null ? o.value : o;
          if (String(opt.value) === String(getK(key))) opt.selected = true;
          s.appendChild(opt);
        }
        s.addEventListener('change', () => { setK(key, s.value); draw(); });
        f.appendChild(s);
        return f;
      };

      grid.appendChild(field('Name', 'name', 'text', 'Production Fusion'));
      grid.appendChild(select('Type', 'type', [
        { value: 'fusion-bip', label: 'Oracle Fusion — BI Publisher (SQL)' },
        { value: 'fusion-rest', label: 'Oracle Fusion — REST' },
        { value: 'adw', label: 'Oracle ADW / ATP (direct SQL)' },
        { value: 'bicc', label: 'Oracle BICC (bulk extract)' },
        { value: 'demo', label: 'Demo (synthetic, no pod)' },
      ]));
      grid.appendChild(select('Environment', 'environment', ['DEV', 'TEST', 'UAT', 'PROD']));

      if (c.type === 'fusion-bip') {
        grid.appendChild(field('Pod / Base URL', 'pod', 'text', 'https://xxxx.fa.us2.oraclecloud.com'));
        grid.appendChild(field('BI Publisher URL', 'biPublisherUrl', 'text', '(defaults to pod)'));
        grid.appendChild(field('Username', 'username'));
        grid.appendChild(field('Password', 'password', 'password', existing ? '•••• (unchanged)' : ''));
        grid.appendChild(field('Report path', 'reportPath'));
        grid.appendChild(select('Data source', 'dataSource', ['ApplicationDB_FSCM', 'ApplicationDB_HCM', 'ApplicationDB_CRM']));
      } else if (c.type === 'fusion-rest') {
        grid.appendChild(field('REST base URL', 'restBaseUrl', 'text', 'https://xxxx.fa.us2.oraclecloud.com'));
        grid.appendChild(select('Auth', 'authMethod', [{ value: 'oauth', label: 'OAuth 2.0 bearer' }, { value: 'basic', label: 'Basic' }]));
        grid.appendChild(field('Username', 'username'));
        grid.appendChild(field(c.authMethod === 'oauth' ? 'Bearer token' : 'Password', 'password', 'password'));
      } else if (c.type === 'adw') {
        grid.appendChild(field('TNS alias', 'adw.tnsAlias', 'text', 'mydb_high'));
        grid.appendChild(select('Service level', 'adw.serviceLevel', ['High', 'Medium', 'Low', 'TP', 'TPUrgent']));
        grid.appendChild(field('Wallet folder', 'adw.walletPath', 'text', 'C:\\wallets\\mydb'));
        grid.appendChild(field('DB username', 'adw.username'));
        grid.appendChild(field('DB password', 'password', 'password'));
      } else if (c.type === 'demo') {
        grid.appendChild(el('div', 'form-hint', 'Demo mode uses a synthetic Fusion schema — no pod or credentials required.'));
      }
      grid.appendChild(field('Row limit', 'rowLimit', 'number'));
      grid.appendChild(field('Timeout (sec)', 'timeoutSec', 'number'));

      if (!existing || c.environment !== 'PROD') {
        const dyn = el('label', 'form-field checkbox-field');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!c.dynamicMode;
        cb.disabled = c.environment === 'PROD';
        cb.addEventListener('change', () => (c.dynamicMode = cb.checked));
        dyn.append(cb, el('span', 'form-label', 'Dynamic development mode (create temp BIP objects — non-prod only)'));
        grid.appendChild(dyn);
      }
      modal.appendChild(grid);

      if (c.environment === 'PROD') {
        modal.appendChild(el('div', 'form-hint warn', '⚠ PRODUCTION connection — a permanent warning banner will be shown and dynamic mode is disabled.'));
      }
      if (!state.encryptionAvailable && c.type !== 'demo') {
        modal.appendChild(el('div', 'form-hint warn', 'OS keychain unavailable — secret will not be persisted.'));
      }

      const footer = el('div', 'modal-footer');
      const testB = el('button', 'btn btn-ghost', 'Test');
      testB.addEventListener('click', async () => {
        testB.textContent = 'Testing…';
        const saved = await fqs.connections.save(c);
        const r = await fqs.connections.test(saved.id);
        c.id = saved.id;
        testB.textContent = 'Test';
        if (r.ok) toast(r.warning || `Connected${r.version ? ' · ' + r.version : ''}.`, r.warning ? 'warn' : 'success', r.warning ? 8000 : 3500);
        else toast(`Failed: ${r.error}`, 'error', 7000);
        await reloadConnections();
      });
      const cancel = el('button', 'btn btn-ghost', 'Cancel');
      cancel.addEventListener('click', hideModal);
      const save = el('button', 'btn btn-run', 'Save');
      save.addEventListener('click', async () => {
        if (!c.name) return toast('Name is required.', 'warn');
        const saved = await fqs.connections.save(c);
        await reloadConnections();
        selectConnection(saved.id);
        hideModal();
        toast('Connection saved.', 'success');
      });
      const deployB = el('button', 'btn btn-ghost', 'Deploy SQL Runner');
      deployB.style.display = c.type === 'fusion-bip' ? '' : 'none';
      deployB.addEventListener('click', async () => {
        if (!c.id) { const s = await fqs.connections.save(c); c.id = s.id; }
        deployB.textContent = 'Deploying…';
        const r = await fqs.connections.deploy(c.id);
        deployB.textContent = 'Deploy SQL Runner';
        toast(r.ok ? `Deployed to ${r.reportPath}.` : `Deploy failed: ${r.error}`, r.ok ? 'success' : 'error', 7000);
      });
      footer.append(deployB, testB, cancel, save);
      modal.appendChild(footer);
    };
    draw();
    $('#modal-backdrop').hidden = false;
  }
  async function runDiagnostics(id, name) {
    const modal = $('#modal');
    modal.innerHTML = '';
    modal.appendChild(el('div', 'modal-title', `Diagnose · ${name}`));
    const list = el('div', 'diag-list');
    list.appendChild(el('div', 'diag-running', 'Running checks…'));
    modal.appendChild(list);
    const footer = el('div', 'modal-footer');
    const deployB = el('button', 'btn btn-ghost', 'Deploy SQL Runner');
    deployB.addEventListener('click', async () => {
      deployB.textContent = 'Deploying…';
      const r = await fqs.connections.deploy(id);
      deployB.textContent = 'Deploy SQL Runner';
      toast(r.ok ? `Deployed to ${r.reportPath}.` : `Deploy failed: ${r.error}`, r.ok ? 'success' : 'error', 7000);
      if (r.ok) runDiagnostics(id, name);
    });
    const copy = el('button', 'btn btn-ghost', 'Copy report');
    const close = el('button', 'btn btn-run', 'Close');
    close.addEventListener('click', hideModal);
    footer.append(deployB, copy, close);
    modal.appendChild(footer);
    $('#modal-backdrop').hidden = false;

    const res = await fqs.connections.diagnose(id);
    list.innerHTML = '';
    let report = `Diagnostics for ${name}\n`;
    for (const s of res.steps) {
      const row = el('div', 'diag-step ' + (s.ok ? 'ok' : 'bad'));
      row.innerHTML = `<div class="diag-head">${s.ok ? '✓' : '✗'} ${esc(s.step)}</div>
        <div class="diag-detail">${esc(s.detail || '')}</div>${s.remedy ? `<div class="diag-remedy">➤ ${esc(s.remedy)}</div>` : ''}`;
      list.appendChild(row);
      report += `${s.ok ? 'PASS' : 'FAIL'} — ${s.step}: ${s.detail || ''}${s.remedy ? ' | remedy: ' + s.remedy : ''}\n`;
    }
    copy.addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText(report); toast('Diagnostics copied.', 'success'); });
  }

  async function selectConnection(id) {
    state.connectionId = id;
    $('#connection-select').value = id;
    renderPanel('connections');
    await refreshProductionBanner();
    updateConnStatus();
    loadSchema('');
  }

  async function reloadConnections(selectId) {
    state.connections = await fqs.connections.list();
    const sel = $('#connection-select');
    sel.innerHTML = '<option value="">— no connection —</option>';
    for (const c of state.connections) {
      const o = el('option', null, `${c.name} [${c.environment}]`);
      o.value = c.id;
      sel.appendChild(o);
    }
    if (selectId) state.connectionId = selectId;
    sel.value = state.connectionId || '';
    if (state.panel === 'connections') renderPanel('connections');
    await refreshProductionBanner();
  }

  async function refreshProductionBanner() {
    const c = state.connections.find((x) => x.id === state.connectionId);
    $('#prod-banner').hidden = !(c && c.production);
    document.body.classList.toggle('prod-active', !!(c && c.production));
  }

  // ---- connection status indicator -------------------------------------
  function setConnStatus(kind, text) {
    const box = $('#conn-status');
    box.className = `conn-status state-${kind}`;
    $('#conn-status-text').textContent = text;
  }
  async function updateConnStatus() {
    if (!state.connectionId) return setConnStatus('idle', 'Not connected');
    const conn = state.connections.find((c) => c.id === state.connectionId);
    setConnStatus('connecting', `Connecting…${conn ? ' ' + conn.name : ''}`);
    try {
      const r = await fqs.connections.test(state.connectionId);
      if (r && r.ok) setConnStatus(r.warning ? 'warn' : 'connected', r.warning ? 'Reachable · deploy report' : `Connected${r.version && r.version !== 'unknown' ? ' · ' + r.version : ''}`);
      else {
        setConnStatus('error', 'Not connected');
        if (r && r.error) toast(`Connection failed: ${r.error}`, 'error', 7000);
      }
    } catch {
      setConnStatus('error', 'Not connected');
    }
  }

  // ---- Schema panel ----------------------------------------------------
  async function renderSchemaPanel(body) {
    if (!state.connectionId) {
      body.appendChild(el('div', 'panel-empty', 'Select a connection to browse its schema.'));
      return;
    }
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Filter tables…';
    search.className = 'panel-search';
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => loadSchema(search.value, tree), 300);
    });
    body.appendChild(search);
    const tree = el('div', 'tree');
    body.appendChild(tree);
    loadSchema('', tree);
  }

  async function loadSchema(filter, treeEl) {
    const tree = treeEl || document.querySelector('#side-body .tree');
    if (!state.connectionId) return;
    if (tree) tree.innerHTML = '<div class="tree-empty">Loading…</div>';
    const res = await fqs.meta.tables({ connectionId: state.connectionId, filter });
    if (!res.ok) {
      if (tree) tree.innerHTML = `<div class="tree-empty error">${esc(res.error)}</div>`;
      return;
    }
    const oI = res.result.columns.indexOf('OWNER');
    const tI = res.result.columns.indexOf('TABLE_NAME');
    const byOwner = new Map();
    for (const row of res.result.rows) {
      const owner = row[oI] || 'UNKNOWN';
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push(row[tI]);
    }
    // cache for AI grounding
    state.schemaCache = [];
    for (const [owner, tables] of byOwner) for (const t of tables) state.schemaCache.push({ owner, table: t, columns: [] });
    if (tree) renderTree(tree, byOwner);
  }

  function renderTree(tree, byOwner) {
    tree.innerHTML = '';
    if (byOwner.size === 0) return void (tree.innerHTML = '<div class="tree-empty">No objects.</div>');
    for (const [owner, tables] of byOwner) {
      const node = el('div', 'tree-node');
      const head = el('div', 'tree-branch');
      head.innerHTML = `<span class="tw">▸</span> <span class="tree-owner">${esc(owner)}</span> <span class="tree-count">${tables.length}</span>`;
      const children = el('div', 'tree-children');
      children.hidden = true;
      head.addEventListener('click', () => {
        children.hidden = !children.hidden;
        head.querySelector('.tw').textContent = children.hidden ? '▸' : '▾';
      });
      node.appendChild(head);
      for (const table of tables) {
        const leaf = el('div', 'tree-leaf');
        leaf.innerHTML = `<span class="tico">▦</span> ${esc(table)}`;
        leaf.title = 'Click: columns · Double-click: SELECT into editor';
        const colBox = el('div', 'tree-columns');
        colBox.hidden = true;
        leaf.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!colBox.dataset.loaded) {
            colBox.innerHTML = '<div class="tree-loading">…</div>';
            const cres = await fqs.meta.columns({ connectionId: state.connectionId, owner, table });
            colBox.innerHTML = '';
            if (cres.ok) {
              const nI = cres.result.columns.indexOf('COLUMN_NAME');
              const tyI = cres.result.columns.indexOf('DATA_TYPE');
              const cached = state.schemaCache.find((x) => x.owner === owner && x.table === table);
              for (const cr of cres.result.rows) {
                const c = el('div', 'tree-col');
                c.innerHTML = `<span class="col-name">${esc(cr[nI])}</span><span class="col-type">${esc(cr[tyI])}</span>`;
                c.addEventListener('click', () => insertAtCursor(cr[nI]));
                colBox.appendChild(c);
                if (cached) cached.columns.push({ name: cr[nI], type: cr[tyI] });
              }
              colBox.dataset.loaded = '1';
            } else colBox.innerHTML = `<div class="tree-loading error">${esc(cres.error)}</div>`;
          }
          colBox.hidden = !colBox.hidden;
        });
        leaf.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          insertAtCursor(`SELECT * FROM ${owner}.${table} FETCH FIRST 100 ROWS ONLY`);
        });
        const wrap = el('div', 'tree-leaf-wrap');
        wrap.append(leaf, colBox);
        node.appendChild(wrap);
      }
      tree.appendChild(node);
    }
  }

  // ---- Library panel ---------------------------------------------------
  async function renderLibraryPanel(body) {
    const items = await fqs.library.list();
    const save = el('button', 'btn btn-run small block', '✚ Save current query to library');
    save.addEventListener('click', saveCurrentToLibrary);
    body.appendChild(save);
    if (!items.length) return body.appendChild(el('div', 'panel-empty', 'No saved queries yet.'));
    const byModule = new Map();
    for (const it of items) {
      if (!byModule.has(it.module)) byModule.set(it.module, []);
      byModule.get(it.module).push(it);
    }
    for (const [mod, list] of byModule) {
      body.appendChild(el('div', 'lib-module', mod));
      for (const it of list) {
        const row = el('div', 'lib-item');
        row.innerHTML = `<div class="lib-name">${esc(it.name)} <span class="lib-status status-${esc(it.status)}">${esc(it.status)}</span></div>
          <div class="lib-sub">v${it.version} · ${(it.tags || []).map(esc).join(', ')}</div>`;
        row.addEventListener('click', () => { newTab(it.name.slice(0, 18), it.sql); switchPanel('connections'); });
        const del = iconBtn('🗑', 'Delete', async (e) => { e.stopPropagation(); await fqs.library.delete(it.id); renderPanel('library'); });
        row.appendChild(del);
        body.appendChild(row);
      }
    }
  }
  async function saveCurrentToLibrary() {
    const name = prompt('Query name:', activeTab() ? activeTab().name : 'Query');
    if (!name) return;
    const mod = prompt('Module (e.g. General Ledger, HCM Core):', 'General') || 'General';
    await fqs.library.save({ name, module: mod, sql: getSql(), tags: [], status: 'Draft' });
    toast('Saved to library.', 'success');
    if (state.panel === 'library') renderPanel('library');
  }

  // ---- History panel ---------------------------------------------------
  async function renderHistoryPanel(body) {
    const items = await fqs.history.list(200);
    const clear = el('button', 'btn btn-ghost small block danger', 'Clear history');
    clear.addEventListener('click', async () => { await fqs.history.clear(); renderPanel('history'); });
    body.appendChild(clear);
    if (!items.length) return body.appendChild(el('div', 'panel-empty', 'No history yet.'));
    for (const h of items) {
      const row = el('div', 'hist-item' + (h.ok ? '' : ' failed'));
      row.innerHTML = `<div class="hist-sql">${esc((h.sql || '').slice(0, 120))}</div>
        <div class="hist-sub">${new Date(h.at).toLocaleString()} · ${esc(h.connectionName || '')} · ${h.ok ? (h.rowCount + ' rows · ' + (h.elapsedMs || 0) + 'ms') : 'FAILED'}</div>`;
      row.addEventListener('click', () => { newTab('History', h.sql); switchPanel('connections'); });
      body.appendChild(row);
    }
  }

  // ---- AI panel --------------------------------------------------------
  function renderAiPanel(body) {
    body.appendChild(el('div', 'ai-note', 'Describe what you want in plain English. The assistant drafts read-only SQL using only this connection\u2019s cached metadata. Nothing runs automatically — review, then Run.'));
    const ta = document.createElement('textarea');
    ta.className = 'ai-prompt';
    ta.placeholder = 'e.g. Show active employees, their departments and managers';
    body.appendChild(ta);
    const gen = el('button', 'btn btn-run small block', '✨ Generate SQL');
    const out = el('div', 'ai-output');
    gen.addEventListener('click', async () => {
      if (!state.connectionId) return toast('Select a connection first.', 'warn');
      if (!state.schemaCache.length) { await loadSchema(''); }
      gen.textContent = 'Generating…';
      const r = await fqs.ai.generate({ connectionId: state.connectionId, prompt: ta.value, schema: state.schemaCache });
      gen.textContent = '✨ Generate SQL';
      out.innerHTML = '';
      if (!r.ok) return void out.appendChild(el('div', 'ai-error', r.error));
      out.appendChild(el('div', 'ai-explain', r.explanation));
      const pre = el('pre', 'ai-sql');
      pre.textContent = r.sql;
      out.appendChild(pre);
      if (r.notes && r.notes.length) {
        const ul = el('ul', 'ai-notes');
        for (const n of r.notes) ul.appendChild(el('li', null, n));
        out.appendChild(ul);
      }
      const insert = el('button', 'btn btn-ghost small', 'Insert into editor (review before running)');
      insert.addEventListener('click', () => { newTab('AI draft', r.sql); switchPanel('connections'); toast('Draft inserted — review, then Run.', 'info'); });
      out.appendChild(insert);
    });
    body.append(gen, out);
  }

  // ---- Audit panel -----------------------------------------------------
  async function renderAuditPanel(body) {
    const v = await fqs.audit.verify();
    const chain = el('div', 'audit-chain ' + (v.ok ? 'ok' : 'bad'), v.ok ? `✓ Audit chain intact (${v.count} records)` : `✗ Audit chain broken at record ${v.brokenAt}`);
    body.appendChild(chain);
    const items = await fqs.audit.list(200);
    if (!items.length) return body.appendChild(el('div', 'panel-empty', 'No audit records yet.'));
    for (const a of items) {
      const row = el('div', 'audit-item');
      row.innerHTML = `<div class="audit-ev">${esc(a.event)}</div>
        <div class="audit-sub">${new Date(a.at).toLocaleString()} · ${esc(a.connectionName || a.user || '')}${a.environment ? ' · ' + esc(a.environment) : ''}</div>`;
      body.appendChild(row);
    }
  }

  // =====================================================================
  //  WIRING
  // =====================================================================
  function wire() {
    $('#btn-run').addEventListener('click', () => runQuery(false));
    $('#btn-run-sel').addEventListener('click', () => {
      const ta = state.ta;
      if (ta && ta.selectionEnd <= ta.selectionStart) return toast('Select some SQL to run.', 'warn');
      runQuery(false);
    });
    $('#btn-cancel').addEventListener('click', () => { const t = activeTab(); if (t && t.jobId) fqs.query.cancel(t.jobId); });
    $('#btn-format').addEventListener('click', formatSql);
    $('#btn-save-lib').addEventListener('click', saveCurrentToLibrary);
    $('#btn-reconnect').addEventListener('click', () => state.connectionId ? updateConnStatus() : toast('Select a connection first.', 'warn'));
    $('#btn-export').addEventListener('click', (e) => { e.stopPropagation(); toggleExport(); });
    document.querySelectorAll('#export-dropdown button').forEach((b) => b.addEventListener('click', () => doExport(b.dataset.fmt)));
    document.addEventListener('click', () => toggleExport(false));

    $('#side-action').addEventListener('click', () => openConnectionForm());
    document.querySelectorAll('.activity-bar .act').forEach((b) => b.addEventListener('click', () => switchPanel(b.dataset.panel)));

    $('#connection-select').addEventListener('change', (e) => selectConnection(e.target.value));
    $('#max-rows').addEventListener('change', (e) => fqs.settings.save({ maxRows: parseInt(e.target.value, 10) || 10000 }));

    let gridTimer;
    $('#grid-search').addEventListener('input', (e) => { clearTimeout(gridTimer); const v = e.target.value; gridTimer = setTimeout(() => state.grid && state.grid.setFilter(v), 150); });

    $('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') hideModal(); });

    setupSplitters();

    // menu + jobs
    fqs.onMenu('menu:new-tab', () => newTab('Query', ''));
    fqs.onMenu('menu:run', () => runQuery(false));
    fqs.onMenu('menu:run-bg', () => runQuery(true));
    fqs.onMenu('menu:format', formatSql);
    fqs.onMenu('menu:export', () => doExport('csv'));
    fqs.onMenu('menu:connections', () => switchPanel('connections'));
    fqs.onMenu('menu:history', () => switchPanel('history'));
    fqs.onMenu('menu:ai', () => switchPanel('ai'));
    fqs.onMenu('menu:audit', () => switchPanel('audit'));
    fqs.onMenu('menu:deploy', async () => { if (state.connectionId) { const r = await fqs.connections.deploy(state.connectionId); toast(r.ok ? 'Deployed.' : r.error, r.ok ? 'success' : 'error'); } });
    fqs.onMenu('menu:about', () => toast('FusionQuery Studio v2 — governed Oracle Fusion SQL & data access.', 'info', 6000));

    fqs.onJobStarted(({ jobId, tabId }) => { const t = state.tabs.find((x) => x.id === tabId); if (t) t.jobId = jobId; });
    fqs.onJobCompleted(({ jobId, tabId, result, meta }) => {
      updateJobChip(jobId, `Done: ${result.rowCount} rows`, 'done');
      const t = state.tabs.find((x) => x.id === tabId);
      if (t) t.jobId = null;
      showResult(result, '(background)', meta);
      toast(`Background query done — ${result.rowCount} rows.`, 'success', 5000);
    });
    fqs.onJobFailed(({ jobId, tabId, error }) => {
      updateJobChip(jobId, 'Failed', 'failed');
      const t = state.tabs.find((x) => x.id === tabId);
      if (t) t.jobId = null;
      toast(`Background query failed: ${error}`, 'error', 6000);
    });
  }

  function setupSplitters() {
    const v = $('#splitter-v');
    const side = $('#side-panel');
    let dv = false;
    v.addEventListener('mousedown', () => { dv = true; document.body.style.cursor = 'col-resize'; });
    window.addEventListener('mousemove', (e) => { if (dv) side.style.width = `${Math.min(620, Math.max(200, e.clientX - 52))}px`; });
    window.addEventListener('mouseup', () => { dv = false; document.body.style.cursor = ''; });

    const h = $('#splitter-h');
    const results = document.querySelector('.results');
    let dh = false;
    h.addEventListener('mousedown', () => { dh = true; document.body.style.cursor = 'row-resize'; });
    window.addEventListener('mousemove', (e) => { if (!dh) return; const r = document.querySelector('.workspace').getBoundingClientRect(); results.style.height = `${Math.min(r.height - 160, Math.max(140, r.bottom - e.clientY))}px`; });
    window.addEventListener('mouseup', () => { dh = false; document.body.style.cursor = ''; });
  }

  async function boot() {
    initEditor();
    wire();
    try {
      const info = await fqs.app.info();
      state.encryptionAvailable = info.encryptionAvailable;
      $('#app-version').textContent = 'v' + info.version;
    } catch { /* ignore */ }
    try {
      const s = await fqs.settings.get();
      state.settings = s;
      $('#max-rows').value = s.maxRows || 10000;
      $('#role-badge').textContent = s.role || 'Query Developer';
    } catch { /* ignore */ }
    try {
      await reloadConnections();
      if (state.connections.length) selectConnection(state.connections[0].id);
      else setConnStatus('idle', 'Not connected');
    } catch { setConnStatus('idle', 'Not connected'); }
    switchPanel('connections');
  }

  boot();
})();
