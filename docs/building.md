# Building the desktop app

Install dependencies from the repository root with `pnpm install`.

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
