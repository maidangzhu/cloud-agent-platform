import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { Sandbox } from "@vercel/sandbox";
import { resolveVercelCredentials } from "../src/sandbox/vercel-credentials.js";

const WORKING_DIR = "/vercel/sandbox";
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

loadRootEnv();

async function main(): Promise<void> {
  const existingSnapshotId = process.env.VERCEL_BASE_SNAPSHOT_ID?.trim();
  if (existingSnapshotId && !process.argv.includes("--force")) {
    throw new Error(
      `Golden snapshot ${existingSnapshotId} is already configured. Use --force to create a replacement.`,
    );
  }
  const credentials = resolveVercelCredentials();
  if (!credentials) {
    throw new Error(
      "Missing Vercel credentials. Set VERCEL_TOKEN (or VERCEL_OIDC_TOKEN) plus team/project IDs.",
    );
  }

  const apiPackage = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const version = apiPackage.dependencies?.["@earendil-works/pi-agent-core"];
  const aiVersion = apiPackage.dependencies?.["@earendil-works/pi-ai"];
  if (!version || !aiVersion || version !== aiVersion) {
    throw new Error("Pi runtime package versions are missing or do not match");
  }

  const name = `cap-pi-runtime-base-builder-${Date.now()}`;
  const sandbox = await Sandbox.create({
    name,
    runtime: "node24",
    persistent: false,
    timeout: BUILD_TIMEOUT_MS,
    ...credentials,
  });
  let snapshotted = false;

  try {
    const packageJson = JSON.stringify({
      type: "module",
      private: true,
      dependencies: {
        "@earendil-works/pi-agent-core": version,
        "@earendil-works/pi-ai": aiVersion,
      },
    });
    await sandbox.writeFiles([
      { path: `${WORKING_DIR}/package.json`, content: Buffer.from(packageJson) },
    ]);

    console.log(`Installing Pi runtime ${version} in ${name}...`);
    const install = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "--omit=dev", "--no-audit", "--no-fund"],
      cwd: WORKING_DIR,
    });
    if (install.exitCode !== 0) {
      throw new Error(`npm install failed: ${await install.stderr()}`);
    }

    const verify = await sandbox.runCommand({
      cmd: "npm",
      args: ["ls", "--omit=dev", "--depth=0", "--silent"],
      cwd: WORKING_DIR,
    });
    if (verify.exitCode !== 0) {
      throw new Error(`npm ls failed: ${await verify.stderr()}`);
    }

    const snapshot = await sandbox.snapshot({ expiration: 0 });
    snapshotted = true;
    console.log(`Created golden snapshot: ${snapshot.snapshotId}`);
    console.log(`Size: ${formatBytes(snapshot.sizeBytes)}`);
    console.log(`Set VERCEL_BASE_SNAPSHOT_ID=${snapshot.snapshotId}`);
  } finally {
    if (!snapshotted) await sandbox.stop().catch(() => undefined);
  }
}

function loadRootEnv(): void {
  const root = path.resolve(process.cwd(), "../..");
  for (const file of [".env", ".env.local"]) {
    try {
      const parsed = parseEnv(fs.readFileSync(path.join(root, file), "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value !== "") process.env[key] = value;
      }
    } catch {
      // Missing local env files are allowed; CI can provide environment variables.
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = "B";
  for (const nextUnit of units) {
    value /= 1024;
    unit = nextUnit;
    if (value < 1024) break;
  }
  return `${value.toFixed(2)} ${unit}`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
