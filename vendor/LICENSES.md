# Third-party files in vendor/

| Files | Project | Licence |
|---|---|---|
| `pyodide/*` | Pyodide 0.27.7 (CPython 3.12 compiled to WebAssembly), https://github.com/pyodide/pyodide | MPL-2.0 (CPython: PSF License) |
| `wheels/networkx-3.4.2-py3-none-any.whl` | NetworkX, https://networkx.org | BSD-3-Clause |
| `wheels/beautifulsoup4-4.12.3-py3-none-any.whl` | Beautiful Soup, https://www.crummy.com/software/BeautifulSoup/ | MIT |
| `wheels/soupsieve-2.5-py3-none-any.whl` | Soup Sieve, https://github.com/facelessuser/soupsieve | MIT |
| `wheels/sqlite3-1.0.0-cp312-cp312-pyodide_2024_0_wasm32.whl` | Python `sqlite3` module + SQLite, built by Pyodide | PSF License / public domain |

Unmodified copies from the official Pyodide 0.27.7 release (github.com/pyodide/pyodide/releases).
To upgrade, replace these files with a newer release and update the version strings in `worker.js`
(wheel file names), `sw.js` (`VENDOR` cache name) and `app.js` (`APP_VERSION` text).
