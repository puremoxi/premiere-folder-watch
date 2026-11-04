# Development Workflow (WSL to Windows)

Optional workflow for developing in WSL while testing in Premiere Pro on Windows.
The WSL repository is the single source of truth. The Windows folder is a disposable
copy of the runtime files only, not a Git repository.

```
edit (WSL) -> npm test / check -> deploy to Windows -> UDT load -> test in Premiere
```

## Setup

Ubuntu/WSL: Node.js 20+, `npm`, `bash`. Windows: Node.js 20+ (`node.exe`),
Adobe UXP Developer Tool 2.2+, Premiere Pro 25.6+ with Developer Mode enabled.

WSL in the default NAT networking mode cannot reach `127.0.0.1` on Windows, so
`load-via-udt.js` is run by Windows `node.exe` (through WSL interop).

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Node unit tests |
| `npm run validate` | Same as `npm run check` (syntax, version, manifest, tests) |
| `npm run deploy:windows [dest]` | Validate, then copy runtime files to Windows |
| `npm run load:windows [dest]` | Validate and load the deployed plugin via UDT |
| `npm run dev:windows [dest]` | Validate, deploy, then attempt load; stages reported separately |
| `npm run probe:windows [dest] [--eval "<js>"]` | Read-only probe of the live panel: layout rectangles and key computed styles (needs Windows Node 22+) |
| `npm run package` | Build the `.ccx` release archive |

Destination: argument, else `FOLDER_WATCH_WIN_DIR`, else `/mnt/c/Tools/PremiereFolderWatch`.
`UDT_PORT` overrides the UDT service port (default 14001).

The file list is read from `scripts/package.js`. Deployment only creates or overwrites
those files in the destination and never deletes anything.

Exit codes: `deploy` 0 ok / 1 failed. `load` 0 loaded / 2 prerequisite missing / 3 UDT validation or load failed.
`dev:windows` returns the first failing stage's code.

First-time UDT setup: with Premiere running, open UDT, Add Plugin, select
`C:\Tools\PremiereFolderWatch\manifest.json`, Load. After each deploy, run
`npm run load:windows` or click Reload in UDT.

## Probing the live panel

`npm run probe:windows` reloads the deployed plugin, attaches to its UDT debug session and prints
layout rectangles and computed styles for the main controls. It is read-only: it never changes the
project, the DOM or files. Keep the Folder Watch panel visible while it runs, and close any other
debugger attached to the plugin. Pass `--eval "<expression>"` to evaluate your own expression instead.
UXP reports 0x0 rectangles until about 800 ms after a DOM change and ignores `position: fixed`, so
measurements are taken after a short wait. A probe confirms layout numbers, not how the panel looks.

## Testing boundaries

- **A, automated in WSL:** `npm test`, `npm run check`, `npm run package`, deploy script test.
- **B, UDT:** `load:windows` runs UDT's validate and load. It confirms the manifest validates and the plugin loads, nothing more.
- **C, Premiere UI, manual:** scrolling, collapse/expand, docked/floating, folder selection, saving, bin sync. Loading successfully is **not** a pass for these.

Use disposable projects and media only.

### Smoke test
1. Panel appears in Window > Extensions and opens docked and floating.
2. Panel content scrolls at a short height; Save is reachable.
3. Global settings collapse and expand; values persist.
4. Add a folder, save, cancel an edit (no change persisted).
5. Sync a disposable folder; bins match; source files untouched.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `cannot create ...` | `/mnt/c` not mounted or no permission; pass another destination |
| `node.exe not found` / interop errors | Install Windows Node; ensure `[interop] enabled=true` in `/etc/wsl.conf` |
| `ECONNREFUSED 127.0.0.1:14001` | UDT not running, or a different port (`UDT_PORT`) |
| `Premiere is not connected` | Start Premiere; enable Developer Mode; wait for it to appear in UDT |
| Validation error | Fix the manifest error shown in the output or UDT |
| Plugin missing in Premiere | Load it in UDT; check the host version meets `minVersion` |
| Old behavior after edit | Redeploy and Reload; confirm `cmp` passed and UDT points at the deployed path |

## Future UI automation
Each stage is independently callable with reliable exit codes, so a Windows test runner can invoke them. Any such automation must use disposable projects and media only.
