# Publishing the VS Code extension

The `marketplace` job in `.github/workflows/laws.yml` publishes the extension to the Visual Studio Marketplace and to Open VSX
when a `laws-v*` tag is pushed. It stays off until you set the `VSCODE_PUBLISH` variable. Each store is its own step. Open VSX publishes with trusted publishing, or with an `OVSX_PAT` token when that secret exists, and a failure at one store does not stop the other from being tried. Running
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

## Open VSX: trusted publishing (recommended)

Per the [Open VSX Trusted Publishing guide](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing), the registry issues a short-lived publishing token (about five minutes) to a workflow that matches a trusted publisher you have registered, so there is no long-lived secret to store. The workflow runs `ovsx@1.3.0 publish --trusted-publishing`, and the `marketplace` job already has `id-token: write`.

This has not been exercised by a real tag run yet. Check the first publish.

The namespace must be exactly `TS-Laws`, the `publisher` in `packages/vscode-tslaws/package.json`. The guide lists this as a known limitation: the check that authorises a trusted-publishing token compares the namespace case-sensitively. A namespace created as `ts-laws` will not match.

1. Sign in at <https://open-vsx.org> with your GitHub account.
2. Accept the Eclipse publisher agreement from your profile page. Publishing is refused until you have.
3. Create the namespace as `TS-Laws` (user settings, Namespaces). If you already created `ts-laws`, create `TS-Laws` as well, claim that one, and leave `ts-laws` alone or delete it. It cannot be used for this extension.
4. Open the `TS-Laws` namespace page and click Claim Ownership. This opens a request that the Open VSX team approves. Until it is approved, extensions published there can stay inactive, and you cannot register a trusted publisher.
5. One-time bootstrap: publish the first version with an access token. The guide says a trusted publisher can only be registered for an extension that already has an active version. Create a token at <https://open-vsx.org/user-settings/tokens>, then do either of these:
   - Set the secret for exactly one release: `gh secret set OVSX_PAT -R Jordan-Hall/tsc-laws`, push the tag, and delete the secret afterwards.
   - Or publish the `.vsix` from the GitHub release by hand, typing the token in your own terminal, never in chat: `npx ovsx@1.3.0 publish tslaws-vscode-<version>.vsix -p <token>`
6. Open Trusted Publishers in the sidebar and add one with these fields:
   - Provider: GitHub Actions
   - Repository owner: `Jordan-Hall`
   - Repository: `tsc-laws`
   - Workflow: `laws.yml`
   - Environment: leave empty (the job uses no environment)
7. Delete the `OVSX_PAT` secret if you set one. From the next release the workflow uses trusted publishing.

Keep at least one version of the extension active. If every version is deleted, the registration stops matching until a version is active again.

If the publish fails with "no trusted publisher matches", the registry gives that one message for every mismatch: a missing first version, a namespace with the wrong casing, or wrong registration fields. The workflow prints an error listing each. If the namespace is not verified, it says to claim it. Only the Open VSX step fails; the Marketplace step is unaffected.

### Fallback: an access token

If a repository secret `OVSX_PAT` exists, the step uses it instead of trusted publishing.

1. Create a token at <https://open-vsx.org/user-settings/tokens>.
2. Create the namespace once as `TS-Laws`, if you have not. This puts the token on the command line for a moment, so run it from a private terminal:

   ```sh
   npx ovsx create-namespace TS-Laws -p <token>
   ```

3. Add the token to the repository:

   ```sh
   gh secret set OVSX_PAT -R Jordan-Hall/tsc-laws
   ```

You can do just one store.

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
