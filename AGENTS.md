Use the following reference when developing Salesforce CLI plugins: https://github.com/salesforcecli/plugin-dev/blob/main/README.md

## Publishing to npm

Publishing is tag-driven via `.github/workflows/publish-npm.yml`; pushing a `v*` tag whose commit is on main triggers a build, `npm publish` (public, with provenance), and a GitHub release with generated notes. To publish a new version:

1. Verify CI's steps pass locally: `npx -y yarn@1.22.22 install --frozen-lockfile` and `yarn build` (CI pins yarn 1.22.22 and Node 22).
2. On a clean main, run `npm version <major|minor|patch>`. This bumps `package.json` and `npm-shrinkwrap.json`, makes a commit whose message is the bare version (e.g. `1.8.0`), and creates the annotated tag `v<version>` - matching all prior releases.
3. Push main, then the tag: `git push && git push origin v<version>`. The workflow rejects tags whose commit is not on main, so push main first.
4. Confirm the `publish-npm` run succeeds (`gh run watch`). `workflow_dispatch` runs a dry-run publish only, useful for testing the pipeline without releasing.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (tomcarman/sf-raven-cli) via the `gh` CLI; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.