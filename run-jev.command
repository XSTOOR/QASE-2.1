#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="$PWD/.tooling/node-v24.22.1-darwin-arm64/bin:$PATH"
exec npm run start:jev
