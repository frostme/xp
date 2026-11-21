#!/usr/bin/env bash
# Run from an xp checkout with both published PR objects, Bun,
# and a running disposable provider. Provider configuration follows the storage fixtures.
set -euo pipefail

proof_dir=$(cd "$(dirname "$0")" && pwd)
repo=$(git rev-parse --show-toplevel)
management=2e0f08370e3065a7ff544908adc53d6697352234
analytics=7af23610dea44ae689afd6691ea9e14cb1ecd9bd
scratch=$(mktemp -d "${TMPDIR:-/tmp}/xp-combined.XXXXXXXX")
git -C "$repo" worktree add --detach "$scratch" "$management"
trap 'git -C "$repo" worktree remove --force "$scratch"' EXIT
cd "$scratch"
git -c user.name=coexistence -c user.email=coexistence@example.invalid -c rerere.enabled=false \
    merge --no-commit --no-ff -Xours "$analytics"
git apply --index "$proof_dir/resolutions.patch"
expected=$(cat "$proof_dir/verified-tree.txt")
actual=$(git write-tree)
if [[ "$actual" != "$expected" ]]; then
  echo "Combined tree differs from verified tree ($actual)." >&2
  exit 1
fi
HUSKY=0 bun install --frozen-lockfile
bun run typecheck
if (( $# == 0 )); then set -- postgres; fi
for database in "$@"; do
  XP_DATABASE="$database" bunx --no-install vitest run --config vitest.integration.config.ts combined-features --reporter=verbose
done
