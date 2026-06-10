#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";
const DOCTOR_WORKFLOW_SNIPPETS = [
  ".benchrouter/upload-results.mjs",
  "pull_request",
  "workflow_dispatch",
  "benchrouter_plan",
  "BENCHROUTER_MODEL_RUN_ID",
  "BENCHROUTER_ROUTE_ID",
  "BENCHROUTER_API_KEY",
  "secrets.BENCHROUTER_EVAL_API_KEY",
  "BENCHROUTER_UPLOAD_RESULTS",
  "run-model",
  "upload-results",
  "id-token: write"
];
const DOCTOR_UPLOAD_HELPER_SNIPPETS = [
  "prepare",
  "validate-dispatch",
  "plan-pr",
  "import-main",
  "run-model",
  "upload-results",
  "/v1/control/eval-plan",
  "/v1/control/import-github-config",
  "/v1/eval-model-runs/",
  "pull_request_number",
  "head_sha"
];

if (command === "init") {
  await init();
} else if (command === "doctor") {
  await doctor();
} else if (command === "models") {
  await models();
} else if (command === "upgrade") {
  await upgrade();
} else {
  usage(command === "help" || args.help ? 0 : 1);
}

async function init() {
  if (args.help) {
    usage(0, "init");
  }

  const apiUrl = stringArg("api-url", "https://api.benchrouter.com").replace(/\/+$/, "");
  const setupCode = stringArg(
    "setup-key",
    stringArg("setup-code", process.env.BENCHROUTER_SETUP_KEY ?? process.env.BENCHROUTER_SETUP_CODE)
  );
  const repoFullName = stringArg("repo") ?? detectGitHubRepo();
  // --route-id / --name / --incumbent-model may be repeated to scaffold multiple
  // routes in one init. They are paired positionally: the Nth --route-id goes
  // with the Nth --name and Nth --incumbent-model. The first triple is primary.
  const routeIds = arrayArg("route-id");
  const routeNames = arrayArg("name");
  const incumbentModels = arrayArg("incumbent-model");
  const codeRefs = arrayArg("code-ref");
  const baseUrlEnvs = arrayArg("base-url-env");
  const outputDir = path.resolve(stringArg("output-dir", process.cwd()));
  const dryRun = Boolean(args["dry-run"]);
  const overwriteUserEdits = Boolean(args["overwrite-user-edits"]);
  const forceKitFiles = Boolean(args.force);

  if (!setupCode) {
    fail("Missing setup key. Pass --setup-key or set BENCHROUTER_SETUP_KEY.");
  }
  if (routeIds.length === 0 || routeNames.length === 0 || incumbentModels.length === 0) {
    usage(1, "init", "Missing --route-id, --name, or --incumbent-model.");
  }
  if (routeIds.length !== routeNames.length || routeIds.length !== incumbentModels.length) {
    usage(1, "init", "When repeating routes, pass one --name and one --incumbent-model per --route-id (in the same order).");
  }
  if (baseUrlEnvs.length > 1 && baseUrlEnvs.length !== routeIds.length) {
    usage(1, "init", "When repeating --base-url-env, pass one value per --route-id (in the same order), or pass it once for all routes.");
  }

  const routeSpecs = routeIds.map((id, index) => ({
    route_id: id,
    name: routeNames[index],
    incumbent_model: incumbentModels[index],
    code_refs: codeRefs,
    base_url_env: baseUrlEnvs[index] ?? baseUrlEnvs[0] ?? ""
  }));
  const routeId = routeSpecs[0].route_id;
  const routeName = routeSpecs[0].name;
  const incumbentModel = routeSpecs[0].incumbent_model;

  const packetResponse = await fetchSetupPacket({
    apiUrl,
    setupCode,
    repoFullName,
    routeSpecs,
    dryRun
  });
  const packet = packetResponse.setup_packet;
  const setupApiKeys = packet.setup_api_keys;
  const targetRepo = repoFullName ?? packetResponse.repo_full_name;

  if (dryRun) {
    process.stdout.write(`Dry run for ${targetRepo}\n`);
    for (const file of packet.files) {
      process.stdout.write(`would write ${file.path}\n`);
    }
    process.stdout.write("would update package.json scripts/devDependencies when package.json exists\n");
    process.stdout.write("would update or create .env.example\n");
    process.stdout.write("would request Runtime/host BENCHROUTER_API_KEY and GitHub Actions BENCHROUTER_EVAL_API_KEY during a real init\n");
    return;
  }

  const writtenPaths = [];
  for (const file of packet.files) {
    const targetPath = safeTargetPath(outputDir, file.path);
    const previous = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
    if (previous === file.content) {
      process.stdout.write(`unchanged ${file.path}\n`);
      writtenPaths.push(file.path);
      continue;
    }
    if (previous !== null && !overwriteUserEdits && !(forceKitFiles && isBenchRouterKitFile(file.path))) {
      process.stdout.write(`skip-existing ${file.path}\n`);
      continue;
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content);
    process.stdout.write(`${previous === null ? "created" : "updated"} ${file.path}\n`);
    writtenPaths.push(file.path);
  }

  const packageJsonPath = path.join(outputDir, "package.json");
  if (existsSync(packageJsonPath)) {
    const updated = updatePackageJson(packageJsonPath, packet.package_json);
    if (updated) {
      writtenPaths.push("package.json");
      process.stdout.write("updated package.json\n");
    } else {
      process.stdout.write("unchanged package.json\n");
    }
  } else {
    process.stdout.write("skipped package.json update; no package.json found\n");
  }

  const envUpdated = await updateEnvExample(outputDir, packet.runtime_env);
  process.stdout.write(`${envUpdated ? "updated" : "unchanged"} .env.example\n`);
  if (envUpdated) {
    writtenPaths.push(".env.example");
  }

  printSetupApiKeys(setupApiKeys);
  printInitNextSteps();

  process.stdout.write("\nSuggested PR body:\n");
  process.stdout.write(prBodyTemplate({ targetRepo, routeId, routeName, incumbentModel }));
}

async function upgrade() {
  if (args.help) {
    usage(0, "upgrade");
  }

  const apiUrl = stringArg("api-url", "https://api.benchrouter.com").replace(/\/+$/, "");
  const upgradeToken = stringArg("upgrade-token", process.env.BENCHROUTER_UPGRADE_TOKEN);
  const apiKey = upgradeToken ? undefined : stringArg("api-key", process.env.BENCHROUTER_API_KEY);
  const bearer = upgradeToken ?? apiKey;
  const repoFullName = stringArg("repo") ?? detectGitHubRepo();
  const routeId = stringArg("route-id");
  const outputDir = path.resolve(stringArg("output-dir", process.cwd()));
  const dryRun = Boolean(args["dry-run"]);
  const autoYes = Boolean(args.yes);

  if (!bearer) {
    fail("Missing BenchRouter credential. Pass --upgrade-token (from the dashboard banner) or --api-key/BENCHROUTER_API_KEY.");
  }
  if (!repoFullName) {
    usage(1, "upgrade", "Missing --repo and unable to detect one from git remote.");
  }
  if (!routeId) {
    usage(1, "upgrade", "Missing --route-id.");
  }

  // 1. Preview — does NOT consume the upgrade token. Preview only supports the
  //    single-use upgrade token flow; API-key auth goes straight to apply (which
  //    is idempotent and re-runnable for API keys).
  if (upgradeToken) {
    const preview = await fetchUpgradePacket({
      apiUrl,
      bearer,
      repoFullName,
      routeId,
      mode: "preview"
    });

    process.stdout.write(`Planned BenchRouter kit upgrade to ${preview.setup_kit_version} for ${preview.repo_full_name} / ${preview.route_id}\n`);
    for (const file of preview.files) {
      process.stdout.write(`would write ${file.path}\n`);
    }

    if (dryRun) {
      return;
    }

    if (!autoYes) {
      const confirmed = await confirmPrompt("Apply these changes? [y/N] ");
      if (!confirmed) {
        process.stdout.write("Declined. No changes written.\n");
        return;
      }
    }
  } else if (dryRun) {
    fail("--dry-run requires --upgrade-token; the API-key apply endpoint consumes nothing but cannot be safely previewed without a token.");
  } else if (!autoYes) {
    const confirmed = await confirmPrompt(`Apply BenchRouter kit upgrade to ${repoFullName} / ${routeId}? [y/N] `);
    if (!confirmed) {
      process.stdout.write("Declined. No changes written.\n");
      return;
    }
  }

  // 2. Apply — for upgrade tokens this consumes the token, so the preview above
  //    must succeed first. Re-derive the packet server-side; do NOT reuse the
  //    preview response as if it were authoritative.
  const applied = await fetchUpgradePacket({
    apiUrl,
    bearer,
    repoFullName,
    routeId,
    mode: "apply"
  });

  process.stdout.write(`Upgrading BenchRouter kit to ${applied.setup_kit_version} for ${applied.repo_full_name} / ${applied.route_id}\n`);
  for (const file of applied.files) {
    const targetPath = safeTargetPath(outputDir, file.path);
    const previous = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
    if (previous === file.content) {
      process.stdout.write(`unchanged ${file.path}\n`);
      continue;
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content);
    process.stdout.write(`${previous === null ? "created" : "updated"} ${file.path}\n`);
  }

  process.stdout.write("\nNext steps:\n");
  process.stdout.write("- Review the dry-run/apply diff; it should only touch BenchRouter-generated kit/readme files.\n");
  process.stdout.write("- Open a PR titled \"Upgrade BenchRouter kit\".\n");
}

async function fetchUpgradePacket({ apiUrl, bearer, repoFullName, routeId, mode }) {
  const endpoint = mode === "preview"
    ? "/v1/setup/upgrade-packet/preview"
    : "/v1/control/setup-packet/upgrade";

  const response = await fetch(`${apiUrl}${endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ repo_full_name: repoFullName, route_id: routeId })
  });

  const responseText = await response.text();

  if (!response.ok) {
    if (isTokenInvalid(response.status, parseJson(responseText))) {
      fail("Upgrade token is no longer valid (already used / expired / revoked). Mint a new one in the dashboard.");
    }
    const label = mode === "preview" ? "Setup kit upgrade preview" : "Setup kit upgrade apply";
    fail(`${label} request failed (${response.status}): ${responseText.slice(0, 800)}`);
  }

  const body = parseJson(responseText);
  if (!body || body.ok !== true || !Array.isArray(body.files)) {
    fail("BenchRouter did not return a valid upgrade response.");
  }
  return body;
}

function isTokenInvalid(status, parsed) {
  if (status === 410 || status === 404) {
    return true;
  }
  const code = parsed?.error?.code;
  if (typeof code !== "string") {
    return false;
  }
  return code === "upgrade_token_used"
    || code === "upgrade_token_expired"
    || code === "upgrade_token_revoked"
    || code === "invalid_upgrade_token";
}

async function confirmPrompt(question) {
  if (!process.stdin.isTTY) {
    fail("Cannot prompt for confirmation in a non-interactive shell. Pass --yes to auto-confirm.");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function printSetupApiKeys(setupApiKeys) {
  if (!setupApiKeys?.production?.key || !setupApiKeys?.github_actions?.key) {
    return;
  }
  process.stdout.write("\nBenchRouter generated setup API keys. They are shown once:\n");
  process.stdout.write(`- Runtime/host BENCHROUTER_API_KEY: ${setupApiKeys.production.key}\n`);
  process.stdout.write(`- GitHub Actions secret BENCHROUTER_EVAL_API_KEY: ${setupApiKeys.github_actions.key}\n`);
  process.stdout.write("Store these now; old values cannot be recovered. If lost, return to the BenchRouter setup/dashboard flow to mint a new key.\n");
}

function printInitNextSteps() {
  process.stdout.write("\nNext steps:\n");
  process.stdout.write("- Tell your coding agent: read .benchrouter/SETUP_README.md before editing. It explains the call-site patch, eval evidence, scorer, calibration, and env-var install.\n");
  process.stdout.write("- Ask the user once before installing env vars: runtime BENCHROUTER_API_KEY in the app host, GitHub Actions repo secret BENCHROUTER_EVAL_API_KEY for evals.\n");
  process.stdout.write("- Run relevant product tests/build and `npx @benchrouter/setup doctor` before opening the PR. If BenchRouter Evals already ran before the GitHub secret existed, rerun the failed workflow after installing it.\n");
}

async function fetchSetupPacket({ apiUrl, setupCode, repoFullName, routeSpecs, dryRun }) {
  const [primary, ...additional] = routeSpecs;
  const body = {
    repo_full_name: repoFullName,
    dry_run: dryRun ? true : undefined,
    route: {
      route_id: primary.route_id,
      name: primary.name,
      incumbent_model: primary.incumbent_model,
      code_refs: primary.code_refs.length > 0 ? primary.code_refs : undefined,
      base_url_env: primary.base_url_env || undefined
    },
    routes: additional.length > 0
      ? additional.map((spec) => ({
          route_id: spec.route_id,
          name: spec.name,
          incumbent_model: spec.incumbent_model,
          code_refs: spec.code_refs.length > 0 ? spec.code_refs : undefined,
          base_url_env: spec.base_url_env || undefined
        }))
      : undefined
  };

  const response = await fetch(`${apiUrl}/v1/control/setup-packet`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${setupCode}`,
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify(stripUndefined(body))
  });

  const responseText = await response.text();

  if (!response.ok) {
    const parsed = parseJson(responseText);
    const error = parsed?.error;
    if (isUnsupportedIncumbentModel(response.status, error)) {
      fail(unsupportedIncumbentMessage(primary.incumbent_model));
    }
    fail(`Setup packet request failed (${response.status}): ${responseText.slice(0, 800)}`);
  }

  return JSON.parse(responseText);
}

async function models() {
  if (args.help) {
    usage(0, "models");
  }

  const apiUrl = stringArg("api-url", "https://api.benchrouter.com").replace(/\/+$/, "");
  const filter = stringArg("filter");
  let modelIds;
  try {
    modelIds = await fetchModelIds(apiUrl);
  } catch (error) {
    fail(`Could not fetch BenchRouter model catalog: ${error instanceof Error ? error.message : "request failed"}`);
  }

  const filtered = filter
    ? modelIds.filter((id) => id.toLowerCase().includes(filter.toLowerCase()))
    : modelIds;

  if (filtered.length === 0) {
    fail(`No enabled BenchRouter models matched ${JSON.stringify(filter)}.`);
  }

  for (const id of filtered) {
    process.stdout.write(`${id}\n`);
  }
}

async function doctor() {
  const root = path.resolve(stringArg("output-dir", process.cwd()));
  const apiUrl = stringArg("api-url", "https://api.benchrouter.com").replace(/\/+$/, "");
  const repoFullName = stringArg("repo") ?? detectGitHubRepo();
  const failures = [];
  const checks = [];
  const requiredFiles = [
    ".benchrouter/benchrouter.yml",
    ".benchrouter/.kit-state.json",
    ".benchrouter/README.md",
    ".benchrouter/SETUP_README.md",
    ".benchrouter/upload-results.mjs",
    ".benchrouter/sidecar.mjs",
    ".github/workflows/benchrouter-evals.yml"
  ];

  for (const relativePath of requiredFiles) {
    if (!existsSync(path.join(root, relativePath))) {
      failures.push(`missing ${relativePath}`);
    }
  }

  // Discover per-route scorer + cases files from BenchRouter-owned kit metadata.
  // Doctor must not interpret the user-authored manifest; the server owns YAML parsing.
  const kitStatePath = path.join(root, ".benchrouter/.kit-state.json");
  const kitRoutes = loadKitStateRoutesForDoctor(kitStatePath, failures);
  const routeFiles = discoverRouteFilesFromKitRoutes(kitRoutes, root);
  if (routeFiles.length === 0) {
    failures.push("could not discover route scorer/cases files from .benchrouter/.kit-state.json");
  }

  // Validate each route: cases must have ≥1 real captured case, scorer must pass node --check.
  for (const { casesPath, casesRelPath } of routeFiles) {
    validateCasesForDoctor(casesPath, casesRelPath, failures);
  }
  for (const { scorerPath, scorerRelPath } of routeFiles) {
    if (existsSync(scorerPath)) {
      const check = spawnSync(process.execPath, ["--check", scorerPath], { encoding: "utf8" });
      if (check.status !== 0) {
        failures.push(`${scorerRelPath} failed node --check: ${(check.stderr || check.stdout).trim()}`);
      }
    }
  }

  const workflowPath = path.join(root, ".github/workflows/benchrouter-evals.yml");
  if (existsSync(workflowPath)) {
    const workflow = readFileSync(workflowPath, "utf8");
    for (const snippet of DOCTOR_WORKFLOW_SNIPPETS) {
      if (!workflow.includes(snippet)) {
        failures.push(`workflow missing ${snippet}`);
      }
    }
  }

  const uploadHelperPath = path.join(root, ".benchrouter/upload-results.mjs");
  if (existsSync(uploadHelperPath)) {
    const helper = readFileSync(uploadHelperPath, "utf8");
    for (const snippet of DOCTOR_UPLOAD_HELPER_SNIPPETS) {
      if (!helper.includes(snippet)) {
        failures.push(`upload helper missing ${snippet}`);
      }
    }
    const check = spawnSync(process.execPath, ["--check", uploadHelperPath], { encoding: "utf8" });
    if (check.status !== 0) {
      failures.push(`.benchrouter/upload-results.mjs failed node --check: ${(check.stderr || check.stdout).trim()}`);
    }
  }

  const packageJsonPath = path.join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    failures.push("missing package.json");
  } else {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    validateBenchRouterEvalScriptForDoctor(root, parsed.scripts?.["benchrouter:eval"], failures);
  }

  const envExamplePath = path.join(root, ".env.example");
  if (!existsSync(envExamplePath)) {
    failures.push("missing .env.example");
  } else {
    const envExample = readFileSync(envExamplePath, "utf8");
    const envKeys = parseEnvExampleKeys(envExample);
    const expectedRuntimeKeys = new Set([
      "BENCHROUTER_API_KEY",
      ...kitRoutes.map((route) => route.callSiteBaseUrlEnv).filter(Boolean)
    ]);
    for (const key of expectedRuntimeKeys) {
      if (!envKeys.includes(key)) {
        failures.push(`.env.example missing ${key}`);
      }
    }
    if (envKeys.includes("BENCHROUTER_EVAL_API_KEY")) {
      failures.push(".env.example must not include BENCHROUTER_EVAL_API_KEY; keep the GitHub eval key as a GitHub Actions secret");
    }
    const ciOnlyBenchRouterKeys = envKeys.filter(
      (key) => key.startsWith("BENCHROUTER_") && key !== "BENCHROUTER_API_KEY" && key !== "BENCHROUTER_EVAL_API_KEY"
    );
    if (ciOnlyBenchRouterKeys.length > 0) {
      failures.push(`.env.example includes CI-only BenchRouter env vars: ${ciOnlyBenchRouterKeys.join(", ")}`);
    }
    if (/br_(live|test|setup)_[A-Za-z0-9_-]+/.test(envExample)) {
      failures.push(".env.example appears to contain a raw BenchRouter secret");
    }
  }

  for (const checklistItem of runtimeHostChecklist({ root, routes: kitRoutes, apiUrl })) {
    checks.push(checklistItem);
  }

  const wiringResult = validateRuntimeWiringForDoctor(root, kitRoutes, failures);
  if (wiringResult.ok) {
    checks.push(`runtime wiring ✓ ${wiringResult.routesChecked} route${wiringResult.routesChecked === 1 ? "" : "s"} reference call_site.base_url_env from code_refs`);
  }

  const routeForProxyPing = kitRoutes.find((route) => route.routeId)?.routeId;
  const proxyResult = await verifyProxyPingForDoctor({
    apiUrl,
    apiKey: process.env.BENCHROUTER_API_KEY,
    routeId: routeForProxyPing,
    failures
  });
  if (proxyResult.ok) {
    checks.push(`auth ✓ live proxy ping used runtime BENCHROUTER_API_KEY from env for ${proxyResult.routeId}`);
    checks.push(`model resolution ✓ configured route model ${proxyResult.routeId} -> selected provider/canonical slug ${proxyResult.model} (usage present)`);
  } else if (proxyResult.skipped) {
    checks.push(`auth skipped: ${proxyResult.reason}`);
  }

  if (!args["skip-github-secret"]) {
    if (!repoFullName) {
      failures.push("could not detect GitHub repo for secret check; pass --repo owner/repo or --skip-github-secret");
    } else {
      if (verifyGitHubActionsSecret(repoFullName, failures)) {
        checks.push("GitHub secret ✓ BENCHROUTER_EVAL_API_KEY exists");
        checks.push("rerun hint: if BenchRouter Evals already ran before this secret existed, rerun the failed workflow after installing it (example: gh run rerun --failed)");
      }
      verifyGitHubWorkflowState(repoFullName, failures, checks);
    }
  } else {
    checks.push("GitHub secret check skipped (expected secret: BENCHROUTER_EVAL_API_KEY)");
  }

  if (args["check-default-branch"]) {
    if (!repoFullName) {
      failures.push("could not detect GitHub repo for default-branch check; pass --repo owner/repo");
    } else {
      verifyDefaultBranchConfig(repoFullName, failures);
    }
  }

  if (failures.length > 0) {
    for (const check of checks) {
      process.stderr.write(`doctor check: ${check}\n`);
    }
    for (const failure of failures) {
      process.stderr.write(`doctor failed: ${failure}\n`);
    }
    process.exit(1);
  }

  for (const check of checks) {
    process.stdout.write(`${check}\n`);
  }
  process.stdout.write("BenchRouter setup doctor passed.\n");
}

async function fetchModelIds(apiUrl) {
  const response = await fetch(`${apiUrl}/v1/models`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  const ids = (Array.isArray(data.data) ? data.data : [])
    .map((model) => model?.id)
    .filter((id) => typeof id === "string")
    .sort();
  if (ids.length === 0) {
    throw new Error("catalog returned no enabled model IDs");
  }
  return ids;
}

function loadKitStateRoutesForDoctor(kitStatePath, failures) {
  if (!existsSync(kitStatePath)) {
    return [];
  }
  let kitState;
  try {
    kitState = JSON.parse(readFileSync(kitStatePath, "utf8"));
  } catch (error) {
    failures.push(`.benchrouter/.kit-state.json is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
    return [];
  }
  const rawRoutes = Array.isArray(kitState?.routes) ? kitState.routes : [];
  return rawRoutes.map((route, index) => normalizeKitStateRouteForDoctor(route, index, failures)).filter(Boolean);
}

function normalizeKitStateRouteForDoctor(route, index, failures) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    failures.push(`.benchrouter/.kit-state.json routes[${index}] must be an object`);
    return null;
  }
  const routeId = typeof route.route_id === "string" ? route.route_id.trim() : "";
  const slug = typeof route.route_slug === "string" && route.route_slug.trim().length > 0 ? route.route_slug.trim() : routeId;
  if (!routeId) {
    failures.push(`.benchrouter/.kit-state.json routes[${index}].route_id is required`);
    return null;
  }
  const token = routeFileToken(slug || routeId);
  return {
    routeId,
    slug,
    scorerPath: typeof route.scorer_path === "string" && route.scorer_path.trim().length > 0 ? route.scorer_path.trim() : `.benchrouter/scorer.${token}.js`,
    casesPath: typeof route.cases_path === "string" && route.cases_path.trim().length > 0 ? route.cases_path.trim() : `.benchrouter/cases.${token}.json`,
    codeRefs: Array.isArray(route.code_refs) ? route.code_refs.filter((ref) => typeof ref === "string" && ref.length > 0) : [],
    callSiteBaseUrlEnv: typeof route.base_url_env === "string" ? route.base_url_env.trim() : ""
  };
}

function discoverRouteFilesFromKitRoutes(routes, root) {
  return routes.map((route) => ({
    token: routeFileToken(route.slug || route.routeId),
    scorerPath: path.join(root, route.scorerPath),
    scorerRelPath: route.scorerPath,
    casesPath: path.join(root, route.casesPath),
    casesRelPath: route.casesPath,
    kitCasesEntry: null
  }));
}

function routeFileToken(routeSlug) {
  return String(routeSlug).split("/").join("__");
}

function validateCasesForDoctor(casesPath, relPath, failures) {
  if (!existsSync(casesPath)) {
    failures.push(`missing ${relPath}`);
    return;
  }
  let cases;
  try {
    cases = JSON.parse(readFileSync(casesPath, "utf8"));
  } catch (error) {
    failures.push(`${relPath} is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
    return;
  }
  if (!Array.isArray(cases)) {
    failures.push(`${relPath} must be a JSON array`);
    return;
  }
  // A real runnable case mirrors the eval harness's isRunnableCase: an id plus either a non-empty
  // input request body (test-derived/authored declared cases) OR a non-empty messages array (captured/legacy).
  // reference_output is optional — the captured source records it as an incumbent calibration sample;
  // test-derived/authored leave it null and carry the expected decision in scorer_metadata / the scorer.
  const realCases = cases.filter(
    (c) =>
      c &&
      !("_README" in c) &&
      typeof c.id === "string" &&
      c.id.length > 0 &&
      ((c.input && typeof c.input === "object" && Object.keys(c.input).length > 0) ||
        (Array.isArray(c.messages) && c.messages.length > 0))
  );
  if (realCases.length === 0) {
    failures.push(`${relPath} has no runnable cases yet — add declared cases (test-derived/authored) or run the capture step (captured) before opening the PR`);
  }
}

function isUnsupportedIncumbentModel(status, error) {
  if (status !== 400 || !error || typeof error !== "object") {
    return false;
  }
  return error.code === "model_not_allowed" && String(error.message ?? "").includes("route.incumbent_model");
}

function unsupportedIncumbentMessage(modelId) {
  return `BenchRouter setup stopped before writing files.

The incumbent model from this repo was not accepted by BenchRouter/OpenRouter:
  ${modelId}

Do not replace it automatically. A replacement changes runtime behavior.

Next steps:
Stop and ask the user for one exact OpenRouter model ID.

To inspect curated BenchRouter candidate IDs, run:
   npx github:BenchRouter/setup models

Re-run init only after the user explicitly approves that exact ID:
   npx github:BenchRouter/setup init ... --incumbent-model <provider/model-id>`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validateRuntimeWiringForDoctor(root, routes, failures) {
  const routeEntries = routes.filter((route) => route.routeId || route.slug);
  if (routeEntries.length === 0) {
    failures.push("runtime wiring: .benchrouter/.kit-state.json has no routes to verify");
    return { ok: false, routesChecked: 0 };
  }

  let routesChecked = 0;
  for (const route of routeEntries) {
    const label = route.routeId || route.slug;
    const baseUrlEnv = route.callSiteBaseUrlEnv;
    if (!baseUrlEnv) {
      failures.push(`runtime wiring route ${label}: missing call_site.base_url_env`);
      continue;
    }
    if (route.codeRefs.length === 0) {
      failures.push(`runtime wiring route ${label}: missing code_refs for call_site.base_url_env ${baseUrlEnv}`);
      continue;
    }

    let referenced = false;
    for (const codeRef of route.codeRefs) {
      const resolved = resolveDoctorRelativePath(root, codeRef);
      if (!resolved.ok) {
        failures.push(`runtime wiring route ${label}: invalid code_ref ${codeRef}: ${resolved.error}`);
        continue;
      }
      if (!existsSync(resolved.path)) {
        failures.push(`runtime wiring route ${label}: missing code_ref ${codeRef}`);
        continue;
      }
      let contents;
      try {
        contents = readFileSync(resolved.path, "utf8");
      } catch (error) {
        failures.push(`runtime wiring route ${label}: could not read code_ref ${codeRef}: ${error instanceof Error ? error.message : "read failed"}`);
        continue;
      }
      if (contents.includes(baseUrlEnv)) {
        referenced = true;
      }
    }
    if (!referenced) {
      failures.push(`runtime wiring route ${label}: call_site.base_url_env ${baseUrlEnv} is not referenced by any route code_refs`);
      continue;
    }
    routesChecked += 1;
  }

  return { ok: routesChecked === routeEntries.length, routesChecked };
}

function validateBenchRouterEvalScriptForDoctor(root, command, failures) {
  if (typeof command !== "string" || command.trim().length === 0) {
    failures.push("package.json missing scripts.benchrouter:eval");
    return;
  }

  const runnerPath = benchRouterEvalRunnerFromCommand(command);
  if (!runnerPath) {
    failures.push("package.json scripts.benchrouter:eval must run a .benchrouter/*.mjs runner with node");
    return;
  }

  const resolved = resolveDoctorRelativePath(root, runnerPath);
  if (!resolved.ok) {
    failures.push(`package.json scripts.benchrouter:eval uses invalid runner path ${runnerPath}: ${resolved.error}`);
    return;
  }
  if (!existsSync(resolved.path)) {
    failures.push(`missing ${runnerPath}`);
    return;
  }

  const check = spawnSync(process.execPath, ["--check", resolved.path], { encoding: "utf8" });
  if (check.status !== 0) {
    failures.push(`${runnerPath} failed node --check: ${(check.stderr || check.stdout).trim()}`);
  }
}

function benchRouterEvalRunnerFromCommand(command) {
  const trimmed = command.trim();
  const match = trimmed.match(/^node(?:\s+--[A-Za-z0-9_./:=+-]+)*\s+(\.benchrouter\/[^\s'"`;&|<>]+\.mjs)$/);
  return match?.[1] ?? "";
}

function runtimeHostChecklist({ root, routes, apiUrl }) {
  const baseUrlEnvNames = Array.from(new Set(routes.map((route) => route.callSiteBaseUrlEnv).filter(Boolean)));
  const baseUrlLabel = baseUrlEnvNames.length > 0
    ? baseUrlEnvNames.join(", ")
    : "call_site.base_url_env (record the real env var in .benchrouter/benchrouter.yml)";
  const checklist = [
    `runtime host checklist: set BENCHROUTER_API_KEY in your runtime host and set ${baseUrlLabel} to ${proxyBaseUrl(apiUrl)}`,
    "GitHub Actions checklist: set repo secret BENCHROUTER_EVAL_API_KEY; the workflow maps it to BENCHROUTER_API_KEY for eval scripts"
  ];
  const fallbackKeys = detectFallbackProviderEnvKeys(root);
  if (fallbackKeys.length > 0) {
    checklist.push(`optional fallback provider key detected in .env.example: ${fallbackKeys.join(", ")} (only needed if the app keeps a direct-provider fallback)`);
  }
  return checklist;
}

function proxyBaseUrl(apiUrl) {
  return `${apiUrl.replace(/\/+$/, "")}/v1`;
}

function detectFallbackProviderEnvKeys(root) {
  const envExamplePath = path.join(root, ".env.example");
  if (!existsSync(envExamplePath)) {
    return [];
  }
  const keys = parseEnvExampleKeys(readFileSync(envExamplePath, "utf8"));
  return keys
    .filter((key) => key.endsWith("_API_KEY"))
    .filter((key) => !key.startsWith("BENCHROUTER_"))
    .sort();
}

function parseEnvExampleKeys(text) {
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) {
      keys.push(match[1]);
    }
  }
  return keys;
}

function resolveDoctorRelativePath(root, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    return { ok: false, error: "path must be a relative file path inside the repo" };
  }
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return { ok: false, error: "path escapes the repo root" };
  }
  return { ok: true, path: target };
}

async function verifyProxyPingForDoctor({ apiUrl, apiKey, routeId, failures }) {
  if (!apiKey) {
    return { ok: false, skipped: true, reason: "no BENCHROUTER_API_KEY in environment; live proxy ping not run" };
  }
  if (!routeId) {
    failures.push("proxy ping route not found: .benchrouter/.kit-state.json has no route_id to test");
    return { ok: false };
  }

  let response;
  let responseText;
  try {
    response = await fetch(`${apiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: routeId,
        messages: [{ role: "user", content: "ping" }],
        temperature: 0,
        max_tokens: 1
      })
    });
    responseText = await response.text();
  } catch (error) {
    failures.push(`proxy ping network: ${proxyNetworkMessage(error)}`);
    return { ok: false };
  }

  const parsed = parseJson(responseText);
  if (!response.ok) {
    const errorCode = proxyErrorCode(parsed);
    if (response.status === 401 || response.status === 403 || ["invalid_token", "invalid_api_key", "unauthorized"].includes(errorCode)) {
      failures.push(`proxy ping auth rejected: HTTP ${response.status}${errorCode ? ` ${errorCode}` : ""}`);
      return { ok: false };
    }
    if (response.status === 404 || ["route_not_found", "model_not_found"].includes(errorCode)) {
      failures.push(`proxy ping route not found: ${routeId}${errorCode ? ` (${errorCode})` : ""}`);
      return { ok: false };
    }
    failures.push(`proxy ping failed: HTTP ${response.status}${errorCode ? ` ${errorCode}` : ""}`);
    return { ok: false };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    failures.push("proxy ping malformed response: expected a JSON object");
    return { ok: false };
  }
  const resolvedModel = typeof parsed.model === "string" ? parsed.model : "";
  if (!resolvedModel || resolvedModel === routeId) {
    failures.push("proxy ping malformed response: expected response.model to be a concrete model, not the route id");
    return { ok: false };
  }
  if (!parsed.usage || typeof parsed.usage !== "object" || Array.isArray(parsed.usage)) {
    failures.push("proxy ping malformed response: expected response.usage object");
    return { ok: false };
  }

  return { ok: true, routeId, model: resolvedModel };
}

function proxyErrorCode(parsed) {
  const code = parsed?.error?.code ?? parsed?.code;
  return typeof code === "string" ? code : "";
}

function proxyNetworkMessage(error) {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return "request timed out";
    }
    return error.message;
  }
  return "request failed";
}

function verifyGitHubActionsSecret(repoFullName, failures) {
  const result = spawnSync("gh", ["secret", "list", "--repo", repoFullName], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`could not verify GitHub Actions secrets with gh: ${(result.stderr || result.stdout || "gh failed").trim()}`);
    return false;
  }
  const hasSecret = result.stdout
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[0] === "BENCHROUTER_EVAL_API_KEY");
  if (!hasSecret) {
    failures.push(`GitHub Actions secret BENCHROUTER_EVAL_API_KEY is missing for ${repoFullName}; set it to the GitHub eval key, not the runtime host key`);
    return false;
  }
  return true;
}

function verifyGitHubWorkflowState(repoFullName, failures, checks) {
  const result = spawnSync("gh", ["api", `repos/${repoFullName}/actions/workflows`], { encoding: "utf8" });
  if (result.error && result.error.code === "ENOENT") {
    return;
  }
  if (result.status !== 0) {
    failures.push(`could not verify BenchRouter Evals workflow state with gh: ${(result.stderr || result.stdout || "gh failed").trim()}`);
    return;
  }

  let workflows;
  try {
    workflows = JSON.parse(result.stdout).workflows;
  } catch {
    failures.push("could not parse gh workflow listing response");
    return;
  }
  const workflow = Array.isArray(workflows)
    ? workflows.find((entry) => entry && entry.path === ".github/workflows/benchrouter-evals.yml")
    : null;
  if (!workflow) {
    failures.push("BenchRouter Evals workflow is missing in GitHub Actions");
    return;
  }
  const state = typeof workflow.state === "string" ? workflow.state : "unknown";
  if (state !== "active") {
    failures.push(`BenchRouter Evals workflow is ${state}; re-enable it with: gh workflow enable benchrouter-evals.yml --repo ${repoFullName}`);
    return;
  }
  checks.push("GitHub workflow ✓ BenchRouter Evals is active");
}

function verifyDefaultBranchConfig(repoFullName, failures) {
  const repoResult = spawnSync("gh", ["repo", "view", repoFullName, "--json", "defaultBranchRef"], { encoding: "utf8" });
  if (repoResult.status !== 0) {
    failures.push(`could not look up GitHub default branch with gh: ${(repoResult.stderr || repoResult.stdout || "gh failed").trim()}`);
    return;
  }
  let defaultBranch = "main";
  try {
    defaultBranch = JSON.parse(repoResult.stdout).defaultBranchRef?.name || defaultBranch;
  } catch {
    failures.push("could not parse gh default branch response");
    return;
  }

  const configResult = spawnSync("gh", [
    "api",
    "--method",
    "GET",
    `repos/${repoFullName}/contents/.benchrouter/benchrouter.yml`,
    "-f",
    `ref=${defaultBranch}`
  ], { encoding: "utf8" });
  if (configResult.status !== 0) {
    failures.push(`.benchrouter/benchrouter.yml is not readable on default branch ${defaultBranch}: ${(configResult.stderr || configResult.stdout || "gh failed").trim()}`);
  }
}

function updatePackageJson(packageJsonPath, packageJsonInstructions) {
  const previous = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(previous);
  parsed.scripts = { ...(parsed.scripts ?? {}), ...packageJsonInstructions.scripts };
  parsed.devDependencies = parsed.devDependencies ?? {};
  for (const dependency of packageJsonInstructions.dev_dependencies ?? []) {
    if (!parsed.dependencies?.[dependency] && !parsed.devDependencies[dependency]) {
      parsed.devDependencies[dependency] = "latest";
    }
  }
  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  if (next === previous) {
    return false;
  }
  writeFileSync(packageJsonPath, next);
  return true;
}

function isBenchRouterKitFile(relativePath) {
  return [
    ".benchrouter/.gitignore",
    ".benchrouter/.kit-state.json",
    ".benchrouter/README.md",
    ".benchrouter/SETUP_README.md",
    ".benchrouter/benchrouter-calibrate.mjs",
    ".benchrouter/benchrouter-eval.mjs",
    ".benchrouter/upload-results.mjs",
    ".github/workflows/benchrouter-evals.yml"
  ].includes(relativePath);
}

async function updateEnvExample(root, runtimeEnv) {
  const envPath = path.join(root, ".env.example");
  const previous = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = previous.length > 0 ? previous.replace(/\n?$/, "\n").split("\n").filter((line) => line.length > 0) : [];
  let changed = false;
  const runtimeEntries = Object.entries(runtimeEnv ?? {}).filter(([key]) => isUserRuntimeEnvKey(key));

  if (runtimeEntries.length === 0 && previous.length === 0) {
    return false;
  }

  for (const [key, value] of runtimeEntries) {
    if (lines.some((line) => line.startsWith(`${key}=`))) {
      continue;
    }
    lines.push(formatEnvExampleLine(key, value));
    changed = true;
  }

  if (!changed && previous.length > 0) {
    return false;
  }

  await writeFile(envPath, `${lines.join("\n")}\n`);
  return true;
}

function isUserRuntimeEnvKey(key) {
  if (key === "BENCHROUTER_API_KEY") {
    return true;
  }
  if (key.startsWith("BENCHROUTER_")) {
    return false;
  }
  return /^[A-Z_][A-Z0-9_]*$/.test(key);
}

function formatEnvExampleLine(key, value) {
  if (key === "BENCHROUTER_API_KEY") {
    return "BENCHROUTER_API_KEY= # runtime key - set in your runtime host; printed once by setup";
  }
  const renderedValue = typeof value === "string" && !value.startsWith("<") ? value : "";
  if (key.endsWith("_BASE_URL") || key.endsWith("_BASE_URL_ENV") || key.includes("BASE_URL")) {
    return `${key}=${renderedValue} # point this call site's LLM base URL at BenchRouter`;
  }
  if (key.endsWith("_API_KEY")) {
    return `${key}= # optional direct-provider fallback key`;
  }
  return `${key}=${renderedValue}`;
}

function prBodyTemplate({ targetRepo, routeId, routeName, incumbentModel }) {
  return `## BenchRouter setup

Repo: ${targetRepo}
Route: ${routeName} (${routeId})
Incumbent model: ${incumbentModel}

### Call site changed + route ID
- Route ID: ${routeId}
- TODO: summarize the one runtime call site changed.
- TODO: record call_site.base_url_env and the code_refs files that prove it.

### Eval case source + coverage matrix
- Branch: TODO test-derived / captured / authored.
- TODO: list each case, source, critical variant, and expected consumed decision.

### Scorer + import audit
- TODO: summarize the extracted scorer contract and confirm it has no app imports, fs, network, DB, or nondeterministic clocks.

### Certification limits
- Certified layer: TODO model-output contract / parser boundary / human-read judge.
- TODO: list uncovered variants or downstream behavior that this eval does not certify.

### Secrets + CI
- Runtime host: BENCHROUTER_API_KEY.
- GitHub Actions repo secret: BENCHROUTER_EVAL_API_KEY.
- TODO: confirm BenchRouter Evals was rerun if it first ran before the GitHub secret existed.

### Rollback
1. Set the selected call site's base URL back to the previous provider.
2. Set the model back to ${incumbentModel}.
3. Keep or remove BenchRouter eval files depending on whether offline evaluation should continue.
`;
}

function detectGitHubRepo() {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    return undefined;
  }
  const remote = result.stdout.trim();
  const sshMatch = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }
  return undefined;
}

function safeTargetPath(root, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    fail(`Unsafe packet path: ${relativePath}`);
  }
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    fail(`Packet path escapes output directory: ${relativePath}`);
  }
  return target;
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "-y") {
      parsed.yes = true;
      continue;
    }
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }

    const option = value.slice(2);
    const equalsIndex = option.indexOf("=");
    const key = equalsIndex === -1 ? option : option.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : option.slice(equalsIndex + 1);
    const next = values[index + 1];
    const argValue = inlineValue !== undefined ? inlineValue : next && !next.startsWith("--") ? values[++index] : true;

    if (parsed[key] === undefined) {
      parsed[key] = argValue;
    } else if (Array.isArray(parsed[key])) {
      parsed[key].push(argValue);
    } else {
      parsed[key] = [parsed[key], argValue];
    }
  }
  return parsed;
}

function stringArg(name, fallback) {
  const value = args[name];
  if (Array.isArray(value)) {
    return String(value[value.length - 1]);
  }
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

// Returns every value passed for a repeatable flag, in CLI order. A flag given
// once yields a single-element array; absent flags yield an empty array.
function arrayArg(name) {
  const value = args[name];
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

function stripUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)])
    );
  }
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function usage(status, commandName = "all", message) {
  const stream = status === 0 ? process.stdout : process.stderr;
  if (message) {
    stream.write(`${message}\n\n`);
  }
  if (commandName === "init") {
    stream.write(`Usage:
  npx @benchrouter/setup init --setup-key br_setup_... --route-id product/route --name "Route Name" --incumbent-model provider/model [options]

Multiple routes (paired in order; first triple is primary):
  npx @benchrouter/setup init --setup-key br_setup_... \\
    --route-id product/route-a --name "Route A" --incumbent-model provider/model-a \\
    --route-id product/route-b --name "Route B" --incumbent-model provider/model-b

Routes share one product. Pass repeated route triples during init; the generated
.benchrouter/.kit-state.json is the kit's route index.

Options:
  --repo owner/repo
  --route-id <id>         Repeatable. Pair each with one --name and one --incumbent-model.
  --name <text>           Repeatable. Display name for the matching --route-id.
  --incumbent-model <id>  Repeatable. Incumbent model for the matching --route-id.
  --code-ref <path>       Repeatable. Call-site files recorded on the primary route.
  --base-url-env <name>   Repeatable. Env var the call site uses for its LLM base URL.
  --api-url <url>          Defaults to https://api.benchrouter.com.
  --dry-run                Print planned writes without changing files.
  --force                  Overwrite BenchRouter-generated kit/readme files only.
  --overwrite-user-edits   Overwrite existing differing files.
  --output-dir <path>      Defaults to current directory.
`);
  } else if (commandName === "models") {
    stream.write(`Usage:
  npx @benchrouter/setup models [options]

Options:
  --api-url <url>          Defaults to https://api.benchrouter.com.
  --filter <text>          Print only enabled IDs containing this text.
`);
  } else if (commandName === "upgrade") {
    stream.write(`Usage:
  npx @benchrouter/setup upgrade --upgrade-token br_upgrade_... --repo owner/repo --route-id product/route
  npx @benchrouter/setup upgrade --api-key <BENCHROUTER_API_KEY> --repo owner/repo --route-id product/route

The upgrade flow previews the planned changes (without consuming the single-use
upgrade token), prompts for confirmation, then applies. Use --yes to skip the
prompt.

Options:
  --upgrade-token <token>  Single-use token from the dashboard "Upgrade BenchRouter kit" banner. Falls back to BENCHROUTER_UPGRADE_TOKEN.
  --api-key <key>          BenchRouter API key for applying an upgrade. Falls back to BENCHROUTER_API_KEY env var. Ignored when --upgrade-token is set.
  --api-url <url>          Defaults to https://api.benchrouter.com.
  --output-dir <path>      Defaults to current directory.
  --yes, -y                Skip the interactive confirmation after preview.
  --dry-run                Preview only. Requires --upgrade-token. Never calls apply.
  --force                  Accepted for compatibility. Upgrade overwrites BenchRouter-owned kit files by default.
`);
  } else {
    stream.write(`Usage:
  npx @benchrouter/setup init --setup-key br_setup_... --route-id product/route --name "Route Name" --incumbent-model provider/model
  npx @benchrouter/setup upgrade --upgrade-token br_upgrade_... --repo owner/repo --route-id product/route
  npx @benchrouter/setup models
  npx @benchrouter/setup doctor
  npx @benchrouter/setup doctor --repo owner/repo --api-url https://api.benchrouter.com
`);
  }
  process.exit(status);
}
