'use strict';

/**
 * Result export to CSV, Excel (.xlsx), JSON, and XML. Runs in the main process
 * so large result sets are written straight to disk. Optional metadata (query,
 * connection, environment, row count, user) can be embedded per spec FR-011.
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

function rowsToObjects(columns, rows) {
  return rows.map((row) => {
    const o = {};
    columns.forEach((c, i) => (o[c] = row[i] === undefined ? null : row[i]));
    return o;
  });
}

async function writeJson(filePath, columns, rows, meta) {
  const payload = meta ? { meta, columns, data: rowsToObjects(columns, rows) } : rowsToObjects(columns, rows);
  await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function writeXml(filePath, columns, rows, meta) {
  const safeTag = (c) => c.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1');
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<resultset>'];
  if (meta) {
    parts.push('  <meta>');
    for (const [k, v] of Object.entries(meta)) parts.push(`    <${safeTag(k)}>${xmlEscape(v)}</${safeTag(k)}>`);
    parts.push('  </meta>');
  }
  for (const row of rows) {
    parts.push('  <row>');
    columns.forEach((c, i) => {
      const v = row[i];
      parts.push(`    <${safeTag(c)}>${v == null ? '' : xmlEscape(v)}</${safeTag(c)}>`);
    });
    parts.push('  </row>');
  }
  parts.push('</resultset>');
  await fs.promises.writeFile(filePath, parts.join('\n'), 'utf8');
  return filePath;
}

module.exports = { toCsv, writeCsv, writeXlsx, writeJson, writeXml };
