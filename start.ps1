Write-Host "Starting frontend (in a new window)..."
$frontendDir = Join-Path $PSScriptRoot 'web'
Write-Host "Starting frontend (in a new window) in $frontendDir..."
Start-Process -FilePath "pnpm.cmd" -ArgumentList "dev" -WorkingDirectory $frontendDir

Write-Host "Starting API (in a new window)..."
Start-Process powershell -ArgumentList "-Command `"cd api; uv run server.py`""

Write-Host "All services started."
