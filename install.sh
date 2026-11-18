#!/bin/sh
# team-harness installer for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/loviglass/team-harness/main/install.sh | sh
# Re-running it is safe (repairs/updates the install).
set -eu

REPO_URL=${TEAM_HARNESS_REPO:-https://github.com/loviglass/team-harness.git}
case "$(uname -s)" in
  Darwin) OS=darwin; BASE_DEFAULT="$HOME/Library/Application Support/team-harness" ;;
  Linux) OS=linux; BASE_DEFAULT="${XDG_DATA_HOME:-$HOME/.local/share}/team-harness" ;;
  *) echo "Unsupported OS: $(uname -s). On Windows use install.ps1." >&2; exit 1 ;;
esac
BASE=${TEAM_HARNESS_HOME:-$BASE_DEFAULT}
case "$(uname -m)" in
  x86_64|amd64) CPU=x64 ;;
  arm64|aarch64) CPU=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

die() { echo "team-harness install: $*" >&2; exit 1; }
command -v git >/dev/null 2>&1 || {
  [ "$OS" = darwin ] && die "Git is required. Run: xcode-select --install   then re-run this installer."
  die "Git is required. Install it with your package manager (e.g. sudo apt install git), then re-run."
}
command -v curl >/dev/null 2>&1 || die "curl is required."

echo "==> Installing team-harness into $BASE"
mkdir -p "$BASE/engine"
REPO="$BASE/repo"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" fetch --quiet --tags --force origin
else
  git clone --quiet "$REPO_URL" "$REPO"
fi
# TEAM_HARNESS_REF pins a branch/commit/tag (pilots, CI); default: latest release tag.
TAG=${TEAM_HARNESS_REF:-$(git -C "$REPO" tag --list 'v*' --sort=-v:refname | head -n 1)}
if [ -n "$TAG" ]; then git -C "$REPO" checkout --quiet --force "$TAG"; fi

# Pinned OpenCode engine (official release, checksum-verified).
. "$REPO/versions.env"
eval "SHA=\${OPENCODE_SHA256_${OS}_${CPU}:-}"
[ -n "$SHA" ] || die "no pinned OpenCode build for ${OS}/${CPU}"
SUFFIX=""; [ "$CPU" = x64 ] && SUFFIX="-baseline"
if [ "$OS" = linux ]; then ASSET="opencode-linux-${CPU}${SUFFIX}.tar.gz"; else ASSET="opencode-darwin-${CPU}${SUFFIX}.zip"; fi
ENGINE="$BASE/engine/opencode-$OPENCODE_VERSION/opencode"
if [ ! -x "$ENGINE" ]; then
  echo "==> Downloading OpenCode $OPENCODE_VERSION"
  TMP=$(mktemp -d "$BASE/engine/.dl-XXXXXX")
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL --retry 3 -o "$TMP/$ASSET" "https://github.com/anomalyco/opencode/releases/download/v$OPENCODE_VERSION/$ASSET"
  GOT=$( (sha256sum "$TMP/$ASSET" 2>/dev/null || shasum -a 256 "$TMP/$ASSET") | cut -d' ' -f1)
  [ "$GOT" = "$SHA" ] || die "checksum mismatch for $ASSET"
  case "$ASSET" in
    *.tar.gz) tar -xzf "$TMP/$ASSET" -C "$TMP" ;;
    *.zip) (cd "$TMP" && unzip -q "$ASSET") ;;
  esac
  mkdir -p "$(dirname "$ENGINE")"
  mv "$TMP/opencode" "$ENGINE"
  chmod 755 "$ENGINE"
fi
printf '%s' "$ENGINE" > "$BASE/engine/current"

# Command on PATH.
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
ln -sf "$REPO/bin/team-harness" "$BIN/team-harness"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    LINE='export PATH="$HOME/.local/bin:$PATH"'
    for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
      if [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ] || { [ "$rc" = "$HOME/.zshrc" ] && [ "$OS" = darwin ]; }; then
        grep -qs '.local/bin' "$rc" || printf '\n%s\n' "$LINE" >> "$rc"
      fi
    done
    ;;
esac

# Logins and checks (interactive; stdin may be the curl pipe).
if [ -n "${TEAM_HARNESS_SKIP_LOGIN:-}" ]; then
  "$BIN/team-harness" setup --no-login
elif (: < /dev/tty) 2>/dev/null; then
  "$BIN/team-harness" setup < /dev/tty
else
  "$BIN/team-harness" setup
fi
