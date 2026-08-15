import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export interface HarnessSnapshotEntry {
  path: string;
  bytes: number;
  sha256: string;
  content: string;
}

export interface HarnessManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface HarnessSourceIdentity {
  gitCommit: string;
  dirty: boolean;
  manifestSha256: string;
  packageLockSha256: string;
  snapshotSha256: string;
  snapshotFile?: string;
}

export interface HarnessSourceCapture {
  identity: HarnessSourceIdentity;
  manifest: HarnessManifestEntry[];
  snapshot: HarnessSnapshotEntry[];
}

function execFileText(command: string, args: readonly string[], cwd: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    command,
    [...args],
    { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim();
        reject(
          new Error(
            `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
            { cause: error },
          ),
        );
        return;
      }
      resolve(stdout.trim());
    },
  );
  return promise;
}

async function collectFiles(directory: string, prefix: string): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await collectFiles(directory, path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

export async function captureHarnessSource(
  packageRoot: string,
): Promise<HarnessSourceCapture> {
  const sourcePaths = [
    ...await collectFiles(packageRoot, "src"),
    ...await collectFiles(packageRoot, "test"),
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ].sort();
  const snapshot: HarnessSnapshotEntry[] = [];
  for (const path of sourcePaths) {
    const content = await readFile(join(packageRoot, path), "utf8");
    snapshot.push({
      path,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    });
  }
  const manifest: HarnessManifestEntry[] = snapshot.map(({ path, bytes, sha256 }) => ({
    path,
    bytes,
    sha256,
  }));
  const gitRoot = await execFileText("git", ["rev-parse", "--show-toplevel"], packageRoot);
  const relativePackageRoot = relative(gitRoot, packageRoot).split("\\").join("/");
  const statusPaths = ["src", "test", "package.json", "package-lock.json", "tsconfig.json"].map(
    (path) => relativePackageRoot.length > 0 ? `${relativePackageRoot}/${path}` : path,
  );
  const status = await execFileText(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ...statusPaths,
    ],
    gitRoot,
  );
  return {
    identity: {
      gitCommit: await execFileText("git", ["rev-parse", "HEAD"], gitRoot),
      dirty: status.length > 0,
      manifestSha256: createHash("sha256")
        .update(JSON.stringify(manifest))
        .digest("hex"),
      packageLockSha256:
        snapshot.find((entry) => entry.path === "package-lock.json")?.sha256 ?? "",
      snapshotSha256: createHash("sha256")
        .update(JSON.stringify(snapshot))
        .digest("hex"),
    },
    manifest,
    snapshot,
  };
}
