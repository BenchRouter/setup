import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const cliPath = path.join(repoRoot, "bin/benchrouter-setup.mjs");
const routeId = "app/chat";
const fixture = JSON.parse(
  await readFile(path.join(testDir, "fixtures/benchrouter-proxy/chat-completion.json"), "utf8")
);

test("doctor passes with wired code_refs and a proxy fixture replay", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  const proxy = await startFixtureProxy(t, {
    status: 200,
    headers: { "x-benchrouter-selected-model": fixture.model },
    body: fixture
  });

  const result = await runDoctor(root, proxy.url);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runtime wiring/);
  assert.match(result.stdout, /auth .*proxy accepted BENCHROUTER_API_KEY/);
  assert.match(result.stdout, /route resolution .*minimax\/minimax-m2\.7.*usage/);
  assert.match(result.stdout, /BenchRouter setup doctor passed\./);
  assert.equal(proxy.requests.length, 1);
  assert.equal(proxy.requests[0].method, "POST");
  assert.equal(proxy.requests[0].url, "/v1/chat/completions");
  assert.equal(proxy.requests[0].authorization, "Bearer br_test_fixture");
  assert.equal(proxy.requests[0].body.model, routeId);
  assert.equal(proxy.requests[0].body.max_tokens, 1);
});

test("doctor fails when call_site.base_url_env is not referenced by route code_refs", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.PROVIDER_BASE_URL;" });
  const proxy = await startFixtureProxy(t, {
    status: 200,
    headers: { "x-benchrouter-selected-model": fixture.model },
    body: fixture
  });

  const result = await runDoctor(root, proxy.url);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /runtime wiring route app\/chat: call_site\.base_url_env OPENAI_BASE_URL is not referenced by any route code_refs/
  );
});

test("doctor reports proxy ping failure classes", async (t) => {
  await t.test("auth rejected", async (t) => {
    const root = await createTargetRepo(t, { codeRefText: "process.env.OPENAI_BASE_URL;" });
    const proxy = await startFixtureProxy(t, {
      status: 401,
      body: { error: { code: "invalid_token", message: "Invalid API key" } }
    });

    const result = await runDoctor(root, proxy.url);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /proxy ping auth rejected: HTTP 401 invalid_token/);
  });

  await t.test("route not found", async (t) => {
    const root = await createTargetRepo(t, { codeRefText: "process.env.OPENAI_BASE_URL;" });
    const proxy = await startFixtureProxy(t, {
      status: 404,
      body: { error: { code: "route_not_found", message: "Route not found" } }
    });

    const result = await runDoctor(root, proxy.url);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /proxy ping route not found: app\/chat \(route_not_found\)/);
  });

  await t.test("malformed response", async (t) => {
    const root = await createTargetRepo(t, { codeRefText: "process.env.OPENAI_BASE_URL;" });
    const proxy = await startFixtureProxy(t, {
      status: 200,
      body: { id: "chatcmpl-route-id", model: routeId, usage: { total_tokens: 1 } }
    });

    const result = await runDoctor(root, proxy.url);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /proxy ping malformed response: expected response\.model to be a concrete model/);
  });

  await t.test("network", async (t) => {
    const root = await createTargetRepo(t, { codeRefText: "process.env.OPENAI_BASE_URL;" });

    const result = await runDoctor(root, "http://127.0.0.1:9");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /proxy ping network:/);
  });
});

async function createTargetRepo(t, { codeRefText }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-setup-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  await mkdir(path.join(root, ".github/workflows"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });

  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), manifestYaml());
  await writeFile(
    path.join(root, ".benchrouter/.kit-state.json"),
    `${JSON.stringify({
      files: [
        { path: ".benchrouter/scorer.app__chat.js" },
        { path: ".benchrouter/cases.app__chat.json" }
      ]
    }, null, 2)}\n`
  );
  await writeFile(
    path.join(root, ".benchrouter/upload-results.mjs"),
    `const snippets = ${JSON.stringify([
      "plan-pr",
      "/v1/control/eval-plan",
      "/v1/control/import-github-config",
      "/arm-results",
      "validate-dispatch",
      "pull_request_number",
      "head_sha"
    ])};\nvoid snippets;\n`
  );
  await writeFile(path.join(root, ".benchrouter/sidecar.mjs"), "export {};\n");
  await writeFile(path.join(root, ".benchrouter/scorer.app__chat.js"), "export function score() { return { pass: true, score: 1 }; }\n");
  await writeFile(
    path.join(root, ".benchrouter/cases.app__chat.json"),
    `${JSON.stringify([{ id: "case-1", input: { messages: [{ role: "user", content: "hello" }] } }], null, 2)}\n`
  );
  await writeFile(
    path.join(root, ".github/workflows/benchrouter-evals.yml"),
    [
      "name: BenchRouter Evals",
      "on: [pull_request, workflow_dispatch]",
      "permissions:",
      "  id-token: write",
      "jobs:",
      "  eval:",
      "    steps:",
      "      - run: node .benchrouter/upload-results.mjs",
      "        env:",
      "          BENCHROUTER_EVAL_RUN_ID: x",
      "          BENCHROUTER_ROUTE_ID: app/chat",
      "          BENCHROUTER_API_KEY: secret",
      "          BENCHROUTER_UPLOAD_RESULTS: '1'"
    ].join("\n")
  );
  await writeFile(path.join(root, "scripts/benchrouter-eval.ts"), "export {};\n");
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      scripts: { "benchrouter:eval": "tsx scripts/benchrouter-eval.ts" },
      devDependencies: { tsx: "latest", "@types/node": "latest" }
    }, null, 2)}\n`
  );
  await writeFile(path.join(root, ".env.example"), "BENCHROUTER_API_KEY=\nOPENAI_BASE_URL=https://api.benchrouter.com/v1\n");
  await writeFile(path.join(root, "src/llm.js"), `${codeRefText}\n`);

  return root;
}

function manifestYaml() {
  return `version: 1

product:
  slug: app
  repo: example/app
  default_branch: main

routes:
  - id: chat
    route_id: ${routeId}
    name: Chat
    code_refs:
      - src/llm.js
    call_site:
      base_url_env: OPENAI_BASE_URL
    seed:
      incumbent_model: openai/gpt-4o-mini
    eval_pack:
      id: chat_v1
      config_path: .benchrouter/benchrouter.yml
      workflow: .github/workflows/benchrouter-evals.yml
      command: npm run benchrouter:eval
      capture_command: npm test
      scorer: .benchrouter/scorer.app__chat.js
      result_schema: benchrouter.result.v1
      case_refs:
        - .benchrouter/cases.app__chat.json
`;
}

async function startFixtureProxy(t, responseFixture) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    for await (const chunk of request) {
      rawBody += chunk;
    }
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body: JSON.parse(rawBody)
    });

    const responseBody = JSON.stringify(responseFixture.body);
    response.writeHead(responseFixture.status, {
      "content-type": "application/json",
      ...(responseFixture.headers ?? {})
    });
    response.end(responseBody);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests
  };
}

function runDoctor(root, apiUrl, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      BENCHROUTER_API_KEY: "br_test_fixture",
      ...envOverrides
    };
    if (Object.hasOwn(envOverrides, "BENCHROUTER_API_KEY") && envOverrides.BENCHROUTER_API_KEY === undefined) {
      delete env.BENCHROUTER_API_KEY;
    }

    const child = spawn(
      process.execPath,
      [cliPath, "doctor", "--output-dir", root, "--api-url", apiUrl, "--skip-github-secret"],
      {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}
