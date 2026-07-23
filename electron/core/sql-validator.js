'use strict';

/**
 * Read-only SQL validation for Oracle Fusion connections (spec FR-007).
 *
 * Validation is performed by tokenizing the statement and analyzing the token
 * stream — NOT by naive substring/keyword matching. Strings, quoted
 * identifiers, and comments are recognized so that a literal like
 * `'DROP TABLE'` or a comment `-- delete` never trips the guard, and a real
 * `DROP` statement always does.
 *
 * Rules:
 *   - Exactly one statement is allowed (a single trailing ';' is tolerated).
 *     Stacked statements (`select 1; delete ...`) are rejected.
 *   - The leading keyword must be SELECT or WITH. A WITH clause must resolve to
 *     a SELECT (CTEs that wrap INSERT/UPDATE/DELETE are rejected).
 *   - Forbidden statement/keywords anywhere at the top level are rejected:
 *     INSERT UPDATE DELETE MERGE CREATE ALTER DROP TRUNCATE GRANT REVOKE
 *     BEGIN DECLARE CALL EXEC EXECUTE plus data-dictionary write paths.
 *   - Database links (`table@dblink`) are rejected.
 *   - PL/SQL anonymous blocks (BEGIN/DECLARE) are rejected.
 *
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string} [statementType]  'SELECT' | 'WITH'
 * @property {string} [error]
 * @property {string[]} bindParams       distinct bind parameters, e.g. [':P_START_DATE']
 */

const FORBIDDEN = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE', 'AUDIT', 'NOAUDIT',
  'BEGIN', 'DECLARE', 'CALL', 'EXEC', 'EXECUTE',
  'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'SET', 'LOCK', 'FLASHBACK', 'PURGE',
  'COMMENT', 'ANALYZE', 'EXPLAIN',
]);

// Tokenize into { t, v } where t ∈ word|string|ident|comment|punct|op|param|dblink
function tokenize(sql) {
  const tokens = [];
  const s = String(sql || '');
  const n = s.length;
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '-' && s[i + 1] === '-') {
      let j = i;
      while (j < n && s[j] !== '\n') j++;
      tokens.push({ t: 'comment', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(s[j] === '*' && s[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      tokens.push({ t: 'comment', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (s[j] === "'" && s[j + 1] === "'") j += 2;
        else if (s[j] === "'") {
          j++;
          break;
        } else j++;
      }
      tokens.push({ t: 'string', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') j++;
      j = Math.min(n, j + 1);
      tokens.push({ t: 'ident', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === ':' && /[A-Za-z_]/.test(s[i + 1] || '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(s[j])) j++;
      tokens.push({ t: 'param', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '@') {
      tokens.push({ t: 'dblink', v: '@' });
      i++;
      continue;
    }
    if (ch === ';' || ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ t: 'punct', v: ch });
      i++;
      continue;
    }
    if ('=<>!+-*/%|'.includes(ch)) {
      let j = i;
      while (j < n && '=<>!+-*/%|'.includes(s[j])) j++;
      tokens.push({ t: 'op', v: s.slice(i, j) });
      i = j;
      continue;
    }
    let j = i;
    while (j < n && /[A-Za-z0-9_$#.]/.test(s[j])) j++;
    if (j === i) {
      i++;
      continue;
    }
    tokens.push({ t: 'word', v: s.slice(i, j) });
    i = j;
  }
  return tokens;
}

function detectBindParams(sql) {
  const params = [];
  const seen = new Set();
  for (const tk of tokenize(sql)) {
    if (tk.t === 'param' && !seen.has(tk.v.toUpperCase())) {
      seen.add(tk.v.toUpperCase());
      params.push(tk.v);
    }
  }
  return params;
}

/**
 * @param {string} sql
 * @returns {ValidationResult}
 */
function validateReadOnly(sql) {
  const bindParams = detectBindParams(sql);
  const tokens = tokenize(sql).filter((t) => t.t !== 'comment');

  if (tokens.length === 0) {
    return { valid: false, error: 'Statement is empty.', bindParams };
  }

  // Reject database links.
  if (tokens.some((t) => t.t === 'dblink')) {
    return { valid: false, error: 'Database links (@dblink) are not permitted.', bindParams };
  }

  // Reject stacked statements: a ';' that is not the final token.
  const semiIdx = tokens.findIndex((t) => t.t === 'punct' && t.v === ';');
  if (semiIdx !== -1 && semiIdx !== tokens.length - 1) {
    return {
      valid: false,
      error: 'Multiple statements are not allowed. Run one SELECT at a time.',
      bindParams,
    };
  }

  const words = tokens.filter((t) => t.t === 'word');
  const lead = words[0] ? words[0].v.toUpperCase() : '';

  if (lead !== 'SELECT' && lead !== 'WITH') {
    return {
      valid: false,
      error: `Only read-only SELECT/WITH statements are allowed (found '${lead || tokens[0].v}').`,
      bindParams,
    };
  }

  // Scan every top-level word for a forbidden keyword. Because strings and
  // identifiers are separate token types, only real SQL keywords are checked.
  for (const w of words) {
    const up = w.v.toUpperCase();
    if (FORBIDDEN.has(up)) {
      return {
        valid: false,
        error: `Statement contains a non-read-only keyword: ${up}.`,
        bindParams,
      };
    }
  }

  // A WITH statement must contain a SELECT (a CTE resolving to a query).
  if (lead === 'WITH' && !words.some((w) => w.v.toUpperCase() === 'SELECT')) {
    return { valid: false, error: 'WITH clause must resolve to a SELECT.', bindParams };
  }

  return { valid: true, statementType: lead, bindParams };
}

module.exports = { validateReadOnly, detectBindParams, tokenize, FORBIDDEN };
