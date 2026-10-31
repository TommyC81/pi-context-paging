import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const piCommand = process.platform === "win32" ? ".\\node_modules\\.bin\\pi.cmd" : "./node_modules/.bin/pi";
const expectedFiles = [
  "LICENSE",
  "README.md",
  "docs/architecture.md",
  "package.json",
  "src/context-calibration.ts",
  "src/context-cut.ts",
  "src/context-policy.ts",
  "src/context-usage.ts",
  "src/history.ts",
  "src/index.ts",
  "src/navigator.ts",
  "src/output-pages.ts",
  "src/paging-notice.ts",
  "src/recovery-content.ts",
  "src/recovery-loads.ts",
  "src/recovery-parts.ts",
  "src/recovery-response.ts",
  "src/selection-history.ts",
  "src/settings.ts",
  "src/stats.ts",
  "src/tools.ts",
].sort();
const requiredTools = [
  "search_history",
  "browse_history",
  "load_history",
  "read_context_output",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited with ${result.status}`,
        result.stdout,
        result.stderr,
      ].join("\n"),
    );
  }

  return result.stdout;
}

function createPiEnvironment(homeDirectory, toolsetOutput) {
  const environment = {
    ...process.env,
    HOME: homeDirectory,
    PI_TOOLSET_PROBE_OUTPUT: toolsetOutput,
  };
  delete environment.PI_PACKAGE_DIR;
  return environment;
}

function assertTemporaryPath(path) {
  assert(path.length > 0, "temporary path is empty");
  assert(path.startsWith("/tmp/"), `refusing to remove non-/tmp path: ${path}`);
}

async function removeTemporaryPath(path) {
  assertTemporaryPath(path);
  await rm(path, { recursive: true, force: false });
}

let workDirectory;
let homeDirectory;
let cleanupStarted = false;

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const errors = [];

  for (const path of [homeDirectory, workDirectory]) {
    if (!path) continue;
    try {
      await removeTemporaryPath(path);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) throw errors[0];
}

for (const [signal, status] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    cleanup()
      .catch((error) => console.error(error))
      .finally(() => process.exit(status));
  });
}

let failure;
try {
  workDirectory = await mkdtemp("/tmp/pi-context-paging-pack-");
  assertTemporaryPath(workDirectory);

  const packOutput = run(npmCommand, [
    "pack",
    "--json",
    "--pack-destination",
    workDirectory,
  ]);
  const [packed] = JSON.parse(packOutput);
  const actualFiles = packed.files.map((file) => file.path).sort();
  assert.deepEqual(actualFiles, expectedFiles);

  const tarball = join(workDirectory, packed.filename);
  run("tar", ["-xzf", tarball, "-C", workDirectory]);

  homeDirectory = await mkdtemp("/tmp/pi-context-paging-home.");
  assertTemporaryPath(homeDirectory);
  const toolsetOutput = join(workDirectory, "tools.json");
  const piEnvironment = createPiEnvironment(homeDirectory, toolsetOutput);

  run(piCommand, ["--version"], { env: piEnvironment });
  run(
    piCommand,
    [
      "--no-session",
      "--no-builtin-tools",
      "-e",
      join(workDirectory, "package"),
      "--extension",
      join(repoRoot, "scripts", "toolset-probe.ts"),
      "-p",
      "/write-toolset-probe",
    ],
    { env: piEnvironment },
  );

  const tools = JSON.parse(await readFile(toolsetOutput, "utf8"));
  for (const name of requiredTools) {
    assert(tools.all.includes(name), `${name} is not registered`);
    assert(tools.active.includes(name), `${name} is not active`);
  }

  console.log(`verified ${packed.filename} and ${requiredTools.length} history tools`);
} catch (error) {
  failure = error;
}

let cleanupFailure;
try {
  await cleanup();
} catch (error) {
  cleanupFailure = error;
}

if (failure) {
  if (cleanupFailure) console.error("cleanup also failed:", cleanupFailure);
  throw failure;
}
if (cleanupFailure) throw cleanupFailure;
