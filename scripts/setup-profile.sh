#!/usr/bin/env bash
# Install the feishu profile for dsh — fully offline (symlinks only).
#
#   ./scripts/setup-profile.sh                 # into ~/.dsh (or $DSH_HOME)
#   DSH_HOME=/tmp/x ./scripts/setup-profile.sh # into a sandbox home
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILES="$HOME_DIR/profiles"
PROFILE="$PROFILES/feishu"

echo "repo:      $REPO"
echo "dsh home:  $HOME_DIR"

# 1) repo-local node_modules links so src/* can import @deepseek-ai packages
#    (they physically live in the dsh installation's flat module dir)
SRC_MODULES=""
for cand in "$HOME/.dsh/profiles/node_modules" "$PROFILES/node_modules"; do
  [ -d "$cand/@deepseek-ai/schemastery" ] && SRC_MODULES="$cand" && break
done
if [ -z "$SRC_MODULES" ]; then
  # fall back to the npx cache layout
  hit="$(find /root/.npm/_npx -maxdepth 4 -type d -name 'schemastery' -path '*@deepseek-ai*' 2>/dev/null | head -1)"
  [ -n "$hit" ] && SRC_MODULES="$(dirname "$(dirname "$hit")")"
fi
echo "deepseek packages from: $SRC_MODULES"
mkdir -p "$REPO/node_modules/@deepseek-ai"
for pkg in cordis schemastery dsh-agent dsh-llm dsh-session; do
  if [ -d "$SRC_MODULES/@deepseek-ai/$pkg" ]; then
    ln -sfn "$SRC_MODULES/@deepseek-ai/$pkg" "$REPO/node_modules/@deepseek-ai/$pkg"
  else
    echo "WARN: package @deepseek-ai/$pkg not found in $SRC_MODULES" >&2
  fi
done

# 2) the profile itself
mkdir -p "$PROFILE"
cp "$REPO/profile/feishu/package.json" "$PROFILE/package.json"
cp "$REPO/profile/feishu/cordis.yml" "$PROFILE/cordis.yml"
cp "$REPO/profile/feishu/pnpm-workspace.yaml" "$PROFILE/pnpm-workspace.yaml"
# user patch: relative plugin row is repo-path specific — regenerate it here
ESCAPED_REPO="${REPO// /\\ }"
cat > "$PROFILE/cordis.patch.yml" << EOP
# Installed by dsh-feishu setup — bridge plugin mounted by relative path.
# Replace with 'dsh-feishu' if you install the bundle as a real package.
- insert:
    - id: feishu-bridge
      name: $ESCAPED_REPO/src/index.js
      config:
        configFile: ''
EOP

# 3) bridge data dir + starter config
mkdir -p "$HOME_DIR/feishu"
if [ ! -f "$HOME_DIR/feishu/config.json" ]; then
  cat > "$HOME_DIR/feishu/config.json" << EOC
{
  "allowedOpenIds": ["REPLACE_WITH_YOUR_OPEN_ID"],
  "defaultCwd": "$PWD",
  "allowedWorkspaces": ["$PWD"],
  "agentPreset": "minimal",
  "approval": "cards"
}
EOC
  echo "wrote starter config: $HOME_DIR/feishu/config.json (EDIT allowedOpenIds!)"
fi

echo ""
echo "profile installed: $PROFILE"
echo "run with:   dsh --profile feishu"
echo "secrets:    export FEISHU_APP_ID=... FEISHU_APP_SECRET=..."
