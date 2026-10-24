# Building the desktop app

Install dependencies from the repository root with `pnpm install`.

## Development

From the repository root or `apps/web`, run:

```powershell
pnpm tauri dev
```

This starts the frontend dev server and desktop app. The root `tauri` command
forwards to `apps/web`; other Tauri commands, such as `pnpm tauri build`, also
work from either directory.

## Release build with a version bump

From the repository root, run:

```powershell
pnpm release
```

This increments the minor version and resets the patch to zero (for example,
`0.1.3` becomes `0.2.0`), updates both `apps/web/src-tauri/tauri.conf.json` and
`apps/web/src-tauri/Cargo.toml`, then builds the frontend, Rust app, and installers.
It stops before building if the two versions disagree.

You can also run `pnpm release` from `apps/web`.

To preview the next version without editing files or building, run this from the
repository root:

```powershell
pnpm version:minor --dry-run
```

`pnpm version:minor` applies the bump without building. Regular `pnpm build`
(frontend only) and `pnpm tauri dev` do not change the version.

If a release build fails, the bumped version remains in the files. To retry
without another bump, run:

```powershell
cd apps/web
pnpm tauri build
```

Cargo updates the desktop `Cargo.lock` package version during the build. Commit
the version changes and resulting lockfile change with the source used for the
release. Create the corresponding `vX.Y.Z` tag on that commit. These commands
do not commit, tag, or publish anything automatically.

Outputs are under `apps/web/src-tauri/target/release`: `app.exe` and installers
in `bundle/nsis` and `bundle/msi`.

## Offline Rust dependencies

The repository-level `vendor` directory contains the locked registry crates for
both Rust projects: the Tauri app and the standalone proxy crate. The root
`.cargo/config.toml` replaces crates.io with this directory. Keep both
`Cargo.lock` files checked in; do not commit `target` build output.

When dependencies change, refresh the vendor directory from the repository root
on a machine with crates.io access:

```powershell
cargo vendor --locked --manifest-path apps/web/src-tauri/Cargo.toml --sync core/proxy/Cargo.toml vendor
```

The `--sync` option includes the proxy crate's separate lockfile, including its
development dependencies. Commit the refreshed `vendor` tree together with any
intentional manifest or lockfile changes. Keep the Cargo source replacement in
`.cargo/config.toml`; `cargo vendor` prints the equivalent configuration when
run.

On the Windows build machine, verify the desktop app and proxy crate without
registry access:

```powershell
cargo build --locked --offline --manifest-path apps/web/src-tauri/Cargo.toml
cargo test --locked --offline --manifest-path core/proxy/Cargo.toml
```

Cargo's `--offline` flag prevents Cargo from accessing registries. These Rust
checks do not verify frontend package availability: Node dependencies are
separate and can be checked with `pnpm install --offline --frozen-lockfile`.
