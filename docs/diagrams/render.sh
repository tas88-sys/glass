#!/usr/bin/env bash
# Render every .mmd in this directory to an SVG in ./out/
# Requires @mermaid-js/mermaid-cli (uses npx so no global install needed).
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p out

shopt -s nullglob
mmd_files=( *.mmd )
if [ ${#mmd_files[@]} -eq 0 ]; then
  echo "No .mmd files found."
  exit 0
fi

for f in "${mmd_files[@]}"; do
  out="out/${f%.mmd}.svg"
  echo "Rendering $f -> $out"
  npx -p @mermaid-js/mermaid-cli mmdc -i "$f" -o "$out" -b transparent
done

echo "Done. SVGs are in $(pwd)/out"
