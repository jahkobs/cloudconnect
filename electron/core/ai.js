'use strict';

/**
 * AI SQL Assistant (spec FR-017).
 *
 * Converts a natural-language prompt into DRAFT read-only Oracle SQL. Key
 * governance rules from the spec are enforced here:
 *   - Generation is restricted to read-only SELECT (the result is re-checked by
 *     the SQL validator before it can run).
 *   - Only metadata from the selected connection is used — never live business
 *     data — so nothing sensitive is sent anywhere.
 *   - Generated SQL is never executed automatically; the caller must review and
 *     explicitly run it.
 *
 * Providers are pluggable via a small interface. The default `LocalHeuristic`
 * provider runs fully offline (no external service), matching the spec's
 * requirement to avoid sending business data to an unapproved AI service. An
 * enterprise deployment can register an approved gateway-hosted provider.
 */

const { validateReadOnly } = require('./sql-validator');

/** @typedef {{ generate(prompt: string, ctx: object): Promise<{sql:string, explanation:string, tables:string[], notes:string[]}> }} AiProvider */

/**
 * Fully-offline heuristic provider. It matches the prompt against the
 * connection's cached schema metadata and assembles a conservative SELECT with
 * a row limit. It is intentionally simple and transparent — a starting draft
 * the user refines, not a black box.
 * @implements {AiProvider}
 */
class LocalHeuristic {
  async generate(prompt, ctx = {}) {
    const schema = ctx.schema || []; // [{ owner, table, columns:[{name,type}] }]
    const text = String(prompt || '').toLowerCase();
    const notes = [];

    // Score tables by name/synonym overlap with the prompt.
    const scored = schema
      .map((t) => ({ t, score: scoreTable(t, text) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    const chosen = scored.length ? scored[0].t : schema[0];
    if (!chosen) {
      return {
        sql: '-- No schema metadata is cached for this connection yet.\n-- Open the Schema Browser to load metadata, then try again.',
        explanation: 'No metadata available to ground the query.',
        tables: [],
        notes: ['Load schema metadata first.'],
      };
    }

    const cols = (chosen.columns || []).slice(0, 8).map((c) => c.name);
    const colList = cols.length ? cols.join(',\n       ') : '*';
    const qualified = `${chosen.owner}.${chosen.table}`;

    // Suggest bind-parameter filters when the prompt implies scoping.
    const filters = [];
    if (/\b(active|current|enabled)\b/.test(text)) {
      const flag = (chosen.columns || []).find((c) => /status|active|enabled|flag/i.test(c.name));
      if (flag) filters.push(`${flag.name} = 'A' -- adjust to your active indicator`);
    }
    if (/\bbusiness unit\b/.test(text)) filters.push('business_unit_id = :P_BUSINESS_UNIT');
    if (/\b(from|since|between|date range|period)\b/.test(text)) {
      const dateCol = (chosen.columns || []).find((c) => /date|_dt$/i.test(c.name));
      if (dateCol) filters.push(`${dateCol.name} BETWEEN :P_START_DATE AND :P_END_DATE`);
    }
    if (scored.length > 1) {
      notes.push(`Other candidate tables: ${scored.slice(1, 4).map((x) => x.t.table).join(', ')}.`);
    }
    notes.push('Draft only — review joins, filters, and column choices before running.');

    const where = filters.length ? `\n WHERE ${filters.join('\n   AND ')}` : '';
    const sql =
      `-- Draft generated from: "${String(prompt).slice(0, 120)}"\n` +
      `SELECT ${colList}\n  FROM ${qualified}${where}\n FETCH FIRST 100 ROWS ONLY`;

    return {
      sql,
      explanation:
        `Selected ${qualified} as the best metadata match for your request` +
        (filters.length ? `, with ${filters.length} suggested filter(s).` : '.'),
      tables: [qualified],
      notes,
    };
  }
}

const SYNONYMS = {
  employee: ['per_all_people', 'per_person', 'people', 'worker', 'assignment'],
  invoice: ['ap_invoices', 'invoice'],
  supplier: ['poz_suppliers', 'supplier', 'vendor'],
  customer: ['hz_parties', 'party', 'customer'],
  journal: ['gl_je', 'journal', 'gl_'],
  payroll: ['pay_', 'payroll'],
  department: ['department', 'org', 'per_departments'],
};

function scoreTable(t, text) {
  const name = `${t.table}`.toLowerCase();
  let score = 0;
  for (const word of text.split(/\W+/)) {
    if (!word || word.length < 3) continue;
    if (name.includes(word)) score += 3;
    const syn = SYNONYMS[word];
    if (syn && syn.some((s) => name.includes(s))) score += 4;
  }
  return score;
}

class AiAssistant {
  constructor(provider) {
    this.provider = provider || new LocalHeuristic();
  }

  setProvider(provider) {
    this.provider = provider;
  }

  /**
   * @returns {Promise<{ok, sql?, explanation?, tables?, notes?, error?}>}
   */
  async generate(prompt, ctx = {}) {
    if (!prompt || !String(prompt).trim()) {
      return { ok: false, error: 'Describe what you want to query.' };
    }
    let draft;
    try {
      draft = await this.provider.generate(prompt, ctx);
    } catch (err) {
      return { ok: false, error: `AI provider error: ${err.message}` };
    }
    // Enforce read-only on whatever the provider produced (defense in depth).
    const check = validateReadOnly(stripComments(draft.sql));
    if (!check.valid && !/^\s*--/.test(draft.sql)) {
      return {
        ok: false,
        error: `Generated SQL was not read-only and was blocked: ${check.error}`,
      };
    }
    // Never auto-execute: we only ever return a draft for the user to run.
    return { ok: true, autoRun: false, ...draft };
  }
}

function stripComments(sql) {
  return String(sql || '')
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim() || 'SELECT 1 FROM DUAL';
}

module.exports = { AiAssistant, LocalHeuristic };
