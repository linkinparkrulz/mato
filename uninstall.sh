#!/usr/bin/env bash
# Launcher for the Dojo Bay uninstaller. Reverses the guided install: run it
# with no arguments first, which only reports what it would remove.
set -e
cd "$(dirname "$0")"

MIN_MAJOR=24

# Find node as the INVOKING user, and hand sudo an absolute path.
#
# `sudo node` looks up node on sudo's secure_path, which on Debian and Ubuntu is
# a fixed list that does not include ~/.nvm, ~/.local or /opt. So a user with a
# perfectly good node from nvm, fnm or asdf gets "sudo: node: command not found"
# and no idea why, because `node -v` works fine for them.
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  cat >&2 <<EOF

  Node ${MIN_MAJOR} or newer is required, and no node was found on this system.

  Do NOT install it with 'apt install nodejs': Debian and Ubuntu ship Node 18,
  which is too old, and you would have to remove it again.

  Install a current Node from NodeSource:

    sudo apt-get install -y ca-certificates curl gnupg
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \\
      | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] \\
https://deb.nodesource.com/node_${MIN_MAJOR}.x nodistro main" \\
      | sudo tee /etc/apt/sources.list.d/nodesource.list > /dev/null
    sudo apt-get update && sudo apt-get install -y nodejs

  Then run this installer again.

EOF
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null || echo "")"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"

case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    echo "  Could not read a version from $NODE_BIN (got '${NODE_VERSION:-nothing}')." >&2
    exit 1 ;;
esac

if [ "$NODE_MAJOR" -lt "$MIN_MAJOR" ]; then
  cat >&2 <<EOF

  Node ${MIN_MAJOR} or newer is required. Found ${NODE_VERSION} at ${NODE_BIN}.

  The backend runs TypeScript directly, which needs Node ${MIN_MAJOR}'s type
  stripping, and the BIP47 libraries require it too. An apt-installed Node on
  Debian or Ubuntu is 18 and cannot be used.

  Upgrade from NodeSource, which replaces the apt package in place:

    sudo apt-get install -y ca-certificates curl gnupg
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \\
      | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] \\
https://deb.nodesource.com/node_${MIN_MAJOR}.x nodistro main" \\
      | sudo tee /etc/apt/sources.list.d/nodesource.list > /dev/null
    sudo apt-get update && sudo apt-get install -y nodejs

  Then run this installer again.

EOF
  exit 1
fi

# Root already: run directly. Otherwise re-run under sudo with the absolute
# path, so the node found above is the node that actually runs.
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -- "$NODE_BIN" scripts/uninstall.mjs "$@"
fi
exec "$NODE_BIN" scripts/uninstall.mjs "$@"
