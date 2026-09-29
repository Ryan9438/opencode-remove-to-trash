#!/usr/bin/env bash
set -euo pipefail

REPO="${RM_TO_TRASH_REPO:-Ryan9438/opencode-remove-to-trash}"
BRANCH="${RM_TO_TRASH_BRANCH:-main}"
FILE="rm-to-trash.ts"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="${CONFIG_DIR}/plugins"
DEST="${PLUGIN_DIR}/${FILE}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$1" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required but was not found"

info "Installing opencode-remove-to-trash"
mkdir -p "$PLUGIN_DIR"
info "Downloading ${FILE} -> ${DEST}"
curl -fsSL "$RAW" -o "$DEST" || die "download failed: ${RAW}"

have_backend() {
  command -v trash >/dev/null 2>&1 ||
    command -v trash-put >/dev/null 2>&1 ||
    [ -x /usr/bin/trash ] ||
    [ -x /opt/homebrew/bin/trash ] ||
    command -v gio >/dev/null 2>&1
}

if have_backend; then
  info "trash backend detected"
else
  info "no trash backend found; trying to install one (optional, a built-in fallback exists)"
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        info "brew install trash"
        if brew install trash; then info "installed 'trash' via Homebrew"; else warn "brew install trash failed"; fi
      else
        warn "Homebrew not found; install 'trash' manually (https://github.com/ali-rantakari/trash)"
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        sudo -n apt-get install -y trash-cli && info "installed trash-cli" || warn "apt install failed"
      elif command -v dnf >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        sudo -n dnf install -y trash-cli && info "installed trash-cli" || warn "dnf install failed"
      else
        warn "install 'trash-cli' or 'glib2' (gio) manually if you want a system backend"
      fi
      ;;
    *)
      warn "unsupported OS for auto-install; the built-in fallback will be used"
      ;;
  esac
fi

info "Done. The plugin ships a built-in fallback, so a system backend is optional. Restart opencode."
