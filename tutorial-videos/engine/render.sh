#!/bin/bash
# usage: engine/render.sh <slug> [...]  -> out/<slug>.mp4
export PATH=$HOME/.nvm/versions/node/v24.22.1/bin:$PATH
cd "$(dirname "$0")/.."
for s in "$@"; do
  d=$(ls -d build/${s}* 2>/dev/null | head -1); [ -z "$d" ] && { echo "no build for $s"; continue; }
  n=$(basename "$d")
  start=$(date +%s)
  (cd "$d" && npx --yes hyperframes@0.9.20 render --quality delivery --workers 3 --quiet -o "../../out/$n.mp4" --skill=hyperframes) > "build/$n.render.log" 2>&1
  rc=$?
  if [ $rc = 0 ]; then
    ffmpeg -y -v error -i "out/$n.mp4" -c:v copy -af loudnorm=I=-16:TP=-1.5:LRA=11 -c:a aac -b:a 192k "out/$n.tmp.mp4" && mv "out/$n.tmp.mp4" "out/$n.mp4"
  fi
  echo "$n: exit $rc in $(( $(date +%s) - start ))s"
done
