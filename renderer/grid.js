'use strict';

/**
 * DataGrid — a lightweight virtualized table for large result sets ("pageless
 * scrolling"). Only the visible slice of rows is rendered to the DOM, so a
 * result of hundreds of thousands of rows scrolls smoothly. Supports live text
 * filtering, a serial (#) column, cell selection, and copy.
 */

(function (global) {
  const ROW_HEIGHT = 26;
  const OVERSCAN = 8;

  class DataGrid {
    constructor(container) {
      this.container = container;
      this.columns = [];
      this.rows = [];
      this.filtered = null; // indexes into rows when a filter is active
      this.filterText = '';
      this._build();
      this._onScroll = this._render.bind(this);
      this.viewport.addEventListener('scroll', this._onScroll, { passive: true });
    }

    _build() {
      this.container.innerHTML = '';
      this.container.classList.add('grid-root');

      this.headerEl = document.createElement('div');
      this.headerEl.className = 'grid-header';

      this.viewport = document.createElement('div');
      this.viewport.className = 'grid-viewport';

      this.spacer = document.createElement('div');
      this.spacer.className = 'grid-spacer';

      this.body = document.createElement('div');
      this.body.className = 'grid-body';

      this.spacer.appendChild(this.body);
      this.viewport.appendChild(this.spacer);
      this.container.appendChild(this.headerEl);
      this.container.appendChild(this.viewport);
    }

    setData(columns, rows) {
      this.columns = columns || [];
      this.rows = rows || [];
      this.filtered = null;
      this.filterText = '';
      this.viewport.scrollTop = 0;
      this._renderHeader();
      this._render();
    }

    setFilter(text) {
      this.filterText = (text || '').toLowerCase();
      if (!this.filterText) {
        this.filtered = null;
      } else {
        const t = this.filterText;
        this.filtered = [];
        for (let i = 0; i < this.rows.length; i++) {
          const row = this.rows[i];
          for (let c = 0; c < row.length; c++) {
            const v = row[c];
            if (v != null && String(v).toLowerCase().includes(t)) {
              this.filtered.push(i);
              break;
            }
          }
        }
      }
      this.viewport.scrollTop = 0;
      this._render();
    }

    get visibleCount() {
      return this.filtered ? this.filtered.length : this.rows.length;
    }

    _colWidth(idx) {
      const name = this.columns[idx] || '';
      // Sample a few rows to estimate width.
      let max = name.length;
      const sample = Math.min(this.rows.length, 40);
      for (let i = 0; i < sample; i++) {
        const v = this.rows[i][idx];
        if (v != null) max = Math.max(max, String(v).length);
      }
      return Math.min(360, Math.max(70, max * 8 + 24));
    }

    _renderHeader() {
      this.headerEl.innerHTML = '';
      this._widths = [40, ...this.columns.map((_, i) => this._colWidth(i))];
      const total = this._widths.reduce((a, b) => a + b, 0);
      this.headerEl.style.width = `${total}px`;
      this.spacer.style.width = `${total}px`;

      const mkCell = (text, w, cls) => {
        const d = document.createElement('div');
        d.className = `grid-cell ${cls || ''}`;
        d.style.width = `${w}px`;
        d.textContent = text;
        d.title = text;
        return d;
      };
      this.headerEl.appendChild(mkCell('#', this._widths[0], 'grid-serial grid-th'));
      this.columns.forEach((c, i) => this.headerEl.appendChild(mkCell(c, this._widths[i + 1], 'grid-th')));
    }

    _render() {
      const count = this.visibleCount;
      const totalHeight = count * ROW_HEIGHT;
      this.spacer.style.height = `${totalHeight}px`;

      const scrollTop = this.viewport.scrollTop;
      const viewH = this.viewport.clientHeight || 400;
      let start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
      let end = Math.min(count, Math.ceil((scrollTop + viewH) / ROW_HEIGHT) + OVERSCAN);

      this.body.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
      this.body.innerHTML = '';

      const frag = document.createDocumentFragment();
      for (let vi = start; vi < end; vi++) {
        const rowIdx = this.filtered ? this.filtered[vi] : vi;
        const row = this.rows[rowIdx];
        if (!row) continue;
        const tr = document.createElement('div');
        tr.className = 'grid-row' + (vi % 2 ? ' odd' : '');
        tr.style.height = `${ROW_HEIGHT}px`;

        const serial = document.createElement('div');
        serial.className = 'grid-cell grid-serial';
        serial.style.width = `${this._widths[0]}px`;
        serial.textContent = String(vi + 1);
        tr.appendChild(serial);

        for (let c = 0; c < this.columns.length; c++) {
          const cell = document.createElement('div');
          cell.className = 'grid-cell';
          cell.style.width = `${this._widths[c + 1]}px`;
          const v = row[c];
          if (v === null || v === undefined) {
            cell.innerHTML = '<span class="grid-null">(null)</span>';
          } else {
            cell.textContent = v;
            cell.title = v;
          }
          if (this.filterText && v != null && String(v).toLowerCase().includes(this.filterText)) {
            cell.classList.add('grid-match');
          }
          tr.appendChild(cell);
        }
        frag.appendChild(tr);
      }
      this.body.appendChild(frag);
    }

    getExportData() {
      const rows = this.filtered ? this.filtered.map((i) => this.rows[i]) : this.rows;
      return { columns: this.columns, rows };
    }
  }

  global.DataGrid = DataGrid;
})(window);
