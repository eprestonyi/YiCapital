# xlsx-js-style 1.2.0

Vendored from the npm registry tarball for `xlsx-js-style@1.2.0` so the
administrator ledger never executes a runtime CDN script.

Security boundary: the main admin page uses this vendored bundle only for
generating Excel exports and preserving layout from fixed, same-origin
templates. External workbooks are parsed only by the disposable
`yc-xlsx-import-worker.js` boundary. That worker preflights the ZIP expansion,
rejects macros, external links, embedded objects, formulas and oversized
sheets, removes network/storage capabilities before parsing, returns only the
seven allowlisted event-sheet matrices plus `_YiSync`, and is terminated after
one response or 15 seconds. Never call `XLSX.read` on the main admin page.

- Registry integrity: `sha512-DDT4FXFSWfT4DXMSok/m3TvmP1gvO3dn0Eu/c+eXHW5Kzmp7IczNkxg/iEPnImbG9X0Vb8QhROda5eatSR/97Q==`
- `xlsx.min.js` SHA-384: `4cacdd631abfb7d5292eb25c210bb68697d083ea12a0954392159c4b8ceecd09b3413071e6048c8483570f6b86bf48f0`
- License: Apache-2.0 (see `LICENSE`)
