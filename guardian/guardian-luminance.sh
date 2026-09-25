#!/bin/sh
# Thin wrapper. Home Assistant calls python3 on guardian-luminance.py directly
# so a Windows CRLF copy of THIS file cannot break the command_line sensor.
# SSH/manual: exec the same interpreter HA core uses. The SSH add-on has no
# python3 - use Measure now, or docker exec into the homeassistant container.
set -eu
DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec python3 "$DIR/guardian-luminance.py" "$@"
