'use strict';

/**
 * Metadata SQL used by the Database Browser. These run through the same SQL
 * Runner report as user queries, reading Oracle's data-dictionary views.
 * ACCESSIBLE_* / ALL_* views are used so results respect the connected user's
 * granted privileges.
 */

function listTables(filter) {
  const where = filter
    ? `WHERE (UPPER(table_name) LIKE UPPER('%' || :f || '%') OR UPPER(owner) LIKE UPPER('%' || :f || '%'))`
    : '';
  // Bind not supported through the lexical runner, so inline-escape instead.
  const f = filter ? String(filter).replace(/'/g, "''") : '';
  const cond = filter
    ? `WHERE (UPPER(table_name) LIKE UPPER('%${f}%') OR UPPER(owner) LIKE UPPER('%${f}%'))`
    : '';
  void where;
  return `SELECT owner, table_name, 'TABLE' AS object_type
            FROM all_tables ${cond}
           UNION ALL
          SELECT owner, view_name AS table_name, 'VIEW' AS object_type
            FROM all_views ${cond ? cond.replace('table_name', 'view_name') : ''}
        ORDER BY owner, table_name
       FETCH FIRST 500 ROWS ONLY`;
}

function listColumns(owner, table) {
  const o = String(owner).replace(/'/g, "''");
  const t = String(table).replace(/'/g, "''");
  return `SELECT column_id, column_name, data_type,
                 data_length, nullable
            FROM all_tab_columns
           WHERE owner = '${o}' AND table_name = '${t}'
        ORDER BY column_id`;
}

function previewTable(owner, table, limit = 100) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9_$#]/g, '');
  return `SELECT * FROM ${safe(owner)}.${safe(table)} FETCH FIRST ${Number(limit) || 100} ROWS ONLY`;
}

module.exports = { listTables, listColumns, previewTable };
