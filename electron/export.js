'use strict';

/**
 * Result export to CSV and Excel (.xlsx). Runs in the main process so large
 * result sets are streamed to disk without going back through the renderer.
 */

const fs = require('fs');
const ExcelJS = require('exceljs');

function toCsv(columns, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(esc).join(',')];
  for (const row of rows) lines.push(row.map(esc).join(','));
  return lines.join('\r\n');
}

async function writeCsv(filePath, columns, rows) {
  await fs.promises.writeFile(filePath, '﻿' + toCsv(columns, rows), 'utf8');
  return filePath;
}

async function writeXlsx(filePath, columns, rows, sheetName = 'Results') {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: true });
  const ws = wb.addWorksheet(sheetName.slice(0, 31) || 'Results');
  const header = ws.addRow(columns);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E2A44' } };
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.commit();
  for (const row of rows) {
    ws.addRow(row.map((v) => (v === null || v === undefined ? '' : maybeNumber(v)))).commit();
  }
  // Reasonable column widths based on header length.
  ws.columns.forEach((col, i) => {
    col.width = Math.min(60, Math.max(12, String(columns[i] || '').length + 4));
  });
  ws.commit();
  await wb.commit();
  return filePath;
}

function maybeNumber(v) {
  if (typeof v !== 'string') return v;
  if (v.trim() === '') return v;
  // Keep leading-zero / oversized ids as text to avoid Excel corrupting them.
  if (/^-?\d+(\.\d+)?$/.test(v) && v.length < 15 && !/^0\d/.test(v)) return Number(v);
  return v;
}

module.exports = { toCsv, writeCsv, writeXlsx };
