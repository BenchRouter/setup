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

The setup code comes from the logged-in BenchRouter setup page. It is short-lived and scoped to one GitHub App installation and repo.

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

`init` fetches the BenchRouter setup packet, writes scaffold files, updates `package.json`, and adds `.env.example` entries.

`doctor` validates that the expected BenchRouter setup files, package script, and env example entries exist before opening a PR.

The CLI never writes a raw BenchRouter API key to disk.
