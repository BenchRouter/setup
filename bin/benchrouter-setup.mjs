#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";

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
  const routeId = stringArg("route-id");
  const routeName = stringArg("name");
  const incumbentModel = stringArg("incumbent-model");
  const outputDir = path.resolve(stringArg("output-dir", process.cwd()));
  const dryRun = Boolean(args["dry-run"]);
  const overwriteUserEdits = Boolean(args["overwrite-user-edits"]);
  const forceKitFiles = Boolean(args.force);

  if (!setupCode) {
    fail("Missing setup key. Pass --setup-key or set BENCHROUTER_SETUP_KEY.");
  }
  if (!routeId || !routeName || !incumbentModel) {
    usage(1, "init", "Missing --route-id, --name, or --incumbent-model.");
  }

  const packetResponse = await fetchSetupPacket({
    apiUrl,
    setupCode,
    repoFullName,
    routeId,
    routeName,
    incumbentModel,
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
    process.stdout.write("would request Production and GitHub Actions API keys during a real init\n");
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

  process.stdout.write("\nNext steps:\n");
  process.stdout.write("- Fill .benchrouter/cases.json with at least 3 real route-specific cases, including 1 critical case.\n");
  process.stdout.write("- Update .benchrouter/benchrouter.yml with route code_refs for selected call-site files and eval_pack.case_refs for fixture/golden files.\n");
  process.stdout.write("- Patch exactly one runtime call site to send the BenchRouter route ID as that call site's model value.\n");
  process.stdout.write("- Update existing product tests/mocks for that call site so they cover the BenchRouter-wired runtime path.\n");
  process.stdout.write("- Keep persistent config minimal and never create a repo-global BENCHROUTER_MODEL.\n");
  process.stdout.write("- Ask before installing secrets; Production key goes to the app runtime, GitHub Actions key goes to the repo secret named BENCHROUTER_API_KEY.\n");
  process.stdout.write("- Run relevant product tests/build and this same setup CLI's `doctor` command before opening the PR.\n");
  process.stdout.write("- Confirm the BenchRouter Evals PR check passes before merging.\n");
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
  const force = Boolean(args.force);

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

    process.stdout.write(`Planned BenchRouter CI kit upgrade to ${preview.setup_kit_version} for ${preview.repo_full_name} / ${preview.route_id}\n`);
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
    const confirmed = await confirmPrompt(`Apply BenchRouter CI kit upgrade to ${repoFullName} / ${routeId}? [y/N] `);
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

  process.stdout.write(`Upgrading BenchRouter CI kit to ${applied.setup_kit_version} for ${applied.repo_full_name} / ${applied.route_id}\n`);
  for (const file of applied.files) {
    const targetPath = safeTargetPath(outputDir, file.path);
    const previous = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
    if (previous === file.content) {
      process.stdout.write(`unchanged ${file.path}\n`);
      continue;
    }
    if (previous !== null && !force) {
      fail(`${file.path} already exists and differs. Re-run with --force to overwrite it.`);
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content);
    process.stdout.write(`${previous === null ? "created" : "updated"} ${file.path}\n`);
  }

  process.stdout.write("\nNext steps:\n");
  process.stdout.write("- Review the diff and confirm only BenchRouter-owned CI kit files changed.\n");
  process.stdout.write("- Open a PR titled \"Upgrade BenchRouter CI kit\".\n");
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
  process.stdout.write(`- Production BENCHROUTER_API_KEY: ${setupApiKeys.production.key}\n`);
  process.stdout.write(`- GitHub Actions BENCHROUTER_API_KEY: ${setupApiKeys.github_actions.key}\n`);
}

async function fetchSetupPacket({ apiUrl, setupCode, repoFullName, routeId, routeName, incumbentModel, dryRun }) {
  const body = {
    repo_full_name: repoFullName,
    dry_run: dryRun ? true : undefined,
    route: {
      route_id: routeId,
      name: routeName,
      incumbent_model: incumbentModel
    }
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
      fail(unsupportedIncumbentMessage(incumbentModel));
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
  const requiredFiles = [
    ".benchrouter/benchrouter.yml",
    ".benchrouter/.kit-state.json",
    ".benchrouter/cases.json",
    ".benchrouter/upload-results.mjs",
    ".github/workflows/benchrouter-evals.yml",
    "scripts/benchrouter-eval.ts"
  ];

  for (const relativePath of requiredFiles) {
    if (!existsSync(path.join(root, relativePath))) {
      failures.push(`missing ${relativePath}`);
    }
  }

  const manifestPath = path.join(root, ".benchrouter/benchrouter.yml");
  const manifest = existsSync(manifestPath) ? parseManifestForDoctor(readFileSync(manifestPath, "utf8")) : null;
  if (manifest) {
    if (!manifest.routeId) {
      failures.push(".benchrouter/benchrouter.yml missing route_id");
    } else if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/i.test(manifest.routeId)) {
      failures.push(`.benchrouter/benchrouter.yml route_id must look like product/route: ${manifest.routeId}`);
    }
    if (!manifest.incumbentModel) {
      failures.push(".benchrouter/benchrouter.yml missing seed.incumbent_model");
    } else if (!args["skip-model-check"]) {
      const allowedModels = await fetchAllowedModels(apiUrl, failures);
      if (allowedModels && !allowedModels.has(manifest.incumbentModel)) {
        failures.push(`seed.incumbent_model is not in the BenchRouter catalog: ${manifest.incumbentModel}`);
      }
    }
  }

  const workflowPath = path.join(root, ".github/workflows/benchrouter-evals.yml");
  if (existsSync(workflowPath)) {
    const workflow = readFileSync(workflowPath, "utf8");
    for (const snippet of [
      ".benchrouter/upload-results.mjs",
      "pull_request",
      "workflow_dispatch",
      "eval-plan",
      "pull_request_number",
      "head_sha",
      "BENCHROUTER_EVAL_RUN_ID",
      "BENCHROUTER_ROUTE_ID",
      "BENCHROUTER_API_KEY",
      "BENCHROUTER_UPLOAD_RESULTS",
      "id-token: write"
    ]) {
      if (!workflow.includes(snippet)) {
        failures.push(`workflow missing ${snippet}`);
      }
    }
  }

  const casesPath = path.join(root, ".benchrouter/cases.json");
  if (existsSync(casesPath)) {
    validateCasesForDoctor(casesPath, failures);
  }

  const uploadHelperPath = path.join(root, ".benchrouter/upload-results.mjs");
  if (existsSync(uploadHelperPath)) {
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
    if (parsed.scripts?.["benchrouter:eval"] !== "tsx scripts/benchrouter-eval.ts") {
      failures.push("package.json missing scripts.benchrouter:eval");
    }
    for (const dependency of ["tsx", "@types/node"]) {
      if (!parsed.devDependencies?.[dependency] && !parsed.dependencies?.[dependency]) {
        failures.push(`package.json missing ${dependency} dependency`);
      }
    }
  }

  const envExamplePath = path.join(root, ".env.example");
  if (!existsSync(envExamplePath)) {
    failures.push("missing .env.example");
  } else {
    const envExample = readFileSync(envExamplePath, "utf8");
    for (const key of ["BENCHROUTER_API_KEY"]) {
      if (!new RegExp(`^${key}=`, "m").test(envExample)) {
        failures.push(`.env.example missing ${key}`);
      }
    }
    if (/br_(live|test|setup)_[A-Za-z0-9_-]+/.test(envExample)) {
      failures.push(".env.example appears to contain a raw BenchRouter secret");
    }
  }

  if (!args["skip-github-secret"]) {
    if (!repoFullName) {
      failures.push("could not detect GitHub repo for secret check; pass --repo owner/repo or --skip-github-secret");
    } else {
      verifyGitHubActionsSecret(repoFullName, failures);
    }
  }

  if (args["check-default-branch"]) {
    if (!repoFullName) {
      failures.push("could not detect GitHub repo for default-branch check; pass --repo owner/repo");
    } else {
      verifyDefaultBranchConfig(repoFullName, failures);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`doctor failed: ${failure}\n`);
    }
    process.exit(1);
  }

  process.stdout.write("BenchRouter setup doctor passed.\n");
}

async function fetchAllowedModels(apiUrl, failures) {
  try {
    return new Set(await fetchModelIds(apiUrl));
  } catch (error) {
    failures.push(`could not fetch BenchRouter model catalog: ${error instanceof Error ? error.message : "request failed"}`);
    return null;
  }
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

function validateCasesForDoctor(casesPath, failures) {
  let cases;
  try {
    cases = JSON.parse(readFileSync(casesPath, "utf8"));
  } catch (error) {
    failures.push(`.benchrouter/cases.json is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
    return;
  }
  if (!Array.isArray(cases)) {
    failures.push(".benchrouter/cases.json must be a JSON array");
    return;
  }
  const realCases = cases.filter((testCase) => !isTodoCase(testCase));
  const distinctInputs = new Set(realCases.map((testCase) => JSON.stringify(testCase.messages)));
  const criticalCount = realCases.filter((testCase) => testCase?.critical === true).length;
  if (realCases.length < 3 || distinctInputs.size < 3 || criticalCount < 1) {
    failures.push(".benchrouter/cases.json needs at least 3 non-TODO cases with distinct inputs and at least 1 critical case");
  }
}

function isTodoCase(testCase) {
  return (
    !testCase ||
    String(testCase.expected_behavior ?? "").trim().toUpperCase() === "TODO" ||
    !Array.isArray(testCase.expected_substrings) ||
    testCase.expected_substrings.length === 0 ||
    testCase.expected_substrings.some((value) => String(value).trim().toUpperCase() === "TODO")
  );
}

function isUnsupportedIncumbentModel(status, error) {
  if (status !== 400 || !error || typeof error !== "object") {
    return false;
  }
  return error.code === "model_not_allowed" && String(error.message ?? "").includes("route.incumbent_model");
}

function unsupportedIncumbentMessage(modelId) {
  return `BenchRouter setup stopped before writing files.

The incumbent model from this repo is not currently enabled:
  ${modelId}

Do not replace it automatically. A replacement changes runtime behavior.

Next steps:
Stop and ask the user for one exact enabled model ID.

To inspect exact enabled IDs, run:
   npx github:BenchRouter/setup models

Re-run init only after the user explicitly approves that exact ID:
   npx github:BenchRouter/setup init ... --incumbent-model <enabled-provider/model-id>`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseManifestForDoctor(text) {
  return {
    routeId: yamlScalarValue(text.match(/^\s*-?\s*route_id:\s*(.+)$/m)?.[1]),
    incumbentModel: yamlScalarValue(text.match(/^\s*incumbent_model:\s*(.+)$/m)?.[1])
  };
}

function yamlScalarValue(value) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.split(/\s+#/)[0].trim();
}

function verifyGitHubActionsSecret(repoFullName, failures) {
  const result = spawnSync("gh", ["secret", "list", "--repo", repoFullName], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`could not verify GitHub Actions secrets with gh: ${(result.stderr || result.stdout || "gh failed").trim()}`);
    return;
  }
  const hasSecret = result.stdout
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[0] === "BENCHROUTER_API_KEY");
  if (!hasSecret) {
    failures.push(`GitHub Actions secret BENCHROUTER_API_KEY is missing for ${repoFullName}`);
  }
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
    ".benchrouter/upload-results.mjs",
    ".github/workflows/benchrouter-evals.yml"
  ].includes(relativePath);
}

async function updateEnvExample(root, runtimeEnv) {
  const envPath = path.join(root, ".env.example");
  const previous = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = previous.length > 0 ? previous.replace(/\n?$/, "\n").split("\n").filter((line) => line.length > 0) : [];
  let changed = false;

  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (lines.some((line) => line.startsWith(`${key}=`))) {
      continue;
    }
    lines.push(`${key}=${key === "BENCHROUTER_API_KEY" ? "" : value}`);
    changed = true;
  }

  if (!changed && previous.length > 0) {
    return false;
  }

  await writeFile(envPath, `${lines.join("\n")}\n`);
  return true;
}

function prBodyTemplate({ targetRepo, routeId, routeName, incumbentModel }) {
  return `## BenchRouter setup

Repo: ${targetRepo}
Route: ${routeName} (${routeId})
Incumbent model: ${incumbentModel}

### Call site changed + route ID
- Route ID: ${routeId}
- TODO: summarize the one runtime call site changed.

### Eval cases authored
- TODO: count cases and describe coverage in one line.

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

Options:
  --repo owner/repo
  --api-url <url>          Defaults to https://api.benchrouter.com.
  --dry-run                Print planned writes without changing files.
  --force                  Overwrite BenchRouter-owned workflow/upload/kit files only.
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
  --upgrade-token <token>  Single-use token from the dashboard "Upgrade BenchRouter CI kit" banner. Falls back to BENCHROUTER_UPGRADE_TOKEN.
  --api-key <key>          BENCHROUTER_API_KEY (the value installed as a GitHub Actions repo secret). Falls back to BENCHROUTER_API_KEY env var. Ignored when --upgrade-token is set.
  --api-url <url>          Defaults to https://api.benchrouter.com.
  --output-dir <path>      Defaults to current directory.
  --yes, -y                Skip the interactive confirmation after preview.
  --dry-run                Preview only. Requires --upgrade-token. Never calls apply.
  --force                  Overwrite differing BenchRouter-owned kit files.
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
