#!/usr/bin/env bash
# Seeds tests-litesvm/Cargo.lock from the lockfile litesvm v0.16.0 was
# released and tested with, then lets cargo add this crate's own entries.
#
# Why a fresh resolution is not good enough: litesvm 0.16.0 declares caret
# requirements on many Agave and solana-* crates. Resolving them today picks
#   * the Agave 4.3.0 runtime crates (agave-feature-set, solana-program-runtime,
#     ...), which litesvm 0.16.0 does not compile against; litesvm 0.17.0 is
#     the Agave 4.3 port (LiteSVM/litesvm PR #425), and
#   * solana-* SDK minor releases that moved from wincode 0.5 to wincode 0.6
#     (for example solana-account 4.7.0, solana-loader-v3-interface 8.1.1),
#     while litesvm 0.16.0 is written against wincode 0.5.
# Cargo keeps every entry of an existing lockfile that still satisfies the
# manifests, so starting from litesvm's own lockfile reproduces the graph its
# CI tested. litesvm's path crates and dev-only packages are dropped.
#
# No-op once tests-litesvm/Cargo.lock exists (for example after it is committed).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lock="${here}/Cargo.lock"

if [[ -f "${lock}" ]]; then
  echo "tests-litesvm/Cargo.lock already present; not seeding."
  exit 0
fi

# Tag v0.16.0 is annotated (tag object 47189d3a46078b336b02171fc6c0fe8531fb2a2a);
# it dereferences to this commit.
commit="384675bd114f3b9ac0d93ede55a65ac0cbd6ccc0"
url="https://raw.githubusercontent.com/LiteSVM/litesvm/${commit}/Cargo.lock"
sha256="e7cae648ef056e12b3ec113660b6b524367986a471bfe9ca7bf8089250018104"

tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "${tmp}" "${url}"
if command -v sha256sum >/dev/null 2>&1; then
  echo "${sha256}  ${tmp}" | sha256sum -c -
else
  echo "${sha256}  ${tmp}" | shasum -a 256 -c -
fi
cp "${tmp}" "${lock}"

# Resolve on top of the seed. `cargo fetch` keeps compatible locked versions;
# `cargo generate-lockfile` would discard them and re-resolve from scratch.
# Run from this directory so rustup applies the repository's rust-toolchain.toml.
cd "${here}"
cargo fetch
echo "Seeded tests-litesvm/Cargo.lock from litesvm ${commit} (sha256 ${sha256})."
