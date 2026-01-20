#!/bin/bash
# Ensure Docker is running before executing a command

if ! docker info > /dev/null 2>&1; then
  echo "Starting Docker Desktop..."
  open -a Docker

  # Wait for Docker to be ready (max 60 seconds)
  timeout=60
  while ! docker info > /dev/null 2>&1; do
    if [ $timeout -le 0 ]; then
      echo "Error: Docker failed to start within 60 seconds"
      exit 1
    fi
    sleep 1
    ((timeout--))
  done
  echo "Docker is ready"
fi

# Execute the passed command
exec "$@"
