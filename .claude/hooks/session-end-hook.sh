#!/bin/bash
# SessionEnd Hook (프로젝트) — 세션 종료 시 talk_history.md 업데이트 안내
# 목적: 세션 종료 전 변경 이력 기록 여부 리마인드

TALK_HISTORY="$CLAUDE_PROJECT_DIR/talk_history.md"
CODE_UPDATE="$CLAUDE_PROJECT_DIR/code_update.md"

REMINDERS=()

if [ -f "$TALK_HISTORY" ]; then
    LAST_MODIFIED=$(python -c "
import os, datetime
t = os.path.getmtime('$TALK_HISTORY')
d = datetime.datetime.fromtimestamp(t)
print(d.strftime('%Y-%m-%d'))
" 2>/dev/null)
    TODAY=$(date +%Y-%m-%d)
    if [ "$LAST_MODIFIED" != "$TODAY" ]; then
        REMINDERS+=("  - talk_history.md 오늘 업데이트 안 됨 (마지막: $LAST_MODIFIED)")
    fi
fi

if [ ${#REMINDERS[@]} -gt 0 ]; then
    echo ""
    echo "[SESSION-END] 세션 종료 전 확인 사항:"
    for r in "${REMINDERS[@]}"; do
        echo "$r"
    done
fi

exit 0
