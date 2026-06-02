#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/install-profile-instance.sh <profile> [options]

Creates/updates a Hermes profile clone and runs a dedicated AgentControl PM2
instance bound to that profile.

Defaults:
  source profile: default
  port: first free port starting at 7461
  AgentControl home: ~/.agentcontrol-<profile>
  PM2 app name: AgentControl-<profile>
  Hermes profile home: ~/.hermes/profiles/<profile>

Options:
  --source-profile <name>   Hermes profile to clone from (default: default)
  --port <port>             HTTP port for this AgentControl instance
  --name <pm2-name>         PM2 process name (default: AgentControl-<profile>)
  --agentcontrol-home <dir> State dir/DB/logs/skills for this instance
  --description <text>      Hermes profile description
  --empty-skills            Start with empty profile skills dir after cloning env/config
  --no-build                Skip npm install/build
  --dry-run                 Print actions without changing anything
  -h, --help                Show this help

Examples:
  scripts/install-profile-instance.sh frontend-dev --source-profile default
  scripts/install-profile-instance.sh qa-client --port 7471 --empty-skills
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-}"
if [[ -z "$PROFILE" || "$PROFILE" == "-h" || "$PROFILE" == "--help" ]]; then
  usage
  exit 0
fi
shift || true

SOURCE_PROFILE="default"
PORT=""
PM2_NAME=""
AGENTCONTROL_HOME=""
DESCRIPTION="AgentControl worker profile cloned from default. Own Hermes profile state, skills, AgentControl DB, logs, and installed skills."
EMPTY_SKILLS=0
DO_BUILD=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-profile)
      SOURCE_PROFILE="${2:?missing value for --source-profile}"; shift 2 ;;
    --port)
      PORT="${2:?missing value for --port}"; shift 2 ;;
    --name)
      PM2_NAME="${2:?missing value for --name}"; shift 2 ;;
    --agentcontrol-home)
      AGENTCONTROL_HOME="${2:?missing value for --agentcontrol-home}"; shift 2 ;;
    --description)
      DESCRIPTION="${2:?missing value for --description}"; shift 2 ;;
    --empty-skills)
      EMPTY_SKILLS=1; shift ;;
    --no-build)
      DO_BUILD=0; shift ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2 ;;
  esac
done

if [[ ! "$PROFILE" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "Profile must be lowercase alphanumeric plus '-' or '_' and start with a letter/number: $PROFILE" >&2
  exit 2
fi

HOME_DIR="${HOME:?HOME is required}"
HERMES_HOME_DIR="$HOME_DIR/.hermes"
PROFILE_HOME="$HERMES_HOME_DIR/profiles/$PROFILE"
AGENTCONTROL_HOME="${AGENTCONTROL_HOME:-$HOME_DIR/.agentcontrol-$PROFILE}"
PM2_NAME="${PM2_NAME:-AgentControl-$PROFILE}"
if [[ -n "${HERMES_PM2_NODE:-}" ]]; then
  NODE_BIN="$HERMES_PM2_NODE"
elif [[ -x "$HOME_DIR/.nvm/versions/node/v22.22.0/bin/node" ]]; then
  NODE_BIN="$HOME_DIR/.nvm/versions/node/v22.22.0/bin/node"
else
  NODE_BIN="$(command -v node)"
fi
HERMES_AGENT_DIR="${HERMES_AGENT_DIR:-$HERMES_HOME_DIR/hermes-agent}"
HERMES_PYTHON="${HERMES_PYTHON:-$HERMES_AGENT_DIR/venv/bin/python}"

run() {
  echo "+ $*"
  if [[ "$DRY_RUN" == "0" ]]; then
    "$@"
  fi
}

shell_quote() {
  python3 - "$1" <<'PY'
import shlex, sys
print(shlex.quote(sys.argv[1]))
PY
}

is_port_busy() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

if [[ -z "$PORT" ]]; then
  PORT=7461
  while is_port_busy "$PORT"; do
    PORT=$((PORT + 1))
  done
fi

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid port: $PORT" >&2
  exit 2
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

require_cmd hermes
require_cmd npm
require_cmd pm2
require_cmd node
require_cmd python3
require_cmd lsof
require_cmd curl

if [[ ! -d "$ROOT_DIR" || ! -f "$ROOT_DIR/package.json" ]]; then
  echo "AgentControl repo root not found: $ROOT_DIR" >&2
  exit 1
fi

if [[ "$DRY_RUN" == "0" ]]; then
  if hermes profile list | awk '{print $1}' | grep -Fxq "$PROFILE"; then
    echo "Hermes profile exists: $PROFILE"
  else
    run hermes profile create "$PROFILE" --clone --clone-from "$SOURCE_PROFILE" --no-alias --description "$DESCRIPTION"
  fi

  if [[ "$EMPTY_SKILLS" == "1" ]]; then
    run rm -rf "$PROFILE_HOME/skills"
    run mkdir -p "$PROFILE_HOME/skills"
  fi
else
  echo "+ ensure Hermes profile '$PROFILE' exists, cloned from '$SOURCE_PROFILE'"
fi

run mkdir -p "$AGENTCONTROL_HOME/data" "$AGENTCONTROL_HOME/logs" "$AGENTCONTROL_HOME/workspace" "$AGENTCONTROL_HOME/skills"

if [[ "$DRY_RUN" == "0" ]]; then
  PROFILE_CONFIG="$PROFILE_HOME/config.yaml"
  python3 - "$PROFILE_CONFIG" "$AGENTCONTROL_HOME/skills" <<'PY'
from pathlib import Path
import sys
import yaml

config_path = Path(sys.argv[1]).expanduser()
skills_dir = sys.argv[2]
cfg = yaml.safe_load(config_path.read_text()) or {}
skills = cfg.setdefault('skills', {})
skills['external_dirs'] = [skills_dir]
config_path.write_text(yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True))
PY
else
  echo "+ set $PROFILE_HOME/config.yaml skills.external_dirs to $AGENTCONTROL_HOME/skills"
fi

if [[ "$DO_BUILD" == "1" ]]; then
  run npm --prefix "$ROOT_DIR" install
  run npm --prefix "$ROOT_DIR" run build
fi

ECOSYSTEM="$AGENTCONTROL_HOME/agentcontrol.pm2.cjs"
if [[ "$DRY_RUN" == "0" ]]; then
  cat > "$ECOSYSTEM" <<EOF
module.exports = {
  apps: [
    {
      name: '$(printf '%s' "$PM2_NAME" | sed "s/'/\\\\'/g")',
      cwd: '$(printf '%s' "$ROOT_DIR" | sed "s/'/\\\\'/g")',
      script: 'dist/server/server/index.js',
      interpreter: '$(printf '%s' "$NODE_BIN" | sed "s/'/\\\\'/g")',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '$(printf '%s' "$PORT" | sed "s/'/\\\\'/g")',
        HERMES_PROFILE: '$(printf '%s' "$PROFILE" | sed "s/'/\\\\'/g")',
        HERMES_HOME: '$(printf '%s' "$PROFILE_HOME" | sed "s/'/\\\\'/g")',
        AGENTCONTROL_HOME: '$(printf '%s' "$AGENTCONTROL_HOME" | sed "s/'/\\\\'/g")',
        HERMES_AGENT_DIR: '$(printf '%s' "$HERMES_AGENT_DIR" | sed "s/'/\\\\'/g")',
        HERMES_PYTHON: '$(printf '%s' "$HERMES_PYTHON" | sed "s/'/\\\\'/g")',
        HERMES_AGENT_RUN_LIMIT: process.env.HERMES_AGENT_RUN_LIMIT || '10',
        HEARTBEAT_CONCURRENCY: process.env.HEARTBEAT_CONCURRENCY || '2',
      },
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      out_file: '$(printf '%s' "$AGENTCONTROL_HOME/logs/agent-control.out.log" | sed "s/'/\\\\'/g")',
      error_file: '$(printf '%s' "$AGENTCONTROL_HOME/logs/agent-control.err.log" | sed "s/'/\\\\'/g")',
      merge_logs: true,
      time: true,
    },
  ],
};
EOF
else
  echo "+ write $ECOSYSTEM"
fi

if [[ "$DRY_RUN" == "0" ]]; then
  pm2 delete "$PM2_NAME" >/dev/null 2>&1 || true
  echo "+ pm2 start dist/server/server/index.js --name $PM2_NAME"
  env \
    NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT="$PORT" \
    HERMES_PROFILE="$PROFILE" \
    HERMES_HOME="$PROFILE_HOME" \
    AGENTCONTROL_HOME="$AGENTCONTROL_HOME" \
    HERMES_AGENT_DIR="$HERMES_AGENT_DIR" \
    HERMES_PYTHON="$HERMES_PYTHON" \
    HERMES_AGENT_RUN_LIMIT="${HERMES_AGENT_RUN_LIMIT:-10}" \
    HEARTBEAT_CONCURRENCY="${HEARTBEAT_CONCURRENCY:-2}" \
    pm2 start "$ROOT_DIR/dist/server/server/index.js" \
      --name "$PM2_NAME" \
      --cwd "$ROOT_DIR" \
      --interpreter "$NODE_BIN" \
      --update-env
else
  echo "+ pm2 start $ROOT_DIR/dist/server/server/index.js --name $PM2_NAME"
fi
run pm2 save

HEALTH_URL="http://127.0.0.1:$PORT/api/health"
if [[ "$DRY_RUN" == "0" ]]; then
  echo "+ wait for $HEALTH_URL"
  for i in {1..30}; do
    if curl -fsS "$HEALTH_URL" >/tmp/agentcontrol-profile-health.$$ 2>/tmp/agentcontrol-profile-health.err.$$; then
      cat /tmp/agentcontrol-profile-health.$$
      echo
      rm -f /tmp/agentcontrol-profile-health.$$ /tmp/agentcontrol-profile-health.err.$$
      break
    fi
    if [[ "$i" == "30" ]]; then
      echo "Health check failed for $HEALTH_URL" >&2
      cat /tmp/agentcontrol-profile-health.err.$$ >&2 || true
      rm -f /tmp/agentcontrol-profile-health.$$ /tmp/agentcontrol-profile-health.err.$$
      exit 1
    fi
    sleep 1
  done
fi

cat <<EOF

AgentControl profile instance is ready.

Profile:              $PROFILE
Hermes profile home:  $PROFILE_HOME
AgentControl home:    $AGENTCONTROL_HOME
PM2 app:              $PM2_NAME
URL:                  http://127.0.0.1:$PORT
PM2 ecosystem:        $ECOSYSTEM

Useful commands:
  hermes --profile $(shell_quote "$PROFILE") config path
  hermes --profile $(shell_quote "$PROFILE") config env-path
  pm2 status $(shell_quote "$PM2_NAME")
  pm2 logs $(shell_quote "$PM2_NAME") --lines 80 --nostream
  curl -fsS $(shell_quote "$HEALTH_URL")
EOF
