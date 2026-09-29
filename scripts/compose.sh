#!/bin/bash
set -euo pipefail

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
exec docker compose --env-file "$project_root/.env" \
  --project-name datapump-pipeline-test \
  --file "$project_root/docker-compose.yml" "$@"
