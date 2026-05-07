#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";

if (command === "init") {
  await init();
} else if (command === "doctor") {
  doctor();
} else {
  usage(command === "help" || args.help ? 0 : 1);
}

async function init() {
  if (args.help) {
    usage(0, "init");
  }

  const apiUrl = stringArg("api-url", "https://api.benchrouter.com").replace(/\/+$/, "");
  const setupCode = stringArg("setup-code", process.env.BENCHROUTER_SETUP_CODE);
  const repoFullName = stringArg("repo") ?? detectGitHubRepo();
  const routeId = stringArg("route-id");
  const routeName = stringArg("name");
  const incumbentModel = stringArg("incumbent-model");
  const outputDir = path.resolve(stringArg("output-dir", process.cwd()));
  const dryRun = Boolean(args["dry-run"]);
  const force = Boolean(args.force);

  if (!setupCode) {
    fail("Missing setup code. Pass --setup-code or set BENCHROUTER_SETUP_CODE.");
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
    incumbentModel
  });
  const packet = packetResponse.setup_packet;
  const targetRepo = repoFullName ?? packetResponse.repo_full_name;

  if (dryRun) {
    process.stdout.write(`Dry run for ${targetRepo}\n`);
    for (const file of packet.files) {
      process.stdout.write(`would write ${file.path}\n`);
    }
    process.stdout.write("would update package.json scripts/devDependencies when package.json exists\n");
    process.stdout.write("would update or create .env.example\n");
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
    if (previous !== null && !force) {
      fail(`${file.path} already exists and differs. Re-run with --force to overwrite it.`);
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

  process.stdout.write("\nNext steps:\n");
  process.stdout.write("- Replace the generated smoke eval with product-specific cases when possible.\n");
  process.stdout.write("- Patch exactly one runtime call site to use BENCHROUTER_BASE_URL and BENCHROUTER_MODEL.\n");
  process.stdout.write("- Store BENCHROUTER_API_KEY in GitHub Actions and the app secret manager.\n");
  process.stdout.write("- Run `npx @benchrouter/setup doctor` before opening the PR.\n");
  process.stdout.write("\nSuggested PR body:\n");
  process.stdout.write(prBodyTemplate({ targetRepo, routeId, routeName, incumbentModel, writtenPaths }));
}

async function fetchSetupPacket({ apiUrl, setupCode, repoFullName, routeId, routeName, incumbentModel }) {
  const body = {
    repo_full_name: repoFullName,
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

  if (!response.ok) {
    fail(`Setup packet request failed (${response.status}): ${(await response.text()).slice(0, 800)}`);
  }

  return response.json();
}

function doctor() {
  const root = path.resolve(stringArg("output-dir", process.cwd()));
  const failures = [];
  const requiredFiles = [
    ".benchrouter/benchrouter.yml",
    ".benchrouter/benchrouter-kit.json",
    ".benchrouter/upload-results.mjs",
    ".github/workflows/benchrouter-evals.yml",
    "scripts/benchrouter-eval.ts"
  ];

  for (const relativePath of requiredFiles) {
    if (!existsSync(path.join(root, relativePath))) {
      failures.push(`missing ${relativePath}`);
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
    if (!parsed.devDependencies?.tsx && !parsed.dependencies?.tsx) {
      failures.push("package.json missing tsx dependency");
    }
  }

  const envExamplePath = path.join(root, ".env.example");
  if (!existsSync(envExamplePath)) {
    failures.push("missing .env.example");
  } else {
    const envExample = readFileSync(envExamplePath, "utf8");
    for (const key of ["BENCHROUTER_API_KEY", "BENCHROUTER_BASE_URL", "BENCHROUTER_MODEL"]) {
      if (!new RegExp(`^${key}=`, "m").test(envExample)) {
        failures.push(`.env.example missing ${key}`);
      }
    }
    if (/br_(live|test|setup)_[A-Za-z0-9_-]+/.test(envExample)) {
      failures.push(".env.example appears to contain a raw BenchRouter secret");
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

function prBodyTemplate({ targetRepo, routeId, routeName, incumbentModel, writtenPaths }) {
  return `## BenchRouter setup

Repo: ${targetRepo}
Route: ${routeName} (${routeId})
Incumbent model: ${incumbentModel}

### Files changed
${writtenPaths.map((item) => `- ${item}`).join("\n")}

### LLM call sites discovered
- TODO: list file paths, provider clients, models, base URLs, and env vars.

### Selected first route
- TODO: explain which call site was routed through BenchRouter and why.

### Eval coverage
- TODO: list product cases wrapped or added, plus uncovered gaps.

### Secrets required
- BENCHROUTER_API_KEY in GitHub Actions.
- BENCHROUTER_API_KEY in the app secret manager.

### Checks run
- TODO: include local tests and \`npx @benchrouter/setup doctor\`.

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
  npx @benchrouter/setup init --setup-code br_setup_... --route-id product/route --name "Route Name" --incumbent-model provider/model [options]

Options:
  --repo owner/repo
  --api-url <url>          Defaults to https://api.benchrouter.com.
  --dry-run                Print planned writes without changing files.
  --force                  Overwrite differing BenchRouter-generated files.
  --output-dir <path>      Defaults to current directory.
`);
  } else {
    stream.write(`Usage:
  npx @benchrouter/setup init --setup-code br_setup_... --route-id product/route --name "Route Name" --incumbent-model provider/model
  npx @benchrouter/setup doctor
`);
  }
  process.exit(status);
}
