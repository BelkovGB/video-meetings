#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "At least one npm script is required." >&2
  exit 64
fi

cp -R /source/. /workspace/
cp -R /opt/ralph-dependencies/node_modules /workspace/
cp /workspace/.env.example /workspace/.env

export PGDATA=/tmp/postgres
initdb --auth-local=trust --auth-host=trust --pgdata="$PGDATA" >/dev/null
pg_ctl --pgdata="$PGDATA" --options='-c listen_addresses=127.0.0.1' --wait start >/dev/null
trap 'pg_ctl --pgdata="$PGDATA" --wait stop >/dev/null 2>&1 || true' EXIT
psql --dbname=postgres --command 'CREATE ROLE video_meetings LOGIN;' >/dev/null
psql --dbname=postgres --command 'CREATE DATABASE video_meetings OWNER video_meetings;' >/dev/null

cd /workspace
for script in "$@"; do
  npm run "$script"
done
