# Releasing

A release is a GitHub Release. Publishing one sends the package to npm from CI; nobody publishes from a laptop.

1. In a pull request, set the new version in `package.json` and `src/version.ts` (a test keeps them equal). Merge it.
2. Publish a GitHub Release whose tag is `v` plus that version. Without `--target`, the tag goes on the default branch:

   ```sh
   gh release create v3.0.0-alpha.1 --generate-notes --prerelease
   ```

3. The `Release` workflow runs the CI checks on the tag and publishes `@braskai/api` to npm, with provenance.

The workflow refuses a tag that is not the version in `package.json`, and a tag that is not on the default branch.
A pre-release version goes out as `latest` while no stable version exists, and as `next` once one does.
A published version cannot be replaced: to fix one, release the next.

## Set up once

npm trusts the workflow itself (trusted publishing), so this repository holds no npm token.

- On npmjs.com, a maintainer of `@braskai/api` names the publisher: GitHub Actions, repository
  `braskai/rask-sdk-typescript`, workflow `release.yml`, environment `npm`. From a terminal that is:

  ```sh
  npm trust github @braskai/api --repository braskai/rask-sdk-typescript --file release.yml --environment npm --allow-publish
  ```

- In this repository, the environment `npm` takes only `v*` tags.
