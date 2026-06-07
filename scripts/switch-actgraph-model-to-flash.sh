#!/usr/bin/env bash
set -euo pipefail

DB="${OPENCODE_DB:-/Users/jin/.local/share/opencode/opencode-local.db}"
API="${OPENCODE_API:-http://127.0.0.1:4096}"
TODAY="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/Users/jin/.local/share/opencode/backups"
BACKUP="$BACKUP_DIR/opencode-local-pre-flash-${TODAY}.db"
ABORT_ACTIVE="${ABORT_ACTIVE:-0}"

if [[ ! -f "$DB" ]]; then
  echo "error: db not found: $DB" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
cp "$DB" "$BACKUP"
echo "backup: $BACKUP"

count_total() {
  sqlite3 "$DB" "$1"
}

before=$(count_total "select count(*) from message m join session s on s.id=m.session_id where lower(s.directory) like '%actgraph%' and json_extract(m.data,'$.role')='user' and json_extract(m.data,'$.model.providerID')='deepseek' and json_extract(m.data,'$.model.modelID')='deepseek-v4-pro';")
before_any=$(count_total "select count(*) from message where json_extract(data,'$.role')='user' and json_extract(data,'$.model.providerID')='deepseek' and json_extract(data,'$.model.modelID')='deepseek-v4-pro';")

echo "before (all dirs): $before_any"
echo "before (actgraph): $before"

sqlite3 "$DB" <<SQL
update message
set data = json_set(data, '$.model.modelID', 'deepseek-v4-flash')
where json_extract(data,'$.role') = 'user'
  and json_extract(data,'$.model.providerID') = 'deepseek'
  and json_extract(data,'$.model.modelID') = 'deepseek-v4-pro'
  and session_id in (
    select id from session where lower(directory) like '%actgraph%'
  );
SQL

after=$(count_total "select count(*) from message m join session s on s.id=m.session_id where lower(s.directory) like '%actgraph%' and json_extract(m.data,'$.role')='user' and json_extract(m.data,'$.model.providerID')='deepseek' and json_extract(m.data,'$.model.modelID')='deepseek-v4-pro';")
after_any=$(count_total "select count(*) from message where json_extract(data,'$.role')='user' and json_extract(data,'$.model.providerID')='deepseek' and json_extract(data,'$.model.modelID')='deepseek-v4-pro';")

echo "after (all dirs): $after_any"
echo "after (actgraph): $after"

echo -n "latest affected sessions: "
sqlite3 "$DB" "select count(distinct s.id) from message m join session s on s.id=m.session_id where lower(s.directory) like '%actgraph%' and json_extract(m.data,'$.role')='user' and json_extract(m.data,'$.model.providerID')='deepseek' and json_extract(m.data,'$.model.modelID')='deepseek-v4-flash';"

echo "running abort mode: $ABORT_ACTIVE"

if [[ "$ABORT_ACTIVE" == "1" ]]; then
  if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    echo "curl/jq missing, skip abort" >&2
    exit 0
  fi

  ACTIVE_IDS="$(curl -sS "$API/session/status" | jq -r 'to_entries[] | select(.value.status=="running" or .value.status=="busy") | .key')"
  if [[ -z "$ACTIVE_IDS" ]]; then
    echo "no active sessions reported by API"
    exit 0
  fi

  for sid in $ACTIVE_IDS; do
    dir="$(sqlite3 "$DB" "select directory from session where id='$sid';")"
    if [[ "$dir" == *"actgraph"* ]]; then
      echo "aborting $sid (dir=$dir)"
      curl -sS -X POST "$API/session/$sid/abort" >/dev/null || true
    fi
  done
  echo "abort pass complete"
fi

echo "done"
