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

## Multiple routes

A repo can evaluate any number of routes. Routes live under `routes:` in `.benchrouter/benchrouter.yml`. The generated GitHub Actions workflow derives a matrix from that file at CI time and runs one independent eval per route — each route gets its own candidate selection, its own eval run, and its own PR gate. To add a route later, edit `.benchrouter/benchrouter.yml` only; you do not regenerate the workflow.

Scaffold several routes at once by repeating `--route-id`/`--name`/`--incumbent-model` (paired in order; the first triple is the primary route):

```bash
npx @benchrouter/setup init --setup-key br_setup_... \
  --route-id product/route-a --name "Route A" --incumbent-model provider/model-a \
  --route-id product/route-b --name "Route B" --incumbent-model provider/model-b
```

### Keying cases by route

Each entry in `.benchrouter/cases.json` may carry a `route` field set to the **stable** route ID (the `route_id` in `benchrouter.yml`). The CI eval runner selects the cases whose `route` matches the route under test; a case with no `route` runs for every route, so single-route repos need no annotation.

### Stable vs PR-tagged route IDs

On a pull request BenchRouter creates a PR-tagged preview route id (`<route>-pr-<N>`) so preview traffic is isolated. The eval runner sends that PR-tagged id to the proxy as the `model` value, but selects cases by the **stable** id, which the CI kit exposes as `BENCHROUTER_BASE_ROUTE_ID`. Do not derive the stable id by string-stripping the `-pr-...` suffix (it is not always reversible). Keep all runtime call sites on the stable route id; during a PR's eval window BenchRouter auto-resolves the stable id to that PR's matching PR-tagged preview route, so no deployment-context headers are needed.

`models` prints curated BenchRouter candidate model IDs, one per line. BenchRouter route manifests accept any OpenRouter model ID as the incumbent. If `init` rejects the repo's current incumbent model because OpenRouter does not recognize it, do not silently substitute another model; rerun `init` only after the user explicitly approves one exact replacement.

`doctor` validates expected BenchRouter files, real eval case coverage, package script and dependencies, env example entries, generated helper syntax, and PR workflow wiring. When it can identify the GitHub repo, it also verifies the `BENCHROUTER_API_KEY` Actions secret exists.

Before opening a PR, use:

```bash
npx @benchrouter/setup doctor --repo owner/repo
```

After the PR is merged, verify the config file is readable on the default branch:

```bash
npx @benchrouter/setup doctor --repo owner/repo --check-default-branch
```

The CLI never writes a raw BenchRouter API key to disk.
