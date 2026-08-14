#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "At least one npm script is required." >&2
  exit 64
fi

cp -R /source/. /workspace/
cp /workspace/.env.example /workspace/.env

export PGDATA=/tmp/postgres
initdb --auth-local=trust --auth-host=trust --pgdata="$PGDATA" >/dev/null
pg_ctl --pgdata="$PGDATA" --options='-c listen_addresses=127.0.0.1' --wait start >/dev/null
trap 'pg_ctl --pgdata="$PGDATA" --wait stop >/dev/null 2>&1 || true' EXIT

cd /workspace
npm ci --offline --cache /opt/ralph-npm-cache --no-audit --fund=false
for script in "$@"; do
  npm run "$script"
done
