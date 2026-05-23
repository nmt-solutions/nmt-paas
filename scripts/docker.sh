#!/bin/bash

set -e

BASE_DIR="./packages/docker"

COMMAND=$1
shift

if [ -z "$COMMAND" ]; then
  echo "Usage: pnpm docker <command>"
  exit 1
fi

echo "Running docker compose $COMMAND across all docker projects..."

for dir in "$BASE_DIR"/*; do
  if [ -d "$dir" ] && [ -f "$dir/docker-compose.yml" ]; then
    echo ""
    echo "========================================="
    echo "Project: $(basename "$dir")"
    echo "========================================="

    (
      cd "$dir"
      docker compose "$COMMAND" "$@"
    )
  fi
done