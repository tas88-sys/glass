# Render every .mmd in this directory to an SVG in .\out\
# Requires @mermaid-js/mermaid-cli (uses npx so no global install needed).
$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot
New-Item -ItemType Directory -Force -Path "out" | Out-Null

$mmdFiles = Get-ChildItem -Filter *.mmd
if ($mmdFiles.Count -eq 0) {
    Write-Host "No .mmd files found."
    exit 0
}

foreach ($f in $mmdFiles) {
    $out = Join-Path "out" ($f.BaseName + ".svg")
    Write-Host "Rendering $($f.Name) -> $out"
    npx -p "@mermaid-js/mermaid-cli" mmdc -i $f.FullName -o $out -b transparent
}

Write-Host "Done. SVGs are in $(Join-Path $PSScriptRoot 'out')"
