#!/bin/zsh
set -u

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
open "file://${APP_DIR}/index.html"
