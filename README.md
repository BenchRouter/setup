# @benchrouter/setup

Target-repo setup CLI for BenchRouter.

Run it from the repository you want to route through BenchRouter:

```bash
npx @benchrouter/setup init \
  --setup-key br_setup_... \
  --route-id product/route \
  --name "Route Name" \
  --incumbent-model provider/model
```

The setup key comes from the logged-in BenchRouter setup page. It is short-lived and scoped to one GitHub App installation and repo. When `init` fetches the setup packet with that key, BenchRouter returns one-time Production and GitHub Actions API keys for the target agent to install after user approval.

If npm is unavailable, the public GitHub package can be run with:

```bash
npx github:BenchRouter/setup init \
  --setup-key br_setup_... \
  --route-id product/route \
  --name "Route Name" \
  --incumbent-model provider/model
```

## Commands

```bash
npx @benchrouter/setup init --help
npx @benchrouter/setup models
npx @benchrouter/setup doctor
```

`init` fetches the BenchRouter setup packet, writes BenchRouter scaffold files, updates `package.json`, and adds the minimal `.env.example` entry for the BenchRouter API key. Existing files are preserved by default on re-init. The generated workflow runs on the setup PR: it asks BenchRouter for an eval plan, skips model runs when the same route/eval/covered-code fingerprint already has evidence, uploads only the model arms that need fresh evidence, and fails the PR check if the route cannot call BenchRouter.

The generated eval harness reads `.benchrouter/cases.json` and fails until the repo has at least three non-TODO route-specific cases with distinct inputs, including one critical case. There is no passing smoke eval.

BenchRouter eval is not a substitute for product CI. If provider wiring changes at a selected call site, update existing product tests/mocks so they exercise the BenchRouter-wired runtime path, then run the relevant product tests/build before opening the setup PR.

The route ID belongs at the selected LLM call site as the OpenAI-compatible `model` value. Do not add a repo-global `BENCHROUTER_MODEL`; repos with multiple routes should send a different route ID per call site.

`models` prints exact enabled BenchRouter model IDs, one per line. If `init` rejects the repo's current incumbent model, do not silently substitute another model. Use `models` only to inspect enabled IDs, then rerun `init` after the user explicitly approves one exact replacement.

`doctor` validates expected BenchRouter files, real eval case coverage, package script and dependencies, env example entries, generated helper syntax, PR workflow wiring, and incumbent model id against the BenchRouter catalog. When it can identify the GitHub repo, it also verifies the `BENCHROUTER_API_KEY` Actions secret exists.

Before opening a PR, use:

```bash
npx @benchrouter/setup doctor --repo owner/repo
```

After the PR is merged, verify the config file is readable on the default branch:

```bash
npx @benchrouter/setup doctor --repo owner/repo --check-default-branch
```

The CLI never writes a raw BenchRouter API key to disk.
