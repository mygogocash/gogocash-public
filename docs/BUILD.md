# Building and verifying the gogocash_cashback program

The onchain program lives in `programs/gogocash-cashback` (crate and library
name `gogocash_cashback`). It implements contract v0 (`docs/CONTRACT.md`
section 3): eight instructions (`initialize`, `claim`, `pause`, `unpause`,
`update_config`, `propose_admin`, `accept_admin`, `withdraw`), the `Vault` and
`Receipt` accounts, the `PayoutClaimed` event and the error table 6000-6023.
`docs/SECURITY-MODEL.md` maps each vulnerability class to the program check
and the LiteSVM test that covers it.

Every build runs in GitHub Actions. Nothing in this document needs a local
Solana toolchain.

## Toolchain

| Tool | Version | Source and check |
| --- | --- | --- |
| Anchor CLI, `anchor-lang` | 1.2.0 | `otter-sec/anchor` release binary, SHA-256 pinned in the workflow |
| Agave (`cargo-build-sbf`) | 4.3.0 | `anza-xyz/agave` release tarball, SHA-256 pinned |
| platform-tools | v1.57 (Rust 1.95.0) | `anza-xyz/platform-tools` release tarball, SHA-256 pinned |
| Host Rust | 1.97.1 | `rust-toolchain.toml`; used for rustfmt, clippy, the IDL build and LiteSVM |
| LiteSVM | =0.16.0 | crates.io, in the separate `tests-litesvm/` workspace |
| solana-security-txt | =1.1.3 | crates.io |
| solana-verify | 0.5.2 | `solana-foundation/solana-verifiable-build` release binary, SHA-256 pinned |
| Trivy | 0.72.0 | `aquasecurity/trivy` release tarball, SHA-256 from its signed checksums file |

Agave, platform-tools and Anchor publish no checksum files. Their pinned
SHA-256 values were computed from the downloaded release assets and match the
digests GitHub reports for those assets. `cargo-build-sbf` downloads
platform-tools without checking them, so CI pre-seeds
`~/.cache/solana/v1.57/platform-tools` from the checksummed tarball, and
`cargo-build-sbf` reuses it. platform-tools is not cached between runs: a
restored compiler tree would skip the checksum, so every build downloads the
tarball (about 531 MB) and verifies it first. Nothing is installed with
`curl | sh`.

## CI: `.github/workflows/program.yml`

Runs on every pull request and on pushes to `main`. The `program` job is the
single required status. It fails unless every job below succeeded.

| Job | What it proves |
| --- | --- |
| `lockfiles` | `Cargo.lock` and `tests-litesvm/Cargo.lock` resolve. If either is committed, it is current (`--locked`). Both are uploaded as the `cargo-lockfiles` artifact, and every other job uses exactly those. |
| `fmt-clippy` | `cargo fmt --check` passes in both workspaces, and `cargo clippy --all-targets -- -D warnings` passes for the program. `cargo check --features mainnet` must fail with the contract's `compile_error!` (contract v0 has no mainnet program id, §2.4). |
| `build` | `anchor build --ignore-keys --arch v3` succeeds without changing `Cargo.lock`. `scripts/check-sbpf.mjs` shows that `target/deploy/gogocash_cashback.so` is SBPFv3, and the security.txt marker is in the binary. The IDL has exactly the 8 contract instructions with their §3.3 discriminators, plus `Vault`, `Receipt` and `PayoutClaimed`, and equals the committed `idl/gogocash_cashback.devnet.json`. Uploads the `.so` and the IDL as artifacts. |
| `litesvm` | `cargo test --no-fail-fast` in `tests-litesvm/` against the `.so` that `build` uploaded: the artifact checks, every instruction's handler checks in contract order with their exact error codes and messages, the Anchor account checks, the contract's decode vectors, and the compute-unit budget (`claim` at most 45,000 CU). The suite writes `cu-report.json` (compute units per instruction, tied to the `.so` by its sha256), which the job prints in the run summary and uploads as the `cu-report` artifact. Clippy also runs for this workspace. |
| `trivy` | No HIGH or CRITICAL advisory in `Cargo.lock` or `tests-litesvm/Cargo.lock`. |
| `crate-age` | Every crates.io package in both lockfiles was published at least 7 days ago (the org's release-age hold), using the `pubtime` field of the crates.io sparse index. `scripts/check-crate-age.mjs` treats an unknown publish time as too new. |

### Why `--arch v3`

SBPFv3 is the current program format. `cargo-build-sbf` 4.3.0 and
`solana-verify` 0.5.2 both default to v0, so every build passes `--arch v3`
explicitly. The loader reads the SBPF version from the ELF header's `e_flags`
field (a little-endian u32 at byte offset 0x30). `scripts/check-sbpf.mjs`
fails the build unless that value is 3. Run
`node scripts/check-sbpf.mjs --self-test` to see the checker reject other
values.

### The IDL

`anchor build` writes `target/idl/gogocash_cashback.json`. The committed copy
is `idl/gogocash_cashback.devnet.json`, the per-cluster name contract v0 §2.4
gives it (v0 builds devnet only). Any IDL change, including a doc comment on
an instruction, an account or a field, fails CI until you update the committed
copy in the same pull request from the `gogocash_cashback-idl` artifact.

### Why Trivy skips `package-lock.json`

`package-lock.json` still carries a known `bigint-buffer` advisory. Ticket R3
removes that dependency. Until then the program workflow scans only the Rust
lockfiles. Add the npm lockfile to the scan when R3 lands.

### Lockfiles

`Cargo.lock` and `tests-litesvm/Cargo.lock` are committed, and every job
checks them with `--locked`. They came from CI's `cargo-lockfiles` artifact;
five crates in the fresh program lockfile were inside the 7-day hold and were
pinned back to the previous release, with the checksum from the crates.io
index (`lazy_static` 1.5.0, `solana-address` 2.8.0, `wincode` 0.6.1,
`zerocopy` and `zerocopy-derive` 0.8.58).

The host toolchain (Rust 1.97.1) has no stable setting that makes the
resolver respect a minimum publish age, so a fresh resolution can pick up a
crate released yesterday. The `crate-age` job catches that. If it fails, pin
each listed crate back with `cargo update -p <name> --precise <older-version>`
in the workspace that owns the lockfile, and commit that lockfile.

`tests-litesvm` is its own cargo workspace. A fresh resolution of
`litesvm =0.16.0` picks Agave 4.3.0 runtime crates, and litesvm 0.16.0 was not
written for them. `tests-litesvm/seed-lockfile.sh` therefore starts from
litesvm v0.16.0's own `Cargo.lock` (SHA-256 checked) and lets cargo add this
crate. Never run `cargo generate-lockfile` in `tests-litesvm/`.

## Release: `.github/workflows/verifiable-build.yml`

Runs on `v*` tags and on manual dispatch (no inputs). It:

1. requires a committed `Cargo.lock` on tags, and checks it against the
   7-day release-age hold;
2. runs
   `solana-verify build --library-name gogocash_cashback --base-image <digest> --arch v3`
   in `solanafoundation/solana-verifiable-build@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd`;
3. runs the same SBPFv3 and security.txt checks on that binary;
4. hashes it and uploads the `.so`, its `sha256sum`, and its
   `solana-verify get-executable-hash` value as the
   `gogocash_cashback-verifiable` artifact;
5. in a second job on a fresh runner, downloads that artifact, checks it has
   the sha256 the build job recorded, and runs the LiteSVM suite against it.

Steps 1 to 4 run no host-side third-party Rust code. The LiteSVM suite
compiles and runs build scripts from several hundred crates, which is why it
runs on a separate runner and only ever sees a copy of the published bytes.
Treat a release artifact as good only when the whole run is green.

It deploys nothing and uses no secrets.

### Why the image is pinned by digest

The digest is Docker Hub tag `4.3.0` (Agave v4.3.0, Rust 1.97.1,
platform-tools v1.57), and it matches the entry for 4.3.0 that solana-verify
0.5.2 ships. A digest names immutable content; a tag can be re-pointed.

The digest is passed explicitly for another reason. Without `--base-image`,
solana-verify 0.5.2 picks the image from `[workspace.metadata.cli]` in
`Cargo.toml` (set to `4.3.0`), or, if that is missing, from the solana crate
versions in `Cargo.lock`. Anchor 1.2 depends on the solana-* 3.x crates, so
the lockfile route would pick a 3.x image.

## Program id and keys

`declare_id!` holds a placeholder:

```
HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje
```

It is the base58 encoding of `sha256("gogocash_cashback placeholder program id v0")`.
A hash output is not an ed25519 key that anyone generated, so nobody holds its
private key, and nothing can be deployed to it. Reproduce it with:

```sh
node -e 'const c=require("crypto");const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";const h=c.createHash("sha256").update("gogocash_cashback placeholder program id v0").digest();let n=BigInt("0x"+h.toString("hex")),s="";while(n>0n){s=A[Number(n%58n)]+s;n/=58n}for(const b of h){if(b)break;s="1"+s}console.log(s)'
```

The LiteSVM suite recomputes it in a unit test. Replace it with the real
program address before any deployment.

This repository holds no keypair, and the build needs none. Two details:

- `anchor build --ignore-keys` skips Anchor's program-id check. Without the
  flag, Anchor creates a keypair to compare against.
- `cargo-build-sbf` always writes a random
  `target/deploy/gogocash_cashback-keypair.json`. No flag disables this. CI
  deletes it after every build and saves the cargo cache only if that
  deletion succeeded. The cache paths also exclude
  `target/deploy/*-keypair.json`. Artifacts carry only the `.so`, by explicit
  path. `.gitignore` covers `target/` and `*-keypair.json`.
