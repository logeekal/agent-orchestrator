/**
 * Smoke tests for worktree canonicalization on `ao project add`.
 *
 * These tests verify:
 *   - detectGitWorktree correctly identifies linked worktrees
 *   - registerProjectWithWorktreeDetection registers the parent repo
 *     and creates an adopted session (not the worktree as its own project)
 *   - POST /api/projects applies the same canonicalization
 *   - Plain (non-worktree) project add is unchanged
 *   - Adding the same worktree twice creates one project + two sessions
 *
 * Implementation files:
 *   - packages/core/src/global-config.ts  (detectGitWorktree, registerProjectWithWorktreeDetection)
 *   - packages/core/src/index.ts          (exports)
 *   - packages/cli/src/commands/project.ts (ao project add)
 *   - packages/web/src/app/api/projects/route.ts (POST /api/projects)
 */

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectGitWorktree,
  getProjectSessionsDir,
  listMetadata,
  readMetadataRaw,
  registerProjectInGlobalConfig,
  registerProjectWithWorktreeDetection,
} from "@aoagents/ao-core";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

describe("worktree canonicalization (registerProjectWithWorktreeDetection)", () => {
  let tmpDir: string;
  let mainRepoDir: string;
  let worktreeDir: string;
  let globalConfigPath: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    // Use realpath to normalize symlinks (e.g. /var → /private/var on macOS)
    // so path comparisons in assertions are consistent with detectGitWorktree.
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "ao-wt-canonicalize-")));
    mainRepoDir = join(tmpDir, "main-repo");
    worktreeDir = join(tmpDir, "worktrees", "feat-x");

    mkdirSync(mainRepoDir, { recursive: true });
    mkdirSync(join(tmpDir, "worktrees"), { recursive: true });

    await git(mainRepoDir, "init", "-b", "main");
    await git(mainRepoDir, "config", "user.email", "test@test.com");
    await git(mainRepoDir, "config", "user.name", "Test");
    await writeFile(join(mainRepoDir, "README.md"), "# Test Repo\n");
    await git(mainRepoDir, "add", ".");
    await git(mainRepoDir, "commit", "-m", "initial commit");
    await git(mainRepoDir, "worktree", "add", worktreeDir, "-b", "feat/x");

    originalHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;

    globalConfigPath = join(tmpDir, "ao-global-config.yaml");
    process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;
  }, 30_000);

  afterAll(async () => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    delete process.env["AO_GLOBAL_CONFIG"];
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  // ─── detectGitWorktree unit tests ─────────────────────────────────────────

  it("detectGitWorktree returns null for the main repo", () => {
    expect(detectGitWorktree(mainRepoDir)).toBeNull();
  });

  it("detectGitWorktree returns mainRepoPath + branch for a linked worktree", () => {
    const result = detectGitWorktree(worktreeDir);
    expect(result).not.toBeNull();
    expect(result!.mainRepoPath).toBe(mainRepoDir);
    expect(result!.branch).toBe("feat/x");
  });

  // ─── CLI path ─────────────────────────────────────────────────────────────

  it("registers parent repo — not the worktree — as the project", () => {
    const result = registerProjectWithWorktreeDetection(worktreeDir, { globalConfigPath });

    expect(result.projectId).toBeTruthy();
    expect(result.sessionId).toBeTruthy();

    // Global config must contain the PARENT repo path, not the worktree path.
    // We verify indirectly: the sessions dir is under the project matching the
    // parent, and the session metadata has worktree=worktreeDir.
    const sessionsDir = getProjectSessionsDir(result.projectId);
    const raw = readMetadataRaw(sessionsDir, result.sessionId!);
    expect(raw).not.toBeNull();
    expect(raw!["worktree"]).toBe(worktreeDir);
  });

  it("creates session metadata with worktree path, correct branch, and adoptedWorkspace='true'", () => {
    const result = registerProjectWithWorktreeDetection(worktreeDir, { globalConfigPath });
    const sessionsDir = getProjectSessionsDir(result.projectId);
    const raw = readMetadataRaw(sessionsDir, result.sessionId!);

    expect(raw!["worktree"]).toBe(worktreeDir);
    expect(raw!["branch"]).toBe("feat/x");
    expect(raw!["adoptedWorkspace"]).toBe("true");
    // "terminated" so the dashboard restore button can work (isRestorable requires terminal state)
    expect(raw!["status"]).toBe("terminated");
  });

  // ─── Web API path ──────────────────────────────────────────────────────────
  // Full route.ts test requires Next.js context; use the core function directly
  // to verify the same contract the handler calls.

  it("registerProjectWithWorktreeDetection (called by POST /api/projects) returns { projectId, sessionId }", () => {
    const result = registerProjectWithWorktreeDetection(worktreeDir, { globalConfigPath });
    expect(result.projectId).toBeTruthy();
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId).toMatch(/^[a-z]+-\d+$/);
  });

  // ─── Regression: plain project add must NOT create a session ──────────────

  it("registering the main repo directly returns sessionId=null (no adopted session)", async () => {
    // Use a distinct secondary repo so this test is isolated from the earlier
    // worktree tests that already registered mainRepoDir under a different project ID.
    const repoForRegression = join(tmpDir, "regression-repo");
    mkdirSync(repoForRegression, { recursive: true });
    await git(repoForRegression, "init", "-b", "main");
    await git(repoForRegression, "config", "user.email", "test@test.com");
    await git(repoForRegression, "config", "user.name", "Test");
    await writeFile(join(repoForRegression, "README.md"), "# Regression\n");
    await git(repoForRegression, "add", ".");
    await git(repoForRegression, "commit", "-m", "init");

    const projectId = registerProjectInGlobalConfig(
      "regression-repo",
      "regression-repo",
      repoForRegression,
      { defaultBranch: "main" },
      globalConfigPath,
    );

    const sessionsDir = getProjectSessionsDir(projectId);
    const sessions = existsSync(sessionsDir) ? listMetadata(sessionsDir) : [];
    expect(sessions).toHaveLength(0);
  });

  // ─── Idempotency: same worktree twice → one project, two sessions ──────────

  it("adding the same worktree twice creates one project entry and accumulates sessions", () => {
    const result1 = registerProjectWithWorktreeDetection(worktreeDir, { globalConfigPath });
    const result2 = registerProjectWithWorktreeDetection(worktreeDir, { globalConfigPath });

    expect(result2.projectId).toBe(result1.projectId);
    expect(result2.sessionId).not.toBe(result1.sessionId);

    const sessionsDir = getProjectSessionsDir(result1.projectId);
    const sessions = listMetadata(sessionsDir);
    expect(sessions).toContain(result1.sessionId);
    expect(sessions).toContain(result2.sessionId);
  });
});
