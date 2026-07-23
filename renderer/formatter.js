'use strict';

/**
 * A pragmatic SQL formatter for the "Format SQL" action. It tokenizes the
 * statement (respecting string/quoted-identifier/comment boundaries) and lays
 * out major clauses on their own lines with consistent indentation. It is not a
 * full SQL parser — it aims for readable, predictable output on the SELECT-heavy
 * queries typical of Fusion reporting.
 */

(function (global) {
  const NEWLINE_BEFORE = [
    'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'UNION ALL',
    'UNION', 'INTERSECT', 'MINUS', 'CONNECT BY', 'START WITH', 'FETCH',
    'INSERT INTO', 'UPDATE', 'DELETE FROM', 'SET', 'VALUES', 'WITH',
  ];
  const NEWLINE_INDENT = ['AND', 'OR', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN', 'FULL JOIN', 'CROSS JOIN', 'JOIN', 'ON'];
  const KEYWORDS = new Set(
    (
      'SELECT FROM WHERE GROUP BY HAVING ORDER BY UNION ALL INTERSECT MINUS AND OR NOT IN ' +
      'IS NULL LIKE BETWEEN EXISTS JOIN INNER LEFT RIGHT FULL OUTER CROSS ON AS DISTINCT ' +
      'CASE WHEN THEN ELSE END ASC DESC COUNT SUM AVG MIN MAX OVER PARTITION BY FETCH FIRST ' +
      'ROWS ONLY WITH INSERT INTO UPDATE SET DELETE VALUES CONNECT START DUAL'
    ).split(/\s+/)
  );

  function tokenize(sql) {
    const tokens = [];
    let i = 0;
    const n = sql.length;
    while (i < n) {
      const ch = sql[i];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        i++;
        continue;
      }
      // line comment
      if (ch === '-' && sql[i + 1] === '-') {
        let j = i;
        while (j < n && sql[j] !== '\n') j++;
        tokens.push({ t: 'comment', v: sql.slice(i, j) });
        i = j;
        continue;
      }
      // block comment
      if (ch === '/' && sql[i + 1] === '*') {
        let j = i + 2;
        while (j < n && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
        j = Math.min(n, j + 2);
        tokens.push({ t: 'comment', v: sql.slice(i, j) });
        i = j;
        continue;
      }
      // string literal
      if (ch === "'") {
        let j = i + 1;
        while (j < n) {
          if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
          else if (sql[j] === "'") { j++; break; }
          else j++;
        }
        tokens.push({ t: 'string', v: sql.slice(i, j) });
        i = j;
        continue;
      }
      // quoted identifier
      if (ch === '"') {
        let j = i + 1;
        while (j < n && sql[j] !== '"') j++;
        j = Math.min(n, j + 1);
        tokens.push({ t: 'ident', v: sql.slice(i, j) });
        i = j;
        continue;
      }
      if (ch === '(' || ch === ')' || ch === ',' || ch === ';') {
        tokens.push({ t: 'punct', v: ch });
        i++;
        continue;
      }
      // operators
      if ('=<>!+-*/%|'.includes(ch)) {
        let j = i;
        while (j < n && '=<>!+-*/%|'.includes(sql[j])) j++;
        tokens.push({ t: 'op', v: sql.slice(i, j) });
        i = j;
        continue;
      }
      // word
      let j = i;
      while (j < n && /[A-Za-z0-9_$#.:&@]/.test(sql[j])) j++;
      if (j === i) { j++; } // safety for stray char
      const w = sql.slice(i, j);
      tokens.push({ t: KEYWORDS.has(w.toUpperCase()) ? 'kw' : 'word', v: w });
      i = j;
    }
    return tokens;
  }

  // Merge multi-word keywords like "GROUP BY", "ORDER BY", "LEFT JOIN".
  function mergeKeywords(tokens) {
    const pairs = {
      GROUP: ['BY'], ORDER: ['BY'], 'LEFT': ['JOIN', 'OUTER'], RIGHT: ['JOIN', 'OUTER'],
      INNER: ['JOIN'], FULL: ['JOIN', 'OUTER'], CROSS: ['JOIN'], UNION: ['ALL'],
      INSERT: ['INTO'], DELETE: ['FROM'], PARTITION: ['BY'], CONNECT: ['BY'], START: ['WITH'],
      FETCH: ['FIRST', 'NEXT'], OUTER: ['JOIN'],
    };
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const cur = tokens[i];
      if (cur.t === 'kw' && pairs[cur.v.toUpperCase()]) {
        const next = tokens[i + 1];
        if (next && next.t === 'kw' && pairs[cur.v.toUpperCase()].includes(next.v.toUpperCase())) {
          let merged = { t: 'kw', v: `${cur.v.toUpperCase()} ${next.v.toUpperCase()}` };
          i++;
          // handle LEFT OUTER JOIN
          const nn = tokens[i + 1];
          if (nn && nn.t === 'kw' && nn.v.toUpperCase() === 'JOIN' && /OUTER$/.test(merged.v)) {
            merged.v += ' JOIN';
            i++;
          }
          out.push(merged);
          continue;
        }
      }
      out.push(cur);
    }
    return out;
  }

  function format(sql, opts = {}) {
    const indentUnit = opts.indent || '  ';
    if (!sql || !sql.trim()) return sql;
    const tokens = mergeKeywords(tokenize(sql));
    let out = '';
    let depth = 0;
    let lineStarted = false;

    const pad = (extra = 0) => indentUnit.repeat(Math.max(0, depth + extra));
    const newline = (extra = 0) => {
      out = out.replace(/[ \t]+$/, '');
      out += '\n' + pad(extra);
      lineStarted = false;
    };

    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      const up = tk.v.toUpperCase();
      const prev = tokens[i - 1];

      if (tk.t === 'comment') {
        if (lineStarted) newline();
        out += tk.v;
        newline();
        continue;
      }
      if (tk.t === 'punct' && tk.v === '(') {
        out += '(';
        depth++;
        lineStarted = true;
        continue;
      }
      if (tk.t === 'punct' && tk.v === ')') {
        depth = Math.max(0, depth - 1);
        out = out.replace(/[ \t]+$/, '');
        out += ')';
        lineStarted = true;
        continue;
      }
      if (tk.t === 'punct' && tk.v === ',') {
        out = out.replace(/[ \t]+$/, '');
        out += ',';
        newline(1);
        continue;
      }
      if (tk.t === 'punct' && tk.v === ';') {
        out = out.replace(/[ \t]+$/, '');
        out += ';';
        newline();
        continue;
      }

      if (tk.t === 'kw' && NEWLINE_BEFORE.includes(up)) {
        if (out.trim()) newline();
        out += up + ' ';
        lineStarted = true;
        continue;
      }
      if (tk.t === 'kw' && NEWLINE_INDENT.includes(up)) {
        newline(1);
        out += up + ' ';
        lineStarted = true;
        continue;
      }

      // default: space-separated token
      if (lineStarted && !/[ (]$/.test(out) && !(prev && prev.t === 'punct' && prev.v === '(')) {
        out += ' ';
      }
      out += tk.t === 'kw' ? up : tk.v;
      lineStarted = true;
    }

    return out
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const api = { format, tokenize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SqlFormatter = api;
})(typeof window !== 'undefined' ? window : globalThis);
