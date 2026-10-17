# Releasing

The release workflow runs for `v*` tags. It waits for CI to pass on the tagged commit, builds and checks the launcher and all seven native packages, then publishes the platform packages before the launcher.

Publishing uses npm trusted publishing (OIDC); there is no npm token secret. Configure a GitHub Actions trusted publisher on each of these npm packages:

- `tsc-ts`
- `@tsc-ts/darwin-arm64`
- `@tsc-ts/darwin-x64`
- `@tsc-ts/linux-arm64-gnu`
- `@tsc-ts/linux-arm64-musl`
- `@tsc-ts/linux-x64-gnu`
- `@tsc-ts/linux-x64-musl`
- `@tsc-ts/win32-x64-msvc`

Use these publisher settings on every package:

- Organization: `vercel-labs`
- Repository: `tsc-ts`
- Workflow: `release.yml`
- Environment: `Release`

The publish job uses Node.js 24, grants `id-token: write`, and publishes with provenance. npm requires a trusted publisher configuration for every package; a missing configuration fails the publish job.

To release, set the version in `packages/tsc-ts/package.json`, commit the change to `main`, and push a matching `v<version>` tag on the green commit.
