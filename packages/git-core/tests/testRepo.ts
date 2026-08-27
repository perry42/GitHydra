import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

/** Minimal, direct git invocation for test fixture setup — deliberately separate from the
 * library's own gitProcess.ts so tests don't depend on the code under test to build fixtures. */
export function git(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test Author",
        GIT_AUTHOR_EMAIL: "author@example.com",
        GIT_COMMITTER_NAME: "Test Committer",
        GIT_COMMITTER_EMAIL: "committer@example.com",
        GIT_TERMINAL_PROMPT: "0",
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

let counter = 0;

/** Create a fresh temp directory for a test repo. Caller is responsible for cleanup via cleanupTestRepo. */
export async function makeTempDir(): Promise<string> {
  counter += 1;
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-git-core-"));
  return base;
}

export async function initRepo(opts: { bare?: boolean } = {}): Promise<string> {
  const dir = await makeTempDir();
  const args = ["init", "-q", "--initial-branch=main"];
  if (opts.bare) args.push("--bare");
  args.push(dir);
  await git(process.cwd(), args);
  return dir;
}

export async function writeFile(repoDir: string, relPath: string, contents: string): Promise<void> {
  const full = path.join(repoDir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents, "utf8");
}

export async function commit(repoDir: string, message: string, opts: { allowEmpty?: boolean } = {}): Promise<string> {
  await git(repoDir, ["add", "-A"]);
  const args = ["commit", "-q", "-m", message];
  if (opts.allowEmpty) args.push("--allow-empty");
  await git(repoDir, args);
  const { stdout } = await git(repoDir, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
}
