# qlh-shell

Standalone Web/Desktop shell and optional Textual shell for QLH.

This repository owns `frontend_cybergothic`, its tests, public assets, the API
gap scanner, and the optional `.venv-tui` environment. It consumes the QLH
core service from the sibling `qlh` repository and does not own model weights,
inference engines, or image generation.

## Web shell

```text
cd frontend_cybergothic
npm ci
npm run typecheck
npm run build
```

Set `QLH_CORE_ROOT` to the local QLH core checkout when running the API gap
scanner or cross-repository defense checks.

The canonical remote is `https://github.com/SgfKrc/qlh-shell.git`. This
checkout is the local migration baseline.
