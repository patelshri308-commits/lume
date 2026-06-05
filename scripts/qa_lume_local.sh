#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_FOOD_AUDIT=0
RUN_FRONTEND=1
RUN_BACKEND=1
FAILURES=0

usage() {
  cat <<'EOF'
Usage: scripts/qa_lume_local.sh [options]

Runs lightweight local QA checks for Lume without changing app behavior.

Options:
  --food-audit       Also run backend/scripts/audit_generic_foods.py live USDA audit.
  --no-backend       Skip backend pytest checks.
  --no-frontend      Skip frontend typecheck.
  -h, --help         Show this help text.

Default checks:
  - git status and diff stat
  - redacted tracked-file privacy scan
  - backend non-live pytest suite
  - frontend TypeScript check if local node_modules has tsc installed

Safety:
  - Does not print .env values.
  - Does not modify production, Supabase, Render, Vercel, or env vars.
  - Does not run live USDA audit unless --food-audit is passed.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --food-audit)
      RUN_FOOD_AUDIT=1
      shift
      ;;
    --no-backend)
      RUN_BACKEND=0
      shift
      ;;
    --no-frontend)
      RUN_FRONTEND=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

section() {
  printf '\n== %s ==\n' "$1"
}

run_check() {
  local label="$1"
  shift

  section "$label"
  if "$@"; then
    echo "PASS: $label"
  else
    local code=$?
    echo "FAIL: $label (exit $code)"
    FAILURES=$((FAILURES + 1))
  fi
}

run_optional() {
  local label="$1"
  shift

  section "$label"
  if "$@"; then
    echo "PASS: $label"
  else
    local code=$?
    echo "SKIP/FAIL: $label (exit $code)"
    FAILURES=$((FAILURES + 1))
  fi
}

privacy_scan() {
  python3 - <<'PY'
import os
import re
import subprocess
import sys

skip_ext = {
    ".png", ".jpg", ".jpeg", ".gif", ".otf", ".ttf", ".woff",
    ".woff2", ".eot", ".ico", ".pdf", ".zip"
}

secret_assignment = re.compile(
    r"\b(?:AWS_[A-Z0-9_]*|SUPABASE_[A-Z0-9_]*|DATABASE_URL|DIRECT_URL|USDA_API_KEY|"
    r"[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|JWT[_-]?SECRET)[A-Z0-9_]*)"
    r"\b\s*[:=]\s*[\"']?([^\"'\s#]+)"
)
patterns = [
    ("postgres_url", re.compile(r"(?i)postgres(?:ql)?://")),
    ("jwt_like", re.compile(r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}")),
    ("openai_key", re.compile(r"sk-[A-Za-z0-9_-]{20,}")),
    ("github_token", re.compile(r"(ghp_|github_pat_)[A-Za-z0-9_]{20,}")),
    ("aws_access_key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("private_key_block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]
placeholder_values = {
    "", "demo_key", "demo-key", "changeme", "placeholder", "example",
    "your-project-url", "your-anon-key", "your-api-key",
    "your-database-url", "your-direct-url", "<redacted>"
}

try:
    tracked = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        text=True,
    ).splitlines()
except subprocess.CalledProcessError as exc:
    print(f"Could not list tracked files: {exc}", file=sys.stderr)
    return_code = 1
    raise SystemExit(return_code)

findings = []
for path in tracked:
    ext = os.path.splitext(path)[1].lower()
    if ext in skip_ext:
        continue
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            for line_number, line in enumerate(handle, 1):
                assignment = secret_assignment.search(line)
                if assignment:
                    value = assignment.group(1).strip().strip("\"'")
                    if (
                        value.lower() not in placeholder_values
                        and not value.startswith("os.getenv")
                        and not value.startswith("process.env")
                    ):
                        key_match = re.search(
                            r"([A-Za-z0-9_]*(?:SECRET|PASSWORD|TOKEN|API[_-]?KEY|"
                            r"DATABASE_URL|DIRECT_URL|USDA_API_KEY|SUPABASE_[A-Z_]+|"
                            r"PRIVATE[_-]?KEY|JWT[_-]?SECRET)[A-Za-z0-9_]*)",
                            line,
                            re.I,
                        )
                        key = key_match.group(1) if key_match else "<unknown>"
                        findings.append(f"{path}:{line_number}: secret_assignment key={key}")
                    continue

                for name, pattern in patterns:
                    if pattern.search(line):
                        findings.append(f"{path}:{line_number}: {name}")
                        break
    except OSError:
        continue

if findings:
    print("Potential tracked sensitive patterns found. Values are redacted:")
    print("\n".join(findings))
    raise SystemExit(1)

print("No high-confidence tracked secret patterns found.")
PY
}

sensitive_file_scan() {
  python3 - <<'PY'
import fnmatch
import os
import subprocess
import sys

# Files explicitly allowed even though their name matches a sensitive pattern.
SAFE_EXCEPTIONS = {".env.example"}

# Exact basename matches.
EXACT_NAMES = {".env"}

# Glob patterns matched against the basename only.
GLOB_PATTERNS = [
    ".env.*",
    "*.csv",
    "*.db",
    "*.sqlite",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
]

try:
    tracked = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        text=True,
    ).splitlines()
except subprocess.CalledProcessError as exc:
    print(f"Could not list tracked files: {exc}", file=sys.stderr)
    raise SystemExit(1)

findings = []
for path in tracked:
    name = os.path.basename(path)
    if name in SAFE_EXCEPTIONS:
        continue
    if name in EXACT_NAMES or any(fnmatch.fnmatch(name, pat) for pat in GLOB_PATTERNS):
        findings.append(path)

if findings:
    print("Sensitive file class(es) tracked by git — remove or .gitignore these files:")
    for f in findings:
        print(f"  {f}")
    raise SystemExit(1)

print("No sensitive file classes found in tracked files.")
PY
}

backend_tests() {
  (cd "$ROOT_DIR/backend" && python3 -m pytest tests -q -m "not live")
}

frontend_typecheck() {
  if [[ ! -x "$ROOT_DIR/frontend/node_modules/.bin/tsc" ]]; then
    echo "FAIL: frontend/node_modules/.bin/tsc not found. Run 'npm install' in frontend/ first."
    echo "      Pass --no-frontend to skip this check intentionally."
    return 1
  fi

  (cd "$ROOT_DIR/frontend" && ./node_modules/.bin/tsc --noEmit)
}

food_audit() {
  (cd "$ROOT_DIR/backend" && python3 scripts/audit_generic_foods.py)
}

cd "$ROOT_DIR"

section "Git State"
git status --short --branch
git diff --stat

run_check "Privacy scan" privacy_scan
run_check "Sensitive file class scan" sensitive_file_scan

if [[ "$RUN_BACKEND" -eq 1 ]]; then
  run_check "Backend non-live tests" backend_tests
fi

if [[ "$RUN_FRONTEND" -eq 1 ]]; then
  run_check "Frontend TypeScript check" frontend_typecheck
fi

if [[ "$RUN_FOOD_AUDIT" -eq 1 ]]; then
  run_check "Generic food live audit" food_audit
else
  section "Generic food live audit"
  echo "SKIP: pass --food-audit to run backend/scripts/audit_generic_foods.py."
fi

section "Summary"
if [[ "$FAILURES" -eq 0 ]]; then
  echo "PASS: local QA checks completed without failures."
else
  echo "FAIL: $FAILURES check(s) failed."
  exit 1
fi
