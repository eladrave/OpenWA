#!/bin/sh
set -eu

for secret_file in /etc/openwa-monitor/runtime.env /etc/openwa-monitor/deploy.env; do
  metadata="$(stat -c '%U:%G:%a' "$secret_file")"
  if [ "$metadata" != 'root:root:600' ]; then
    echo "Refusing to start: $secret_file must be owned by root:root with mode 0600" >&2
    exit 1
  fi
done
