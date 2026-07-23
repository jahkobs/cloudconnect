'use strict';

/**
 * Editor bootstrap. This MUST be an external script (not inline in index.html):
 * the app's Content-Security-Policy uses `script-src 'self'` without
 * 'unsafe-inline', which blocks inline <script> blocks and inline event
 * handlers. An earlier inline version was silently blocked by the CSP, so
 * initEditor() was never called and the editor pane stayed blank.
 *
 * Responsibilities:
 *   - Configure Monaco's worker URL (workers can't load from file:// in asar).
 *   - Load Monaco via its AMD loader, falling back to the plain editor if the
 *     loader is missing, errors, or hangs.
 */

(function () {
  // Monaco language services run in Web Workers, which fail to load from a
  // file:// URL inside an asar archive. Point the worker URL at an empty
  // data: script so the editor renders on the main thread.
  self.MonacoEnvironment = {
    getWorkerUrl: function () {
      return 'data:text/javascript;charset=utf-8,';
    },
  };

  function init(monaco) {
    if (window.CloudConnect && typeof window.CloudConnect.initEditor === 'function') {
      window.CloudConnect.initEditor(monaco);
    }
  }

  // Safety net: whatever happens with Monaco, the user must get an editor.
  // If nothing initializes within 4s, fall back to the plain editor.
  var settled = false;
  function done(monaco) {
    if (settled) return;
    settled = true;
    clearTimeout(fallbackTimer);
    init(monaco);
  }
  var fallbackTimer = setTimeout(function () {
    done(null);
  }, 4000);

  if (typeof require === 'undefined') {
    // Monaco's AMD loader (loader.js) did not load — use the plain editor.
    done(null);
    return;
  }

  try {
    require.config({ paths: { vs: 'vendor/monaco/vs' } });
    require(
      ['vs/editor/editor.main'],
      function () {
        done(window.monaco);
      },
      function () {
        done(null);
      }
    );
  } catch (e) {
    done(null);
  }
})();
