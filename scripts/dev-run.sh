#!/usr/bin/env bash
set -Eeuo pipefail
uuid=shutterguard@singletonmail.com
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
    echo '[ShutterGuard dev] disabling extension'
    gnome-extensions disable "$uuid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "$project_dir"
echo '[ShutterGuard dev] building and installing'
make install-dev
if ! gnome-extensions info "$uuid" >/dev/null 2>&1; then
    echo '[ShutterGuard dev] installed successfully, but this GNOME Shell session has not discovered the new extension yet.' >&2
    echo '[ShutterGuard dev] Log out and back in once, then run this command again.' >&2
    exit 1
fi
installed_version="$(sed -n 's/.*"version": \([0-9][0-9]*\).*/\1/p' metadata.json)"
registered_version="$(gnome-extensions info "$uuid" | sed -n 's/^  Version: //p')"
if [[ -n "$installed_version" && "$registered_version" != "$installed_version" ]]; then
    echo "[ShutterGuard dev] GNOME Shell still has version ${registered_version:-unknown} cached; version $installed_version is installed." >&2
    echo '[ShutterGuard dev] Log out and back in once, then run this command again.' >&2
    exit 1
fi
echo '[ShutterGuard dev] enabling extension'
gnome-extensions enable "$uuid"
echo '[ShutterGuard dev] following GNOME Shell logs; press Ctrl-C to remove the extension'
journalctl --user -f -o cat | grep --line-buffered -E 'ShutterGuard|shutterguard' || true
