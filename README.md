# @benchrouter/setup

Target-repo setup CLI for BenchRouter.

Run it from the repository you want to route through BenchRouter:

```bash
npx @benchrouter/setup init \
  --setup-code br_setup_... \
  --route-id product/route \
  --name "Route Name" \
  --incumbent-model provider/model
```

The setup key comes from the logged-in BenchRouter setup page. It is short-lived and scoped to one GitHub App installation and repo. When `init` fetches the setup packet with that key, BenchRouter returns one-time Production and GitHub Actions API keys for the target agent to install after user approval.

Until the npm package is published, the public GitHub package can be run with:

```bash
npx github:BenchRouter/setup init \
  --setup-code br_setup_... \
  --route-id product/route \
  --name "Route Name" \
  --incumbent-model provider/model
```

## Commands

```bash
npx @benchrouter/setup init --help
npx @benchrouter/setup doctor
```

`init` fetches the BenchRouter setup packet, writes scaffold files, updates `package.json`, and adds `.env.example` entries. The generated workflow runs on the setup PR: it imports the PR commit's manifest as a PR-tagged BenchRouter route, uploads that PR route's eval result, and fails the PR check if the route cannot call BenchRouter.

`doctor` validates expected BenchRouter files, package script, env example entries, generated helper syntax, PR workflow wiring, and incumbent model id against the BenchRouter catalog. When it can identify the GitHub repo, it also verifies the `BENCHROUTER_API_KEY` Actions secret exists.

Before opening a PR, use:

```bash
npx @benchrouter/setup doctor --repo owner/repo
```

After the PR is merged, verify the config file is readable on the default branch:

```bash
npx @benchrouter/setup doctor --repo owner/repo --check-default-branch
```

The CLI never writes a raw BenchRouter API key to disk.
