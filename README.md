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

The setup key comes from the logged-in BenchRouter setup page. It is short-lived and scoped to one GitHub App installation and repo. When `init` fetches the setup packet with that key, BenchRouter returns one-time keys for the target agent to install after user approval:

- Runtime/host key: `BENCHROUTER_API_KEY`
- GitHub Actions eval secret: `BENCHROUTER_EVAL_API_KEY`

The values are printed once. Store them then; if a value is lost, return to the setup/dashboard flow to mint a new key.

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

`init` fetches the BenchRouter setup packet, writes BenchRouter scaffold files, updates `package.json`, and adds runtime-only `.env.example` entries such as `BENCHROUTER_API_KEY` and the call site's `base_url_env`. Existing files are preserved by default on re-init. If the packet includes `.benchrouter/SETUP_AGENT.md`, the CLI tells the coding agent to read that short, repo-specific setup brief instead of relying on a long generic prompt.

The generated workflow runs on the setup PR: it asks BenchRouter for an eval plan, skips model runs when the same route/eval/covered-code fingerprint already has evidence, uploads only the model arms that need fresh evidence, and fails the PR check if the route cannot call BenchRouter. The workflow reads the GitHub Actions secret named `BENCHROUTER_EVAL_API_KEY` and maps it to `BENCHROUTER_API_KEY` only inside the eval job.

Generated eval runners are JavaScript `.mjs` files under `.benchrouter/` so broad customer TypeScript builds do not pick them up. The generated eval harness reads per-route `.benchrouter/cases.<route>.json` files and fails until the repo has runnable route-specific cases. There is no passing smoke eval.

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

`doctor` validates expected BenchRouter files, real eval case coverage, package script wiring, runtime-only env example entries, generated helper syntax, PR workflow wiring, and route call-site wiring. It also prints a generic runtime-host checklist:

- Set runtime `BENCHROUTER_API_KEY` in the host that runs the patched call site.
- Set the recorded `call_site.base_url_env` to the BenchRouter OpenAI-compatible base URL.
- Set GitHub Actions repo secret `BENCHROUTER_EVAL_API_KEY` for evals.
- Keep any direct-provider API key only if the app has an intentional fallback path.

The live proxy ping is auto-gated. If `BENCHROUTER_API_KEY` is absent from the local environment, doctor reports the ping as skipped and still completes offline checks. If the key is present, doctor uses it for one authenticated proxy ping, sends the route ID as the OpenAI-compatible `model`, and reports the selected provider/canonical slug returned by BenchRouter. It never prints the key. When it can identify the GitHub repo, it verifies the `BENCHROUTER_EVAL_API_KEY` Actions secret exists.

Before opening a PR, use:

```bash
npx @benchrouter/setup doctor --repo owner/repo --skip-github-secret
BENCHROUTER_API_KEY=br_live_... npx @benchrouter/setup doctor --repo owner/repo
```

If BenchRouter Evals already ran before `BENCHROUTER_EVAL_API_KEY` existed, install the secret and rerun the failed workflow. With the GitHub CLI, `gh run rerun --failed` is one way to do that.

After the PR is merged, verify the config file is readable on the default branch:

```bash
BENCHROUTER_API_KEY=br_live_... npx @benchrouter/setup doctor --repo owner/repo --check-default-branch
```

The CLI never writes a raw BenchRouter API key to disk.
