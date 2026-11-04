#!/usr/bin/env bash
# Read-only probe of the live Folder Watch panel in Premiere (layout and computed styles).
# Runs scripts/probe-panel.js with Windows node.exe, because WSL NAT cannot reach the Windows
# loopback UDT service. Reloads the deployed plugin first; run `npm run dev:windows` before it.
# Usage: scripts/probe-windows.sh [destination] [--eval "<expression>"]
# Env: FOLDER_WATCH_WIN_DIR, UDT_PORT (default 14001)
# Exit codes: 0 ok / 2 prerequisite missing / 3 probe failed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${FOLDER_WATCH_WIN_DIR:-/mnt/c/Tools/PremiereFolderWatch}"
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --eval) EXTRA=(--eval "${2:-}"); shift 2;;
    *) DEST="$1"; shift;;
  esac
done
PORT="${UDT_PORT:-14001}"

prereq() { echo "probe: PREREQUISITE MISSING: $*" >&2; exit 2; }

command -v wslpath >/dev/null 2>&1 || prereq "wslpath not found; this script must run inside WSL"
NODE_EXE="$(command -v node.exe || true)"
[ -z "$NODE_EXE" ] && [ -x "/mnt/c/Program Files/nodejs/node.exe" ] && NODE_EXE="/mnt/c/Program Files/nodejs/node.exe"
[ -n "$NODE_EXE" ] || prereq "Windows Node.js (node.exe) not found. Install Node 22+ on Windows."
[ -f "$DEST/manifest.json" ] || prereq "no deployed manifest at $DEST. Run: npm run deploy:windows"

WIN_DIR="$(wslpath -w "$DEST")"
WIN_PROBE="$(wslpath -w "$ROOT/scripts/probe-panel.js")"

# Run from a Windows drive: node rejects UNC working directories.
cd /mnt/c || prereq "/mnt/c is not available"
UDT_PORT="$PORT" WSLENV="${WSLENV:-}:UDT_PORT" "$NODE_EXE" "$WIN_PROBE" "$WIN_DIR" "${EXTRA[@]}"
