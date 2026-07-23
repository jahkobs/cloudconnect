# CloudConnect

A desktop SQL client for **Oracle Fusion Cloud Applications** (ERP / SCM / HCM).
Write SQL against your Fusion environment, browse the schema, run queries in the
foreground or background, and export results to CSV or Excel — all from a native
desktop app.

CloudConnect is modeled on the SplashBI *SQL Connect* feature set and built with
Electron + the Monaco editor.

<p align="center"><img src="renderer/assets/icon.svg" width="128" alt="CloudConnect"></p>

## Why it works this way

Oracle Fusion SaaS does **not** expose its database on a network port, so you
cannot connect over JDBC/OCI. The supported path for running SQL is **Oracle
Analytics Publisher (BI Publisher)**, which ships inside every Fusion pod.
CloudConnect executes SQL through a small generic *SQL Runner* BI Publisher
report whose data model uses a lexical parameter (`&p_sql`). BI Publisher
substitutes that parameter into the data-model SQL before execution, which lets
an authorized user run arbitrary read queries and get the rows back as CSV.

See [`assets/report/README.md`](assets/report/README.md) for the report objects
and deployment details.

## Features

| Feature | Notes |
| --- | --- |
| **Oracle Fusion connectivity** | BI Publisher REST (v2 with v1 fallback) for query execution; SOAP `CatalogService` for one-click report deployment. |
| **SQL editor** | Monaco-powered: syntax highlighting, minimap, multi-cursor, find/replace. Falls back to a plain editor if Monaco isn't present. |
| **IntelliSense** | Keyword completion plus schema-aware table/column completion sourced from the DB Browser. |
| **Format SQL** | One-click pretty-printer that respects strings, comments, and quoted identifiers. |
| **DB Browser** | Searchable schema tree (owners → tables/views → columns) read from the Oracle data dictionary. Double-click a table to preview. |
| **Results grid** | Virtualized "pageless" scrolling for large result sets, in-grid search/filter, serial column, text selection & copy. |
| **Multi-result tabs** | Lock a result to keep it while you run another query — compare side by side. |
| **Background processing** | Run long queries in the background; a jobs tray and OS notification tell you when they finish. |
| **Data export** | Export the current (optionally filtered) result set to CSV or Excel `.xlsx`. |
| **Query history** | Every run is recorded (SQL, rows, timing, success/failure); click to reopen. |
| **Connection manager** | Multiple saved connections; passwords encrypted with the OS keychain via Electron `safeStorage`. |
| **Demo mode** | A synthetic Fusion schema (`PER_ALL_PEOPLE_F`, `AP_INVOICES_ALL`, `GL_JE_HEADERS`, …) so you can explore the whole app with no pod or credentials. |

## Getting started

```bash
npm install      # installs deps and vendors Monaco into renderer/vendor/monaco
npm start        # launch the desktop app
npm run dev      # launch with DevTools open
```

> **Note:** `npm start` needs the Electron runtime binary. In restricted/offline
> environments where the binary can't be downloaded, install with
> `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install` to get the source and run the
> test suite; download the binary on a machine with network access to launch the
> GUI.

### Connecting to a Fusion pod

1. Click **⚙** (or **Account → Manage Connections**) and **New connection**.
2. Enter:
   - **Pod URL** — e.g. `https://xxxx.fa.us2.oraclecloud.com`
   - **Username / Password** — a Fusion user with the `BIAuthor`/`BIConsumer`
     roles and read access to the schemas you query.
   - **Data Source** — `ApplicationDB_FSCM` (Financials/SCM),
     `ApplicationDB_HCM`, or `ApplicationDB_CRM`.
3. Click **Test**, then **Save**.
4. Click **Deploy SQL Runner** once per pod to upload the report objects
   (or deploy them manually — see `assets/report/`).
5. Pick the connection in the top-right selector and start querying.

Prefer to try it first? Add a **demo connection** from the connection manager —
no pod required.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Run query | `Ctrl/Cmd + Enter` |
| Run in background | `Ctrl/Cmd + Shift + Enter` |
| Cancel | `Ctrl/Cmd + .` |
| Format SQL | `Ctrl/Cmd + Shift + F` |
| New tab | `Ctrl/Cmd + T` |
| Toggle DB Browser | `Ctrl/Cmd + B` |
| Query history | `Ctrl/Cmd + H` |
| Export results | `Ctrl/Cmd + E` |
| Find in editor | `Ctrl/Cmd + F` |

## Architecture

```
electron/
  main.js            App lifecycle, window, native menu
  preload.js         contextIsolated IPC bridge (window.cc)
  ipc.js             IPC handlers — all network & disk I/O lives here
  store.js           Connection profiles + history; passwords via safeStorage
  export.js          CSV / XLSX writers (exceljs streaming)
  fusion/
    client.js        BI Publisher REST run + SOAP catalog deploy
    report.js        Generates the SQL Runner data model/report + zips
    parser.js        RFC-4180 CSV and BIP XML rowset parsers
    queries.js       Data-dictionary SQL for the DB Browser
    demo.js          Synthetic Fusion schema for demo mode
renderer/
  index.html         UI shell
  app.js             UI controller: tabs, jobs, tree, modals, wiring
  grid.js            Virtualized results grid
  formatter.js       SQL pretty-printer
  styles.css         Dark IDE theme
assets/report/       Raw BI Publisher SQL Runner objects (.xdm/.xdo)
```

The renderer has **no** direct Node, filesystem, or network access
(`contextIsolation: true`, `nodeIntegration: false`). Everything privileged is
brokered through the preload bridge to the main process.

## Security

- Passwords are encrypted at rest with the OS keychain (Keychain / libsecret /
  DPAPI) via Electron `safeStorage`; if unavailable, they are not persisted.
- The renderer runs under a strict Content-Security-Policy and cannot reach the
  network; external links open in the system browser.
- The SQL Runner report executes with the privileges of the Fusion data-source
  user — grant least privilege and rely on Fusion audit logging.

## Development

```bash
npm test         # run the unit test suite (parser, formatter, fusion, demo)
npm run lint     # syntax-check every source file
npm run make-icon # regenerate build/icon.png from scratch
```

## Packaging installers

Installers are built with [electron-builder](https://www.electron.build/). Each
installer can only be produced on (or for) its own platform — macOS `.dmg`
packaging requires macOS, and Windows `.exe` (NSIS) packaging requires Windows
or Wine — so the reliable, reproducible path is the **Release** GitHub Actions
workflow, which builds each target on its native runner.

### Via CI (recommended — produces Windows + macOS installers)

Push a version tag, or run the **Release** workflow manually from the Actions tab:

```bash
git tag v1.0.0
git push origin v1.0.0
```

`.github/workflows/release.yml` then builds in parallel:

| Runner | Artifacts |
| --- | --- |
| `macos-latest` | `CloudConnect-<ver>-mac-x64.dmg`, `-arm64.dmg` (+ `.zip`) |
| `windows-latest` | `CloudConnect-<ver>-win-x64.exe` (NSIS installer + portable) |
| `ubuntu-latest` | `CloudConnect-<ver>-linux-x86_64.AppImage`, `.deb` |

Artifacts are uploaded to the workflow run; a tag build also attaches them to a
GitHub Release. macOS builds are **unsigned** (no Apple Developer certificate in
CI) — to ship signed/notarized builds, add `CSC_LINK`, `CSC_KEY_PASSWORD`, and
notarization credentials as repository secrets.

### Locally (current platform only)

```bash
npm run dist         # build for the current OS
npm run dist:mac     # macOS only  (must run on macOS)
npm run dist:win     # Windows only (Windows, or Linux/macOS with Wine)
npm run dist:linux   # Linux only
npm run pack         # unpacked app (no installer) for quick testing
```

Output lands in `release/`. The app icon is generated from `build/icon.png`
(1024×1024); electron-builder converts it to `.icns` / `.ico` per platform.

## License

MIT
