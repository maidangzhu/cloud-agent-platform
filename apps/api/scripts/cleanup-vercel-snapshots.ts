import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { Snapshot } from "@vercel/sandbox";

type SnapshotRecord = {
  id: string;
  sourceSessionId: string;
  status: "created" | "deleted" | "failed";
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  creationMethod?: string;
  parentId?: string;
};

type Options = {
  confirm: boolean;
  includeBase: boolean;
  olderThanMs: number;
  keepLatest: number;
  sandboxName?: string;
  concurrency: number;
};

loadRootEnv();

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const { resolveVercelCredentials } = await import(
    "../src/sandbox/vercel-credentials.js"
  );
  const credentials = resolveVercelCredentials();
  if (!credentials) {
    throw new Error(
      "Missing Vercel credentials. Set VERCEL_TOKEN (or VERCEL_OIDC_TOKEN) plus team/project IDs.",
    );
  }

  const result = await Snapshot.list({
    ...credentials,
    projectId: credentials.projectId,
    sortOrder: "desc",
    limit: 50,
    ...(options.sandboxName ? { name: options.sandboxName } : {}),
  });
  const snapshots = (await result.toArray()) as SnapshotRecord[];
  const active = snapshots.filter((snapshot) => snapshot.status === "created");
  const baseSnapshotId = process.env.VERCEL_BASE_SNAPSHOT_ID?.trim();
  const protectedSnapshotIds = new Set(
    baseSnapshotId && !options.includeBase ? [baseSnapshotId] : [],
  );
  const cutoff = Date.now() - options.olderThanMs;
  const candidates = active
    .filter((snapshot) => !protectedSnapshotIds.has(snapshot.id))
    .filter((snapshot) => snapshot.createdAt <= cutoff)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(options.keepLatest);

  console.log(`Project: ${credentials.projectId}`);
  console.log(`Scope: ${options.sandboxName ?? "all project snapshots"}`);
  console.log(
    `Snapshots: ${snapshots.length} listed, ${active.length} active, ${formatBytes(sumBytes(active))} active storage`,
  );
  console.log(
    `Candidates: ${candidates.length}, ${formatBytes(sumBytes(candidates))} storage`,
  );
  if (protectedSnapshotIds.size > 0) {
    console.log(`Protected golden snapshot: ${baseSnapshotId}`);
  }

  for (const snapshot of candidates) {
    console.log(
      [
        snapshot.id,
        formatBytes(snapshot.sizeBytes),
        new Date(snapshot.createdAt).toISOString(),
        snapshot.creationMethod ?? "unknown",
        `session=${snapshot.sourceSessionId}`,
      ].join("\t"),
    );
  }

  if (!options.confirm) {
    console.log("Dry run only. Re-run with --confirm to delete these candidates.");
    return;
  }

  let deleted = 0;
  const errors: Array<{ id: string; message: string }> = [];
  await runWithConcurrency(candidates, options.concurrency, async (record) => {
    try {
      const snapshot = await Snapshot.get({
        snapshotId: record.id,
        ...credentials,
      });
      await snapshot.delete();
      deleted += 1;
      console.log(`Deleted ${record.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ id: record.id, message });
      console.error(`Failed ${record.id}: ${message}`);
    }
  });

  console.log(`Deletion complete: ${deleted} deleted, ${errors.length} failed.`);
  if (errors.length > 0) process.exitCode = 1;
}

function loadRootEnv(): void {
  const root = path.resolve(process.cwd(), "../..");
  for (const file of [".env", ".env.local"]) {
    try {
      const parsed = parseEnv(
        fs.readFileSync(path.join(root, file), "utf8"),
      );
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value !== "") process.env[key] = value;
      }
    } catch {
      // Missing local env files are allowed; CI can provide environment variables.
    }
  }
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    confirm: false,
    includeBase: false,
    olderThanMs: 0,
    keepLatest: 0,
    concurrency: 4,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--confirm") {
      options.confirm = true;
      continue;
    }
    if (arg === "--include-base") {
      options.includeBase = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    const [key, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    if (key === "--older-than") {
      options.olderThanMs = parseDuration(value);
    } else if (key === "--keep-latest") {
      options.keepLatest = parseNonNegativeInteger(key, value);
    } else if (key === "--sandbox-name") {
      options.sandboxName = value;
    } else if (key === "--concurrency") {
      options.concurrency = parsePositiveInteger(key, value);
    } else {
      throw new Error(`Unknown option: ${key}`);
    }
  }
  return options;
}

function parseDuration(value: string): number {
  const match = /^(\d+)(m|h|d|w)?$/.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const multiplier =
    match[2] === "w"
      ? 7 * 24 * 60 * 60 * 1000
      : match[2] === "d"
        ? 24 * 60 * 60 * 1000
        : match[2] === "h"
          ? 60 * 60 * 1000
          : 60 * 1000;
  return amount * multiplier;
}

function parseNonNegativeInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveInteger(name: string, value: string): number {
  const parsed = parseNonNegativeInteger(name, value);
  if (parsed === 0) throw new Error(`${name} must be greater than zero`);
  return parsed;
}

function sumBytes(records: SnapshotRecord[]): number {
  return records.reduce((sum, snapshot) => sum + snapshot.sizeBytes, 0);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const nextUnit of units) {
    value /= 1024;
    unit = nextUnit;
    if (value < 1024) break;
  }
  return `${value.toFixed(2)} ${unit}`;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await worker(item);
      }
    }),
  );
}

function printHelp(): void {
  console.log(`Usage: pnpm sandbox:snapshots:cleanup -- [options]

Options:
  --confirm                 Delete matching snapshots (default is dry-run)
  --include-base            Also delete VERCEL_BASE_SNAPSHOT_ID
  --older-than <duration>   Only delete snapshots at least this old (30m, 12h, 7d, 2w)
  --keep-latest <count>     Keep this many newest matching snapshots
  --sandbox-name <name>     Limit cleanup to one exact sandbox name
  --concurrency <count>     Parallel delete requests (default: 4)
  --help                    Show this help
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (typeof error === "object" && error !== null) {
    const details = error as { json?: unknown; text?: string };
    if (details.json !== undefined) console.error(JSON.stringify(details.json));
    if (details.text) console.error(details.text);
  }
  process.exit(1);
});
