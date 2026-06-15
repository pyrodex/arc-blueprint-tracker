#!/bin/sh
set -e

# Ensure data directories exist (volume may be empty on first mount)
mkdir -p "${DATA_DIR:-/data}/icons"

# Start icon download in the background — server starts immediately
node /app/scripts/download-icons.js &

# Replace shell with server process so signals (SIGTERM etc.) work correctly
exec node /app/backend/src/server.js
