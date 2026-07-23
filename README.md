# FusionQuery Studio

A secure desktop SQL & data-access platform for **Oracle Fusion Cloud** (ERP /
HCM / SCM / Procurement / CX) and **Oracle Autonomous Database** (ADW / ATP).
Write governed, read-only SQL against Fusion reporting data through approved BI
Publisher services, browse schema, run and export results, draft SQL from plain
English, and keep a tamper-evident audit trail.

<p align="center"><img src="renderer/assets/icon.svg" width="120" alt="FusionQuery Studio"></p>

> **v2.0** — a ground-up rebuild with a new multi-panel IDE shell and a
> connector/gateway architecture. Built with Electron; verified headlessly and
> shipped as a Windows installer.

## Why a gateway, not a database connection

Oracle Fusion Cloud **must not** be treated as a normal Oracle database — there
is no host/port/JDBC/ODBC/wallet path to the transactional DB. FusionQuery
Studio routes every query through a **Secure Query Gateway** seam that:

1. resolves the connection and picks the right **connector**,
2. enforces **read-only SQL** with a parser-based validator (blocks
   INSERT/UPDATE/DELETE/DDL/PLSQL/db-links/stacked statements),
3. applies the connection's **row limit** and **timeout**,
4. records a **tamper-evident audit** event for every execute / reject / export,
5. returns a uniform result with execution metadata.

Today the gateway runs in-process ("direct mode"); the same surface can later
proxy to an organisation's ASP.NET Core gateway without changing the client.

## Connectors

| Type | Purpose | Status |
| --- | --- | --- |
| **Fusion BI Publisher** | Read-only SQL against Fusion reporting data via the protected report services + CatalogService | ✅ core |
| **Demo** | Synthetic Fusion schema — explore the whole app with no pod | ✅ core |
| **Oracle ADW / ATP** | Direct read-only SQL over TLS/wallet (uses node-oracledb when provisioned) | ⚙ scaffold |
| **Fusion REST** | OAuth2 resource queries | ⚙ scaffold |
| **Oracle BICC** | Bulk / incremental extraction (gateway-backed) | ⚙ scaffold |

## Features (this release)

- **Multi-panel IDE** — activity bar → Connections, Schema Browser, Query
  Library, History, AI Assistant, Audit Log.
- **Connection manager** — multiple types & environments (DEV/TEST/UAT/PROD),
  clone/disable/delete, test, and a permanent **production warning banner** with
  a framed window when a PROD connection is active.
- **Native SQL editor** — line-number gutter, tab-indent, run / run-selection /
  format, multiple tabs, live read-only validation and **bind-parameter
  detection** with a value prompt before execution.
- **Read-only enforcement** — parser-based (`electron/core/sql-validator.js`),
  not keyword matching; safe against keywords hidden in strings/comments.
- **Result grid** — virtualized scrolling, in-grid search, lockable multi-result
  tabs, execution metadata (rows, environment, connection, params, truncation).
- **Export** — CSV, Excel, JSON, XML (with optional query/connection metadata).
- **Query library** — save/organize queries by module, tags, status, version.
- **AI SQL Assistant** — plain-English → **draft** read-only SQL grounded only
  in the connection's cached metadata; never auto-executes, always review-first,
  offline heuristic provider by default (no business data leaves the machine).
- **Tamper-evident audit** — hash-chained JSONL log with a chain-verify view;
  secrets are redacted and never logged.
- **Credential security** — secrets encrypted with the OS keychain
  (Keychain / libsecret / DPAPI) via Electron `safeStorage`; never in plain text.
- **Background execution**, notifications, connection status bar + progress.

Phase 2 (scaffolded / planned): Git integration, query approval workflow, REST
query designer, BICC extraction manager, advanced IntelliSense, result
comparison, automated Oracle quarterly-update tests.

## Architecture

```
electron/
  main.js                 App lifecycle, native menu, wiring
  preload.js              contextIsolated bridge (window.fqs)
  ipc.js                  IPC surface — all privileged work
  core/
    sql-validator.js      Parser-based read-only validation + bind detection
    store.js              Connections / library / history / settings (encrypted)
    audit.js              Hash-chained tamper-evident audit log
    ai.js                 NL→SQL assistant (pluggable, offline default)
  gateway/gateway.js      Governance choke point → connectors
  connectors/
    fusion-bip.js  demo.js  adw.js  fusion-rest.js  bicc.js
  fusion/                 BI Publisher client, report archive, CSV/XML parsers
  export.js               CSV / Excel / JSON / XML writers
renderer/
  index.html  app.js  styles.css   IDE shell
  grid.js  formatter.js             Virtualized grid + SQL formatter
```

The renderer has no direct Node/filesystem/network access (`contextIsolation`,
no `nodeIntegration`, strict CSP); everything privileged goes through the
gateway in the main process.

## Getting started

```bash
npm install
npm start           # launch the app
npm test            # unit tests (validator, audit chain, AI, parsers, formatter)
npm run lint        # syntax-check every source file
```

Try it instantly: **⚙ New connection** isn't needed — open the **Connections**
panel and click **＋ Add demo connection**, then run the sample query.

### Connecting to a Fusion pod

1. Connections panel → **New connection** → type **Oracle Fusion — BI Publisher**.
2. Set pod URL, username/password (a user with BI Publisher roles), data source,
   environment. Mark PROD if applicable.
3. **Deploy SQL Runner** once per pod, then **Test**.
4. Select it and run read-only SQL.

## Packaging (Windows / macOS / Linux)

Installers build on native runners via GitHub Actions:

```bash
git tag v2.0.0 && git push origin v2.0.0   # or run the Release workflow
```

Produces `FusionQuery Studio-<ver>-win-x64.exe` (NSIS + portable), macOS
`.dmg`, and Linux `.AppImage`/`.deb`, attached to a GitHub Release. macOS builds
are unsigned unless signing secrets are configured.

## License

MIT
