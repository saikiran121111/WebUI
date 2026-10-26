#!/usr/bin/env bash
# Phase 0 TypeScript-baseline performance probe (Rule 15).
# Foreground only; Playwright-lock-checked; minimal prompts; NEVER competes with an active Playwright run.
set -u
REPO="/d/Projects/WebUI/WebUI"; cd "$REPO" || exit 2
OUT="$REPO/rust-backend/perf"; mkdir -p "$OUT"
BASE="http://127.0.0.1:3000"
[ -f .ai-coordination/playwright.lock ] && { echo "ABORT: Playwright lock exists"; exit 2; }
PID=$(netstat -ano 2>/dev/null | grep LISTENING | grep -E ':3000 *' | head -1 | awk '{print $NF}' | tr -d '\r')
[ -n "${PID:-}" ] || { echo "ABORT: nothing listening on :3000"; exit 2; }
echo "Next dev pid=$PID"
LOG="$OUT/results-$(date +%Y%m%d-%H%M%S).log"; WSLOG="$OUT/ws-$PID.csv"
exec > >(tee -a "$LOG") 2>&1

sam() { powershell.exe -NoProfile -File "$OUT/ps-sampler.ps1" -Id "$PID" 400 >> "$WSLOG" 2>/dev/null & echo $!; }
killsam() { [ -n "${SP:-}" ] && kill "$SP" 2>/dev/null; SP=""; }

# body files
printf '{"model":"default","stream":true,"messages":[{"role":"user","content":"Reply with exactly this word and nothing else: BASELINEOK"}]}' > "$OUT/body-tiny.json"
printf '{"model":"default","stream":true,"messages":[{"role":"user","content":"Count slowly from 1 to 1000, each number on its own line."}]}' > "$OUT/body-long.json"
printf '{"model":"default","stream":true,"messages":[{"role":"user","content":"What are this week'"'"'s top three AI news headlines? Use web search to find them and cite each headline with its source."}]}' > "$OUT/body-research.json"
printf '{"model":"default","stream":false,"messages":[{"role":"user","content":"Reply with: OK"}]}' > "$OUT/body-repeat.json"

# streaming turn probe: logs t-first-bytes / t-first-stage / t-first-content / total
stream_turn() { # $1=label $2=bodyfile $3=maxtime
  local t0 first="" stage="" content="" n=0
  t0=$(date +%s%3N)
  curl -N -s --max-time "${3:-180}" -X POST "$BASE/api/chat" -H 'Content-Type: application/json' --data @"$2" \
  | while IFS= read -r line; do
      n=$((n+1)); now=$(date +%s%3N)
      if [ -z "$first" ] && [ -n "$line" ]; then first=$((now-t0)); echo "[$1] first-bytes-ms=$first"; fi
      if [ -z "$stage" ] && printf '%s' "$line" | grep -q 'ruke_stage'; then stage=$((now-t0)); echo "[$1] first-stage-ms=$stage"; fi
      if [ -z "$content" ] && printf '%s' "$line" | grep -q '"content"'; then content=$((now-t0)); echo "[$1] first-content-delta-ms=$content"; fi
      printf '%s\n' "$line" >> "$OUT/$1-stream.txt"
    done
  echo "[$1] stream-lines=$n"
}

echo "=== 0. idle RSS ==="
powershell.exe -NoProfile -Command "(Get-Process -Id $PID).WorkingSet64" | tr -d '\r' | awk '{printf "idle-WS-bytes=%s (%.0f MB)\n",$1,$1/1048576}'

echo "=== 1. API routing latency (3x each) ==="
for ep in conversations settings model-stats; do
  for i in 1 2 3; do
    curl -s -o /dev/null -w "GET /api/$ep http=%{http_code} total=%{time_total}s\n" "$BASE/api/$ep"
  done
done

echo "=== 2. tiny chat turn (streaming, TTFP + TTFT) ==="
SP=$(sam); stream_turn "tiny" "$OUT/body-tiny.json" 120; killsam
grep -o 'ruke_stage[^}]*}' "$OUT/tiny-stream.txt" | head -5

echo "=== 3. mid-stream cancel probe ==="
curl -N -s --max-time 60 -X POST "$BASE/api/chat" -H 'Content-Type: application/json' --data @"$OUT/body-long.json" > "$OUT/cancel-stream.txt" & CP=$!
sleep 3; kill $CP 2>/dev/null; wait $CP 2>/dev/null; echo "curl killed at +3s; bytes received: $(wc -c < "$OUT/cancel-stream.txt")"
sleep 1
echo "--- post-cancel tiny turn (zombie-turn detector: fast first-stage = slot freed) ---"
stream_turn "post-cancel" "$OUT/body-tiny.json" 120

echo "=== 4. web-research turn (peak RSS + extraction stages) ==="
SP=$(sam); stream_turn "research" "$OUT/body-research.json" 300; killsam
echo "--- web: stage timeline (line numbers ≈ relative time) ---"
grep -o 'web:[a-z_]*' "$OUT/research-stream.txt" | uniq -c | head -30
grep -c 'ruke_stage' "$OUT/research-stream.txt" | awk '{print "stage-frames="$1}'

echo "=== 5. repeated-turn RSS growth (10x non-streaming tiny) ==="
powershell.exe -NoProfile -Command "(Get-Process -Id $PID).WorkingSet64" | tr -d '\r' | awk '{printf "before-WS=%.0f MB\n",$1/1048576}'
for i in $(seq 1 10); do
  curl -s --max-time 120 -o /dev/null -w "turn$i http=%{http_code} total=%{time_total}s " -X POST "$BASE/api/chat" -H 'Content-Type: application/json' --data @"$OUT/body-repeat.json"
  powershell.exe -NoProfile -Command "(Get-Process -Id $PID).WorkingSet64" | tr -d '\r' | awk '{printf "WS=%.0f MB\n",$1/1048576}'
done

echo "=== WS sampler peak (from $WSLOG) ==="
[ -s "$WSLOG" ] && awk -F, 'BEGIN{max=0}{if($2>max)max=$2}END{printf "peak-WS=%.0f MB over %d samples\n",max/1048576,NR}' "$WSLOG"
[ -f .ai-coordination/playwright.lock ] && echo "WARN: lock appeared during run" || echo "lock-state: none (as expected)"
echo "DONE exit=$?"
