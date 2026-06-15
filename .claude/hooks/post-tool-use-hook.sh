#!/bin/bash
# PostToolUse Hook (프로젝트) — Python 파일 인코딩 설정 감지
# 목적: Python 파일 작성 시 utf-8 설정 누락 경고

INPUT=$(cat)
TOOL=$(echo "$INPUT" | python -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null)
FILE_PATH=$(echo "$INPUT" | python -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null)

if [[ "$TOOL" == "Write" ]] && [[ "$FILE_PATH" == *.py ]]; then
    CONTENT=$(echo "$INPUT" | python -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('content',''))" 2>/dev/null)
    if ! echo "$CONTENT" | grep -q "reconfigure(encoding"; then
        echo "[WARNING] Python 파일에 stdout.reconfigure(encoding='utf-8') 설정이 없습니다."
        echo "  파일: $FILE_PATH"
        echo "  Windows 환경에서 한글/특수문자 출력 시 인코딩 오류 발생 가능"
    fi
fi

exit 0
