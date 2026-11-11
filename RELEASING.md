# Releasing

A release is one run of the `Release` workflow. It publishes the package to npm from CI; nobody publishes from a laptop.

1. In a pull request, set the new version in `package.json` and `src/version.ts` (a test keeps them equal). Merge it.
2. Start the workflow on the default branch, with "Run workflow" on the Actions tab or from a terminal:

   ```sh
   gh workflow run release.yml
   ```

3. The workflow runs the CI checks, publishes `@braskai/api` to npm with provenance, then tags the commit `v` plus the
   version and makes the GitHub Release.

The workflow refuses to run from any other branch, and refuses a version that is already tagged or already on npm.
A pre-release version goes out as `latest` while no stable version exists, and as `next` once one does.
A published version cannot be replaced: to fix one, release the next.
If a run fails after npm took the version, make the release by hand:
`gh release create v<version> --target <the commit> --generate-notes`.

## Set up once

npm trusts the workflow itself (trusted publishing), so this repository holds no npm token.

- On npmjs.com, a maintainer of `@braskai/api` names the publisher: GitHub Actions, repository
  `braskai/rask-sdk-typescript`, workflow `release.yml`, environment `npm`. From a terminal, with a current npm 11
  (`npm install -g npm@11`; older ones have no `npm trust`), that is:

  ```sh
  npm trust github @braskai/api --repository braskai/rask-sdk-typescript --file release.yml --environment npm --allow-publish
  ```

- In this repository, the environment `npm` takes only the default branch (Settings → Environments → `npm` →
  Deployment branches and tags: selected branches and tags, one rule, the default branch). That is what keeps a run
  on any other branch from publishing. If the default branch is renamed, change the rule with it.
