'use strict';

/**
 * CloudConnect renderer application.
 *
 * Owns the UI state: editor tabs, the Monaco editor (with a plain-textarea
 * fallback), the results grid, the DB browser tree, connection selection,
 * background jobs, history, and the connection-manager / settings modals.
 * All privileged work is delegated to the main process through `window.cc`.
 */

(function () {
  const cc = window.cc; // preload bridge
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const SAMPLE_SQL = `-- Welcome to CloudConnect
-- Run SQL against Oracle Fusion via BI Publisher.
-- Tip: use the DB Browser on the left, or try the demo schema below.

SELECT person_number,
       full_name,
       email_address,
       effective_start_date
  FROM FUSION.PER_ALL_PEOPLE_F
 FETCH FIRST 100 ROWS ONLY`;

  const state = {
    monaco: null,
    editor: null,
    usingFallback: false,
    connections: [],
    connectionId: '',
    tabs: [],
    activeTabId: null,
    resultTabs: [], // locked result snapshots
    grid: null,
    settings: { maxRows: 100 },
    encryptionAvailable: false,
    tabSeq: 0,
  };

  // ---------------------------------------------------------------- toasts
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

  // ------------------------------------------------------------- editor/tabs
  function activeTab() {
    return state.tabs.find((t) => t.id === state.activeTabId);
  }

  function getSql() {
    const tab = activeTab();
    if (!tab) return '';
    if (state.usingFallback) return $('#fallback-textarea').value;
    return tab.model ? tab.model.getValue() : tab.sql;
  }

  function getSelectedOrAllSql() {
    if (!state.usingFallback && state.editor) {
      const sel = state.editor.getSelection();
      const model = state.editor.getModel();
      if (sel && model && !sel.isEmpty()) {
        const text = model.getValueInRange(sel);
        if (text.trim()) return text;
      }
    }
    return getSql();
  }

  function newTab(name, sql) {
    const id = `tab_${++state.tabSeq}`;
    const tab = { id, name: name || `Query ${state.tabSeq}`, sql: sql != null ? sql : '', model: null, jobId: null };
    if (state.monaco) {
      tab.model = state.monaco.editor.createModel(tab.sql, 'sql');
    }
    state.tabs.push(tab);
    switchTab(id);
    renderTabs();
    return tab;
  }

  function closeTab(id) {
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [removed] = state.tabs.splice(idx, 1);
    if (removed.model) removed.model.dispose();
    if (state.tabs.length === 0) newTab('Query', SAMPLE_SQL);
    else if (state.activeTabId === id) switchTab(state.tabs[Math.max(0, idx - 1)].id);
    renderTabs();
  }

  function switchTab(id) {
    // persist current
    const cur = activeTab();
    if (cur && !state.usingFallback && cur.model) cur.sql = cur.model.getValue();
    state.activeTabId = id;
    const tab = activeTab();
    if (!tab) return;
    if (state.usingFallback) {
      $('#fallback-textarea').value = tab.sql;
    } else if (state.editor) {
      if (!tab.model) tab.model = state.monaco.editor.createModel(tab.sql, 'sql');
      state.editor.setModel(tab.model);
      state.editor.focus();
    }
    renderTabs();
  }

  function renderTabs() {
    const bar = $('#editor-tabs');
    bar.innerHTML = '';
    for (const tab of state.tabs) {
      const t = el('div', 'tab' + (tab.id === state.activeTabId ? ' active' : ''));
      const label = el('span', 'tab-label', tab.name);
      const close = el('span', 'tab-close', '×');
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      t.appendChild(label);
      t.appendChild(close);
      t.addEventListener('click', () => switchTab(tab.id));
      bar.appendChild(t);
    }
    const add = el('div', 'tab tab-add', '＋');
    add.title = 'New tab';
    add.addEventListener('click', () => newTab('Query', ''));
    bar.appendChild(add);
  }

  // ------------------------------------------------------------- Monaco init
  function initEditor(monaco) {
    if (monaco) {
      state.monaco = monaco;
      configureSqlLanguage(monaco);
      state.editor = monaco.editor.create($('#monaco'), {
        value: '',
        language: 'sql',
        theme: 'cc-dark',
        automaticLayout: true,
        minimap: { enabled: true },
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        scrollBeyondLastLine: false,
        renderLineHighlight: 'all',
        smoothScrolling: true,
        tabSize: 2,
      });
      state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runQuery(false));
      state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => runQuery(true));
      state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, formatSql);
    } else {
      // Fallback plain editor.
      state.usingFallback = true;
      $('#monaco').hidden = true;
      $('#fallback-editor').hidden = false;
      toast('Monaco editor not available — using plain editor. Run "npm install" to enable rich editing.', 'warn', 6000);
    }
    // First tab
    newTab('Query 1', SAMPLE_SQL);
    if (state.usingFallback) $('#fallback-textarea').value = SAMPLE_SQL;
  }

  function configureSqlLanguage(monaco) {
    monaco.editor.defineTheme('cc-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'keyword.sql', foreground: '6fb3ff', fontStyle: 'bold' },
        { token: 'string.sql', foreground: 'b5e8a0' },
        { token: 'comment.sql', foreground: '6b7a99', fontStyle: 'italic' },
        { token: 'number.sql', foreground: 'f0b37e' },
      ],
      colors: {
        'editor.background': '#0f1729',
        'editor.lineHighlightBackground': '#16203a',
        'editorLineNumber.foreground': '#3d4a68',
        'editorGutter.background': '#0f1729',
      },
    });

    // Schema-aware + keyword completions.
    monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: [' ', '.', '\n'],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const suggestions = [];
        const kw = (
          'SELECT FROM WHERE GROUP BY HAVING ORDER BY JOIN LEFT JOIN RIGHT JOIN INNER JOIN ' +
          'ON AND OR NOT IN IS NULL LIKE BETWEEN EXISTS DISTINCT COUNT SUM AVG MIN MAX ' +
          'CASE WHEN THEN ELSE END AS UNION ALL FETCH FIRST ROWS ONLY WITH'
        ).split(' ');
        for (const k of kw) {
          suggestions.push({
            label: k,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: k,
            range,
          });
        }
        for (const item of state.schemaCompletions || []) {
          suggestions.push({ ...item, range });
        }
        return { suggestions };
      },
    });
  }

  function formatSql() {
    if (!window.SqlFormatter) return;
    const tab = activeTab();
    const src = getSql();
    const formatted = window.SqlFormatter.format(src);
    if (state.usingFallback) {
      $('#fallback-textarea').value = formatted;
    } else if (tab && tab.model) {
      tab.model.pushEditOperations(
        [],
        [{ range: tab.model.getFullModelRange(), text: formatted }],
        () => null
      );
    }
    setStatus('Formatted SQL.');
  }

  // ----------------------------------------------------------- run queries
  function currentConnectionValid() {
    if (!state.connectionId) {
      toast('Select a connection first.', 'warn');
      return false;
    }
    return true;
  }

  async function runQuery(forceBackground) {
    if (!currentConnectionValid()) return;
    const sql = getSelectedOrAllSql().trim();
    if (!sql) {
      toast('Nothing to run.', 'warn');
      return;
    }
    const maxRows = parseInt($('#max-rows').value, 10) || 100;
    const background = forceBackground || $('#run-background').checked;

    if (background) {
      const tab = activeTab();
      const { jobId } = await cc.query.runBackground({
        connectionId: state.connectionId,
        sql,
        maxRows,
        tabId: tab ? tab.id : null,
      });
      addJobChip(jobId, sql);
      setStatus(`Background job ${jobId} started…`);
      return;
    }

    setRunning(true);
    setStatus('Running…');
    const t0 = performance.now();
    try {
      const res = await cc.query.run({ connectionId: state.connectionId, sql, maxRows });
      if (!res.ok) {
        showError(res.error, res.detail);
        setStatus('Query failed.');
        return;
      }
      showResult(res.result, sql);
      const ms = Math.round(performance.now() - t0);
      setStatus(
        `${res.result.rowCount} row${res.result.rowCount === 1 ? '' : 's'}${res.result.truncated ? ' (truncated)' : ''}.`,
        `Execution Time: ${(res.result.elapsedMs / 1000).toFixed(3)}s · client ${ms}ms`
      );
    } catch (err) {
      showError(err.message);
      setStatus('Query failed.');
    } finally {
      setRunning(false);
    }
  }

  function setRunning(running) {
    $('#btn-run').disabled = running;
    $('#btn-cancel').disabled = !running;
    $('#btn-run').classList.toggle('is-running', running);
  }

  // --------------------------------------------------------- results & grid
  function ensureGrid() {
    if (!state.grid) state.grid = new window.DataGrid($('#grid'));
    return state.grid;
  }

  function showResult(result, sql) {
    const snap = {
      id: `res_${Date.now()}`,
      name: deriveResultName(sql),
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      elapsedMs: result.elapsedMs,
      locked: false,
    };
    // Replace the unlocked/live result, keep locked ones.
    state.resultTabs = state.resultTabs.filter((r) => r.locked);
    state.resultTabs.push(snap);
    state.activeResultId = snap.id;
    renderResultTabs();
    ensureGrid().setData(result.columns, result.rows);
    $('#grid-search').value = '';
  }

  function deriveResultName(sql) {
    const m = String(sql).match(/from\s+([a-z0-9_$#.]+)/i);
    return (m ? m[1].split('.').pop() : 'Result').slice(0, 24);
  }

  function renderResultTabs() {
    const bar = $('#result-tabs');
    bar.innerHTML = '';
    state.resultTabs.forEach((r) => {
      const t = el('div', 'rtab' + (r.id === state.activeResultId ? ' active' : '') + (r.locked ? ' locked' : ''));
      const lock = el('span', 'rtab-lock', r.locked ? '🔒' : '🔓');
      lock.title = r.locked ? 'Unlock' : 'Lock (keep this result)';
      lock.addEventListener('click', (e) => {
        e.stopPropagation();
        r.locked = !r.locked;
        renderResultTabs();
      });
      const label = el('span', 'rtab-label', `${r.name} (${r.rowCount})`);
      t.appendChild(lock);
      t.appendChild(label);
      t.addEventListener('click', () => {
        state.activeResultId = r.id;
        ensureGrid().setData(r.columns, r.rows);
        renderResultTabs();
      });
      bar.appendChild(t);
    });
  }

  function showError(message, detail) {
    ensureGrid().setData(['ERROR'], [[message]]);
    if (detail) console.error('Fusion detail:', detail);
    toast(message, 'error', 6000);
  }

  // ------------------------------------------------------------- jobs tray
  function addJobChip(jobId, sql) {
    const chip = el('div', 'job-chip');
    chip.dataset.jobId = jobId;
    chip.innerHTML = `<span class="job-spin"></span><span class="job-text">Running…</span>`;
    const cancel = el('button', 'job-cancel', '×');
    cancel.title = 'Cancel job';
    cancel.addEventListener('click', () => cc.query.cancel(jobId));
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

  // ------------------------------------------------------------- DB browser
  async function loadTree(filter) {
    if (!state.connectionId) {
      $('#tree').innerHTML = '<div class="tree-empty">Connect to browse schema.</div>';
      return;
    }
    $('#tree').innerHTML = '<div class="tree-empty">Loading…</div>';
    const res = await cc.meta.tables({ connectionId: state.connectionId, filter });
    if (!res.ok) {
      $('#tree').innerHTML = `<div class="tree-empty error">${res.error}</div>`;
      return;
    }
    const byOwner = new Map();
    const cIdx = res.result.columns.indexOf('OWNER');
    const tIdx = res.result.columns.indexOf('TABLE_NAME');
    for (const row of res.result.rows) {
      const owner = row[cIdx] || 'UNKNOWN';
      const table = row[tIdx];
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push(table);
    }
    renderTree(byOwner);
    updateSchemaCompletions(byOwner);
  }

  function renderTree(byOwner) {
    const tree = $('#tree');
    tree.innerHTML = '';
    if (byOwner.size === 0) {
      tree.innerHTML = '<div class="tree-empty">No objects found.</div>';
      return;
    }
    for (const [owner, tables] of byOwner) {
      const node = el('div', 'tree-node');
      const head = el('div', 'tree-branch');
      head.innerHTML = `<span class="tw">▸</span> <span class="tree-owner">${owner}</span> <span class="tree-count">${tables.length}</span>`;
      const children = el('div', 'tree-children');
      children.hidden = true;
      head.addEventListener('click', () => {
        children.hidden = !children.hidden;
        head.querySelector('.tw').textContent = children.hidden ? '▸' : '▾';
      });
      node.appendChild(head);
      for (const table of tables) {
        const leaf = el('div', 'tree-leaf');
        leaf.innerHTML = `<span class="tico">▦</span> ${table}`;
        leaf.title = 'Click to expand columns · double-click to preview';
        const colBox = el('div', 'tree-columns');
        colBox.hidden = true;
        leaf.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!colBox.dataset.loaded) {
            colBox.innerHTML = '<div class="tree-loading">…</div>';
            const cres = await cc.meta.columns({ connectionId: state.connectionId, owner, table });
            colBox.innerHTML = '';
            if (cres.ok) {
              const nameI = cres.result.columns.indexOf('COLUMN_NAME');
              const typeI = cres.result.columns.indexOf('DATA_TYPE');
              for (const cr of cres.result.rows) {
                const c = el('div', 'tree-col');
                c.innerHTML = `<span class="col-name">${cr[nameI]}</span><span class="col-type">${cr[typeI]}</span>`;
                colBox.appendChild(c);
              }
              colBox.dataset.loaded = '1';
            } else {
              colBox.innerHTML = `<div class="tree-loading error">${cres.error}</div>`;
            }
          }
          colBox.hidden = !colBox.hidden;
        });
        leaf.addEventListener('dblclick', async (e) => {
          e.stopPropagation();
          setStatus(`Previewing ${owner}.${table}…`);
          const pres = await cc.meta.preview({ connectionId: state.connectionId, owner, table, limit: 100 });
          if (pres.ok) {
            showResult(pres.result, `SELECT * FROM ${owner}.${table}`);
            setStatus(`${pres.result.rowCount} rows from ${owner}.${table}.`);
          } else {
            showError(pres.error);
          }
        });
        const wrap = el('div', 'tree-leaf-wrap');
        wrap.appendChild(leaf);
        wrap.appendChild(colBox);
        node.appendChild(wrap);
      }
      tree.appendChild(node);
    }
  }

  function updateSchemaCompletions(byOwner) {
    if (!state.monaco) return;
    const items = [];
    const kind = state.monaco.languages.CompletionItemKind;
    for (const [owner, tables] of byOwner) {
      for (const table of tables) {
        items.push({ label: table, kind: kind.Struct, insertText: table, detail: owner });
        items.push({ label: `${owner}.${table}`, kind: kind.Struct, insertText: `${owner}.${table}`, detail: 'schema.table' });
      }
    }
    state.schemaCompletions = items;
  }

  // ------------------------------------------------------------- export
  async function doExport(format) {
    if (!state.grid) {
      toast('No results to export.', 'warn');
      return;
    }
    const { columns, rows } = state.grid.getExportData();
    if (!columns.length) {
      toast('No results to export.', 'warn');
      return;
    }
    const res = await cc.exportResults({ columns, rows, format, defaultName: 'cloudconnect_export' });
    if (res.ok) toast(`Exported ${rows.length} rows → ${res.filePath}`, 'success', 5000);
    else if (!res.canceled) toast(`Export failed: ${res.error}`, 'error');
  }

  // ------------------------------------------------------------- connections
  async function refreshConnections(selectId) {
    state.connections = await cc.connections.list();
    const sel = $('#connection-select');
    sel.innerHTML = '<option value="">— none —</option>';
    for (const c of state.connections) {
      const o = el('option', null, `${c.name}${c.demo ? ' (demo)' : ''}`);
      o.value = c.id;
      sel.appendChild(o);
    }
    if (selectId) {
      sel.value = selectId;
      state.connectionId = selectId;
    } else if (state.connectionId) {
      sel.value = state.connectionId;
    }
  }

  function openConnectionManager() {
    const backdrop = $('#modal-backdrop');
    const modal = $('#modal');
    const editing = { id: '', name: '', pod: '', username: '', password: '', reportPath: '/Custom/CloudConnect/SQLRunner.xdo', dataSource: 'ApplicationDB_FSCM', demo: false };

    function render() {
      modal.innerHTML = '';
      modal.appendChild(el('div', 'modal-title', 'Connections'));

      const list = el('div', 'conn-list');
      const demoBtn = el('button', 'btn btn-ghost small', '＋ Add demo connection');
      demoBtn.addEventListener('click', async () => {
        await cc.connections.save({ name: 'Demo Fusion (synthetic)', pod: 'demo://synthetic', username: 'demo', demo: true, password: 'demo' });
        await refreshConnections();
        render();
        toast('Demo connection added.', 'success');
      });
      list.appendChild(demoBtn);

      for (const c of state.connections) {
        const row = el('div', 'conn-row');
        row.innerHTML = `<div><div class="conn-name">${c.name}</div><div class="conn-sub">${c.demo ? 'Demo (synthetic schema)' : c.pod} · ${c.username || ''}</div></div>`;
        const actions = el('div', 'conn-row-actions');
        const edit = el('button', 'btn btn-ghost small', 'Edit');
        edit.addEventListener('click', () => {
          Object.assign(editing, { ...c, password: '' });
          renderForm();
        });
        const test = el('button', 'btn btn-ghost small', 'Test');
        test.addEventListener('click', async () => {
          test.textContent = 'Testing…';
          const r = await cc.connections.test(c.id);
          test.textContent = 'Test';
          if (r.ok) toast(`Connected (${r.version || 'ok'}).`, 'success');
          else toast(`Failed: ${r.error}`, 'error', 6000);
        });
        const del = el('button', 'btn btn-ghost small danger', 'Delete');
        del.addEventListener('click', async () => {
          await cc.connections.delete(c.id);
          await refreshConnections();
          render();
        });
        actions.append(test, edit, del);
        row.appendChild(actions);
        list.appendChild(row);
      }
      modal.appendChild(list);

      const formWrap = el('div', 'conn-form-wrap');
      formWrap.id = 'conn-form-wrap';
      modal.appendChild(formWrap);
      renderForm();

      const footer = el('div', 'modal-footer');
      const close = el('button', 'btn btn-ghost', 'Close');
      close.addEventListener('click', hideModal);
      footer.appendChild(close);
      modal.appendChild(footer);

      function renderForm() {
        const w = $('#conn-form-wrap') || formWrap;
        w.innerHTML = '';
        w.appendChild(el('div', 'form-title', editing.id ? 'Edit connection' : 'New connection'));
        const grid = el('div', 'form-grid');
        const field = (label, key, type = 'text', ph = '') => {
          const f = el('label', 'form-field');
          f.appendChild(el('span', 'form-label', label));
          const input = document.createElement('input');
          input.type = type;
          input.value = editing[key] || '';
          input.placeholder = ph;
          input.addEventListener('input', () => (editing[key] = input.value));
          f.appendChild(input);
          return f;
        };
        grid.appendChild(field('Name', 'name', 'text', 'Production Fusion'));
        grid.appendChild(field('Pod URL', 'pod', 'text', 'https://xxxx.fa.us2.oraclecloud.com'));
        grid.appendChild(field('Username', 'username', 'text', 'integration.user'));
        grid.appendChild(field('Password', 'password', 'password', state.editingHasPw ? '•••• (unchanged)' : ''));
        grid.appendChild(field('Report Path', 'reportPath'));

        const dsField = el('label', 'form-field');
        dsField.appendChild(el('span', 'form-label', 'Data Source'));
        const dsSel = document.createElement('select');
        for (const ds of ['ApplicationDB_FSCM', 'ApplicationDB_HCM', 'ApplicationDB_CRM']) {
          const o = el('option', null, ds);
          o.value = ds;
          if (ds === editing.dataSource) o.selected = true;
          dsSel.appendChild(o);
        }
        dsSel.addEventListener('change', () => (editing.dataSource = dsSel.value));
        dsField.appendChild(dsSel);
        grid.appendChild(dsField);

        const demoField = el('label', 'form-field checkbox-field');
        const demoInput = document.createElement('input');
        demoInput.type = 'checkbox';
        demoInput.checked = !!editing.demo;
        demoInput.addEventListener('change', () => (editing.demo = demoInput.checked));
        demoField.appendChild(demoInput);
        demoField.appendChild(el('span', 'form-label', 'Demo mode (synthetic schema, no pod)'));
        grid.appendChild(demoField);

        w.appendChild(grid);

        if (!state.encryptionAvailable && !editing.demo) {
          w.appendChild(el('div', 'form-hint warn', 'OS keychain unavailable — password will not be saved; you will be asked each session.'));
        }

        const actions = el('div', 'form-actions');
        const save = el('button', 'btn btn-run small', 'Save');
        save.addEventListener('click', async () => {
          if (!editing.name) return toast('Name is required.', 'warn');
          const id = await cc.connections.save(editing);
          await refreshConnections(id);
          Object.assign(editing, { id: '', name: '', pod: '', username: '', password: '', demo: false });
          render();
          toast('Connection saved.', 'success');
        });
        const deploy = el('button', 'btn btn-ghost small', 'Deploy SQL Runner');
        deploy.title = 'Upload the generic SQL Runner report to this pod';
        deploy.addEventListener('click', async () => {
          if (!editing.id) return toast('Save the connection first.', 'warn');
          deploy.textContent = 'Deploying…';
          const r = await cc.connections.deploy(editing.id);
          deploy.textContent = 'Deploy SQL Runner';
          if (r.ok) toast(r.demo ? 'Demo mode — no deployment needed.' : `Deployed to ${r.reportPath}.`, 'success', 5000);
          else toast(`Deploy failed: ${r.error}`, 'error', 7000);
        });
        const testBtn = el('button', 'btn btn-ghost small', 'Test');
        testBtn.addEventListener('click', async () => {
          testBtn.textContent = 'Testing…';
          const r = await cc.connections.test({ ...editing });
          testBtn.textContent = 'Test';
          if (r.ok) toast(`Connected (${r.version || 'ok'}).`, 'success');
          else toast(`Failed: ${r.error}`, 'error', 6000);
        });
        actions.append(save, testBtn, deploy);
        w.appendChild(actions);
      }
    }

    render();
    backdrop.hidden = false;
  }

  function hideModal() {
    $('#modal-backdrop').hidden = true;
    $('#modal').innerHTML = '';
  }

  async function openHistory() {
    const backdrop = $('#modal-backdrop');
    const modal = $('#modal');
    const items = await cc.history.list(200);
    modal.innerHTML = '';
    modal.appendChild(el('div', 'modal-title', 'Query History'));
    const list = el('div', 'history-list');
    if (items.length === 0) list.appendChild(el('div', 'tree-empty', 'No history yet.'));
    for (const h of items) {
      const row = el('div', 'history-row' + (h.ok ? '' : ' failed'));
      const when = new Date(h.at).toLocaleString();
      row.innerHTML = `<div class="history-sql">${escapeHtml(h.sql.slice(0, 200))}</div>
        <div class="history-meta">${when} · ${h.connectionName || ''} · ${h.ok ? `${h.rowCount} rows · ${h.elapsedMs}ms` : 'FAILED: ' + escapeHtml(h.error || '')}</div>`;
      row.addEventListener('click', () => {
        newTab('History', h.sql);
        hideModal();
      });
      list.appendChild(row);
    }
    modal.appendChild(list);
    const footer = el('div', 'modal-footer');
    const clear = el('button', 'btn btn-ghost danger', 'Clear history');
    clear.addEventListener('click', async () => {
      await cc.history.clear();
      openHistory();
    });
    const close = el('button', 'btn btn-ghost', 'Close');
    close.addEventListener('click', hideModal);
    footer.append(clear, close);
    modal.appendChild(footer);
    backdrop.hidden = false;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------------------------------------------------------------- wiring
  function wireUi() {
    $('#btn-run').addEventListener('click', () => runQuery(false));
    $('#btn-cancel').addEventListener('click', () => {
      const tab = activeTab();
      if (tab && tab.jobId) cc.query.cancel(tab.jobId);
    });
    $('#btn-format').addEventListener('click', formatSql);
    $('#btn-new-tab').addEventListener('click', () => newTab('Query', ''));
    $('#btn-connections').addEventListener('click', openConnectionManager);
    $('#btn-refresh-tree').addEventListener('click', () => loadTree($('#tree-filter').value));
    $('#btn-export-csv').addEventListener('click', () => doExport('csv'));
    $('#btn-export-xlsx').addEventListener('click', () => doExport('xlsx'));

    $('#connection-select').addEventListener('change', (e) => {
      state.connectionId = e.target.value;
      loadTree('');
      setStatus(state.connectionId ? 'Connection selected.' : 'No connection selected.');
    });

    let treeTimer;
    $('#tree-filter').addEventListener('input', (e) => {
      clearTimeout(treeTimer);
      const v = e.target.value;
      treeTimer = setTimeout(() => loadTree(v), 300);
    });

    let gridTimer;
    $('#grid-search').addEventListener('input', (e) => {
      clearTimeout(gridTimer);
      const v = e.target.value;
      gridTimer = setTimeout(() => state.grid && state.grid.setFilter(v), 150);
    });

    $('#max-rows').addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10) || 100;
      cc.settings.save({ maxRows: v });
    });

    $('#modal-backdrop').addEventListener('click', (e) => {
      if (e.target.id === 'modal-backdrop') hideModal();
    });

    setupSplitters();

    // Menu commands from main process.
    cc.onMenu('menu:new-tab', () => newTab('Query', ''));
    cc.onMenu('menu:run', () => runQuery(false));
    cc.onMenu('menu:run-bg', () => runQuery(true));
    cc.onMenu('menu:cancel', () => {
      const tab = activeTab();
      if (tab && tab.jobId) cc.query.cancel(tab.jobId);
    });
    cc.onMenu('menu:format', formatSql);
    cc.onMenu('menu:export', () => doExport('csv'));
    cc.onMenu('menu:connections', openConnectionManager);
    cc.onMenu('menu:deploy', async () => {
      if (!state.connectionId) return toast('Select a connection first.', 'warn');
      const r = await cc.connections.deploy(state.connectionId);
      if (r.ok) toast(r.demo ? 'Demo mode — no deployment needed.' : `Deployed to ${r.reportPath}.`, 'success', 5000);
      else toast(`Deploy failed: ${r.error}`, 'error', 7000);
    });
    cc.onMenu('menu:history', openHistory);
    cc.onMenu('menu:toggle-browser', () => {
      const b = $('#db-browser');
      b.classList.toggle('collapsed');
    });
    cc.onMenu('menu:toggle-minimap', () => {
      if (state.editor) {
        const on = state.editor.getOption(state.monaco.editor.EditorOption.minimap).enabled;
        state.editor.updateOptions({ minimap: { enabled: !on } });
      }
    });
    cc.onMenu('menu:find', () => state.editor && state.editor.getAction('actions.find').run());
    cc.onMenu('menu:settings', openHistory); // settings surfaced via history/settings modal
    cc.onMenu('menu:about', () =>
      toast('CloudConnect — Oracle Fusion SQL client. Runs queries via BI Publisher.', 'info', 6000)
    );

    // Background job lifecycle.
    cc.onJobStarted(({ jobId, tabId }) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (tab) tab.jobId = jobId;
    });
    cc.onJobCompleted(({ jobId, tabId, result }) => {
      updateJobChip(jobId, `Done: ${result.rowCount} rows`, 'done');
      const tab = state.tabs.find((t) => t.id === tabId);
      if (tab) tab.jobId = null;
      showResult(result, '(background job)');
      toast(`Background job completed — ${result.rowCount} rows.`, 'success', 5000);
    });
    cc.onJobFailed(({ jobId, tabId, error }) => {
      updateJobChip(jobId, 'Failed', 'failed');
      const tab = state.tabs.find((t) => t.id === tabId);
      if (tab) tab.jobId = null;
      toast(`Background job failed: ${error}`, 'error', 6000);
    });
  }

  function setupSplitters() {
    const vert = document.querySelector('.splitter');
    const browser = $('#db-browser');
    if (vert) {
      let dragging = false;
      vert.addEventListener('mousedown', () => {
        dragging = true;
        document.body.style.cursor = 'col-resize';
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const w = Math.min(560, Math.max(160, e.clientX));
        browser.style.width = `${w}px`;
      });
      window.addEventListener('mouseup', () => {
        dragging = false;
        document.body.style.cursor = '';
      });
    }
    const hsplit = document.querySelector('.hsplitter');
    const results = document.querySelector('.results');
    if (hsplit) {
      let dragging = false;
      hsplit.addEventListener('mousedown', () => {
        dragging = true;
        document.body.style.cursor = 'row-resize';
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const rect = document.querySelector('.workspace').getBoundingClientRect();
        const h = Math.min(rect.height - 140, Math.max(120, rect.bottom - e.clientY));
        results.style.height = `${h}px`;
      });
      window.addEventListener('mouseup', () => {
        dragging = false;
        document.body.style.cursor = '';
      });
    }
  }

  async function boot() {
    wireUi();
    try {
      const info = await cc.app.info();
      state.encryptionAvailable = info.encryptionAvailable;
    } catch {
      /* ignore */
    }
    try {
      const s = await cc.settings.get();
      state.settings = s;
      $('#max-rows').value = s.maxRows || 100;
    } catch {
      /* ignore */
    }
    await refreshConnections();
    // Auto-select first connection, or offer demo.
    if (state.connections.length) {
      state.connectionId = state.connections[0].id;
      $('#connection-select').value = state.connectionId;
      loadTree('');
    } else {
      setStatus('No connections yet. Open ⚙ to add one (or a demo connection).');
    }
  }

  // Expose the editor initializer for the Monaco loader in index.html.
  window.CloudConnect = { initEditor };

  // Boot once the DOM is ready (scripts are at end of body, so it is).
  boot();
})();
