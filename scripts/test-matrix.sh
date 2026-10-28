#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# The API integration suite under every mail backend:
#
#   MAIL_MODE            outbox | smtp | ses    .eml files, SMTP to Mailpit, or SES
#                                               (Floci, relayed to Mailpit)
#
# The upstream providers and both payment gateways run against apps/stubs in every
# row: the suite starts the stubs in-process on an ephemeral port and pins STUBS_URL,
# the Stripe and Razorpay bases and JOBS_MODE=inline itself
# (apps/api/test/integration/env.ts). 3 runs against the local stack (`make up` first:
# Postgres, Redis, Floci and Mailpit). Every row gets a fresh database whose name ends
# in _test and its own Redis logical database (1..3), so no state carries over.
# Exits non-zero if any row fails; prints a table either way.
#
#   ONLY=ses           run only the rows whose label contains "ses"
#   FILTER=auth        pass a file filter to vitest (only matching test files run)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PG_PORT="${GW_PG_PORT:-5522}"
REDIS_PORT="${GW_REDIS_PORT:-6459}"
FLOCI="http://localhost:${GW_FLOCI_PORT:-4627}"
SMTP_PORT="${GW_SMTP_PORT:-1076}"
export MAILPIT_URL="http://localhost:${GW_MAILPIT_PORT:-8076}"
ONLY="${ONLY:-}"
FILTER="${FILTER:-}"
# vitest directly: `pnpm test:integration -- <filter>` would not forward the filter.
vitest=(pnpm exec vitest run --config vitest.integration.config.mts)
[[ -n "$FILTER" ]] && vitest+=("$FILTER")

listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

missing=()
listening "$PG_PORT" || missing+=("postgres :$PG_PORT")
listening "$REDIS_PORT" || missing+=("redis :$REDIS_PORT")
listening "$SMTP_PORT" || missing+=("mailpit smtp :$SMTP_PORT")
curl -s -o /dev/null "$FLOCI/" || missing+=("floci $FLOCI")
if ((${#missing[@]})); then
  printf 'Not reachable: %s\nStart the local stack first: make up\n' "${missing[*]}"
  exit 1
fi

tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

rows=()
failed=0
n=0
for mail in outbox smtp ses; do
  n=$((n + 1))
  label="mail=$mail"
  [[ -n "$ONLY" && "$label" != *"$ONLY"* ]] && continue
  db="gw_matrix_$(printf '%02d' "$n")_test"
  redis-cli -p "$REDIS_PORT" -n "$n" FLUSHDB >/dev/null 2>&1 || true
  env_args=(
    TEST_DATABASE_URL="postgres://gw:gw@localhost:${PG_PORT}/${db}"
    TEST_REDIS_URL="redis://localhost:${REDIS_PORT}/${n}"
    MAIL_MODE="$mail"
    DATA_DIR="$tmp_root/$n"
  )
  [[ "$mail" != outbox ]] && env_args+=("MAIL_FROM=Euron Open AI API Gateway <no-reply@gateway.example.test>")
  [[ "$mail" == smtp ]] && env_args+=(SMTP_HOST=localhost SMTP_PORT="$SMTP_PORT")
  [[ "$mail" == ses ]] && env_args+=(AWS_ENDPOINT_URL="$FLOCI" AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
    SES_REGION=us-east-1 SES_CONFIGURATION_SET=open-gateway-local-mail)

  printf '%-46s ' "$label"
  out=$(env "${env_args[@]}" "${vitest[@]}" 2>&1)
  code=$?
  summary=$(grep -E '^\s+Tests ' <<<"$out" | tail -1 | sed -E 's/^\s+//')
  if [[ $code -ne 0 ]]; then
    failed=1
    status=FAIL
    echo "FAIL  ${summary:-no test summary}"
    grep -E 'FAIL|AssertionError|Error:' <<<"$out" | head -10 | sed 's/^/      /'
  else
    status=ok
    echo "ok    $summary"
  fi
  rows+=("$label|$status|${summary:-}")
done

echo
printf '%-46s %-5s %s\n' "row" "result" "tests"
printf '%-46s %-5s %s\n' "---" "------" "-----"
for row in "${rows[@]}"; do
  IFS='|' read -r label status summary <<<"$row"
  printf '%-46s %-6s %s\n' "$label" "$status" "$summary"
done
echo
if [[ $failed -eq 0 ]]; then
  echo "All ${#rows[@]} rows passed."
else
  echo "Some rows failed."
fi
exit $failed
