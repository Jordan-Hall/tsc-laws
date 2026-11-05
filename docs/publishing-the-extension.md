# Publishing the VS Code extension

The `marketplace` job in `.github/workflows/laws.yml` publishes the extension to the Visual Studio Marketplace and to Open VSX
when a `laws-v*` tag is pushed. It stays off until you set the `VSCODE_PUBLISH` variable. Each store is its own step. Open VSX is skipped with a notice when its token is missing, and a failure at one store does not stop the other from being tried. Running
the job again for a version that is already live is not a failure.

Do these steps once, in this order. Never paste a token into chat or a commit.

## Visual Studio Marketplace: trusted publishing (recommended)

Trusted publishing needs no stored token. The workflow asks GitHub for a short-lived OIDC token and `vsce publish --oidc`
exchanges it for a short-lived Marketplace token. The `marketplace` job has `id-token: write` for this, on that job only.

1. Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account.
2. Create the publisher. Choose "Create publisher" and set the ID to `TS-Laws` (the publisher in this repository was created as "TS Laws" with the ID `TS-Laws`). The ID must match the `publisher` field in
   `packages/vscode-tslaws/package.json`.
3. Open the publisher and add a trusted publishing policy with these fields:
   - Policy name: any name, for example `tsc-laws release`.
   - Provider: GitHub Actions.
   - Repository owner: `Jordan-Hall`.
   - Repository: `tsc-laws` (the name only, not the URL).
   - Workflow: `laws.yml`.
   - Environment: leave empty (the job uses no environment).
4. Do not create `VSCE_PAT`. With no `VSCE_PAT` secret the job uses OIDC.

The workflow pins `@vscode/vsce` at 4.1.0. Version 4.0.0 is reported to have a token-exchange bug fixed in 4.1.0, and 4.x
needs Node 22 or later (the job uses Node 24). Check the version before you raise the pin.

Not yet exercised: the OIDC audience and claims come from the vsce documentation, and no real tag run has used them. Treat
the first release as the test, and use the fallback below if the exchange is rejected. Sources:
[microsoft/vscode-vsce README](https://github.com/microsoft/vscode-vsce#readme) and
[microsoft/vsmarketplace issue 1422](https://github.com/microsoft/vsmarketplace/issues/1422).

## Visual Studio Marketplace: personal access token (fallback)

Use this only if trusted publishing does not work. When the `VSCE_PAT` secret exists, the job uses it and not OIDC.

1. The token comes from Azure DevOps, so you need an Azure DevOps organisation. If you do not have one, create it at
   <https://dev.azure.com> with the same Microsoft account. Create the publisher first, as in steps 1 and 2 above.
2. In Azure DevOps open "User settings", then "Personal access tokens", then "New Token".
   - Organisation: "All accessible organizations".
   - Expiration: one year (the longest the portal offers by default).
   - Scopes: choose "Custom defined", select "Show all scopes", and tick "Marketplace" then "Manage". Tick nothing else.
3. Copy the token once. It is not shown again.
4. Add it to the repository. The command prompts for the value, so it never appears in shell history or chat:

   ```sh
   gh secret set VSCE_PAT -R Jordan-Hall/tsc-laws
   ```

## Open VSX

1. Create an Eclipse Foundation account at <https://accounts.eclipse.org>.
2. Sign in at <https://open-vsx.org> with it and link your GitHub account.
3. Sign the Eclipse publisher agreement from your profile page. Publishing is refused until you have signed it.
4. Create a token at <https://open-vsx.org/user-settings/tokens>.
5. Create the namespace once. This puts the token on the command line for a moment, so run it from a private terminal:

   ```sh
   npx ovsx create-namespace TS-Laws -p <token>
   ```

6. Add the token to the repository:

   ```sh
   gh secret set OVSX_PAT -R Jordan-Hall/tsc-laws
   ```

You can do just one store. Open VSX is skipped with a notice when `OVSX_PAT` is missing.

## Switch it on

```sh
gh variable set VSCODE_PUBLISH --body true -R Jordan-Hall/tsc-laws
```

The next `laws-v*` tag publishes. To switch it off again, delete the variable or set it to anything but `true`.

## Verify the first release

1. Open the workflow run for the tag and read the `marketplace` job summary. It lists the version, the SHA-256 of the
   `.vsix`, and one line per store: published, already published, skipped or FAILED.
2. Compare the SHA-256 with the `.vsix` attached to the GitHub release (`sha256sum tslaws-vscode-<version>.vsix`).
3. Open <https://marketplace.visualstudio.com/items?itemName=TS-Laws.vscode-tslaws> and
   <https://open-vsx.org/extension/tsc-laws/vscode-tslaws>. The extension name is the `name` field in `package.json`.
4. Install it from the store, not from the file:

   ```sh
   code --install-extension TS-Laws.vscode-tslaws
   ```

The Marketplace scans each upload before the listing appears, which usually takes a few minutes. A brand new publisher also
waits for verification of its first extension, so the first listing can take longer (up to a day). A step that succeeded
but shows no page yet is normal. Only a FAILED line needs action.

Re-running a failed job is safe. A version that a store already has is reported with a notice and counted as done.

## Rotate or revoke a token

Trusted publishing has no token to rotate. To stop it, delete the policy on the publisher. For the tokens:

1. Create the replacement token with the same scope, as above.
2. Run `gh secret set VSCE_PAT -R Jordan-Hall/tsc-laws` (or `OVSX_PAT`) and enter the new value.
3. Revoke the old token: in Azure DevOps under "Personal access tokens", or at open-vsx.org/user-settings/tokens.
4. If a token may have leaked, revoke it first, then replace it.

A Marketplace PAT lasts one year. Put a reminder in your calendar for a month before the expiry. An expired token makes
the Marketplace step fail with an authentication error, while the Open VSX step still runs.

## What the listing needs

`packages/vscode-tslaws/package.json` already satisfies most of this:

- Publisher: `publisher` is `TS-Laws`, the ID of the Marketplace publisher (Open VSX needs the namespace to match it).
- Icon: `icon` points to `icon.png`, and `galleryBanner` sets the colour and theme.
- Licence: `license` is `Apache-2.0`. The repository has a `LICENSE` file.
- Repository, homepage and issues: `repository`, `homepage` and `bugs` all point to the GitHub repository.
- Categories and keywords: `categories` are "Linters" and "Programming Languages", and `keywords` are set.
- README: `packages/vscode-tslaws/README.md` is shown as the listing page.

Still to do before a release you want to show off: the README has no screenshots. Add images to the package folder and
reference them with relative links (the Marketplace rejects SVG images and, for relative links, needs the `repository` field,
which is set). Build with `npx @vscode/vsce package` and read the warnings.
