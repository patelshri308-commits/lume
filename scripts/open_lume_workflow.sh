#!/usr/bin/env bash
set -euo pipefail

# Opens the standard local Lume workflow in macOS Terminal.
#
# Windows:
# 1. frontend/ -> npx expo start
# 2. repo root -> idle shell using the Clear Dark profile
# 3. repo root -> claude using the Novel profile
# 4. repo root -> idle shell for OpenClaw / QA work
#
# Profile names can be overridden without editing this file:
#   LUME_TERMINAL_CLEAR_DARK_PROFILE="Clear Dark"
#   LUME_TERMINAL_NOVEL_PROFILE="Novel"
#   LUME_TERMINAL_QA_PROFILE="Clear Dark"

LUME_ROOT="${LUME_ROOT:-$HOME/Desktop/Personal Projects/Lume}"
FRONTEND_DIR="$LUME_ROOT/frontend"
CLEAR_DARK_PROFILE="${LUME_TERMINAL_CLEAR_DARK_PROFILE:-Clear Dark}"
NOVEL_PROFILE="${LUME_TERMINAL_NOVEL_PROFILE:-Novel}"
QA_PROFILE="${LUME_TERMINAL_QA_PROFILE:-Clear Dark}"

if [[ ! -d "$LUME_ROOT" ]]; then
  echo "Lume root not found: $LUME_ROOT" >&2
  exit 1
fi

if [[ ! -d "$FRONTEND_DIR" ]]; then
  echo "Frontend directory not found: $FRONTEND_DIR" >&2
  exit 1
fi

osascript \
  - \
  "$LUME_ROOT" \
  "$FRONTEND_DIR" \
  "$CLEAR_DARK_PROFILE" \
  "$NOVEL_PROFILE" \
  "$QA_PROFILE" <<'APPLESCRIPT'
on run argv
  set lumeRoot to item 1 of argv
  set frontendDir to item 2 of argv
  set clearDarkProfile to item 3 of argv
  set novelProfile to item 4 of argv
  set qaProfile to item 5 of argv

  tell application "Terminal"
    activate

    set expoTab to do script "cd " & quoted form of frontendDir & " && npx expo start"

    set rootTab to do script "cd " & quoted form of lumeRoot & " && clear"
    my applyProfile(rootTab, clearDarkProfile)

    set claudeTab to do script "cd " & quoted form of lumeRoot & " && claude"
    my applyProfile(claudeTab, novelProfile)

    set qaTab to do script "cd " & quoted form of lumeRoot & " && clear && echo 'Lume QA / OpenClaw terminal ready.'"
    my applyProfile(qaTab, qaProfile)
  end tell
end run

on applyProfile(theTab, profileName)
  if profileName is "" then return
  tell application "Terminal"
    try
      set current settings of theTab to settings set profileName
    end try
  end tell
end applyProfile
APPLESCRIPT
