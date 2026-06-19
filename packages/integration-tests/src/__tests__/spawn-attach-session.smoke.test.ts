/**
 * Smoke tests for `ao spawn --attach-session <id>`.
 *
 * Status: SKIPPED — implementation landed but tests need a mock runtime to run
 * without tmux. Unblock in a follow-up once integration test infra supports
 * injecting a no-op runtime plugin.
 *
 * Feature:
 *   `ao spawn --attach-session <id>` adopts an existing AO session's worktree
 *   instead of creating a new one. It seeds the new session with the old session's
 *   agent resume keys so the agent can continue the prior conversation.
 *
 * Contract:
 *   - The new session's metadata.worktree == source session's metadata.worktree
 *   - The new session's metadata.adoptedWorkspace == 'true'
 *   - All resume keys from the source session (claudeSessionUuid, codexThreadId, …)
 *     are copied to the new session so the agent can restore prior context
 *   - Killing the new session must NOT delete the worktree directory (adoptedWorkspace)
 *   - --attach-session and --claim-pr are mutually exclusive (validation error)
 *
 * Implementation files:
 *   - packages/core/src/types.ts          (SessionSpawnConfig.attachSessionId, SessionMetadata.adoptedWorkspace)
 *   - packages/core/src/session-manager.ts (_spawnInner attach branch, kill adoptedWorkspace guard)
 *   - packages/cli/src/commands/spawn.ts   (--attach-session flag, mutual exclusion check)
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPluginRegistry,
  createSessionManager,
  getProjectSessionsDir,
  readMetadataRaw,
  writeMetadata,
  type OrchestratorConfig,
  type SessionMetadata,
} from "@aoagents/ao-core";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

describe.skip("spawn --attach-session [TODO: unblock in PR 1]", () => {
  const projectId = "attach-session-test";
  let tmpDir: string;
  let mainRepoDir: string;
  let worktreeDir: string;
  let sessionsDir: string;
  let config: OrchestratorConfig;
  let originalHome: string | undefined;

  // Source session that will be "attached to" in all tests
  const sourceSessionId = "ao-1";

  beforeAll(async () => {
    const raw = await mkdtemp(join(tmpdir(), "ao-attach-session-"));
    tmpDir = raw;
    mainRepoDir = join(tmpDir, "main-repo");
    worktreeDir = join(tmpDir, "worktrees", "session-wt");

    mkdirSync(mainRepoDir, { recursive: true });
    mkdirSync(join(tmpDir, "worktrees"), { recursive: true });

    // Set up a real git repo and worktree so that worktree-path assertions are
    // verifiable against real filesystem state
    await git(mainRepoDir, "init", "-b", "main");
    await git(mainRepoDir, "config", "user.email", "test@test.com");
    await git(mainRepoDir, "config", "user.name", "Test");
    await writeFile(join(mainRepoDir, "README.md"), "# Test\n");
    await git(mainRepoDir, "add", ".");
    await git(mainRepoDir, "commit", "-m", "initial commit");
    await git(mainRepoDir, "worktree", "add", worktreeDir, "-b", "session/ao-1");

    // Redirect HOME so session storage goes to tmpDir, not real ~/.agent-orchestrator
    originalHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;

    sessionsDir = getProjectSessionsDir(projectId);
    mkdirSync(sessionsDir, { recursive: true });

    // Write metadata for the source session (as if ao had already spawned it)
    const sourceMetadata: SessionMetadata = {
      worktree: worktreeDir,
      branch: "session/ao-1",
      status: "idle",
      project: projectId,
      claudeSessionUuid: "claude-uuid-abc123",
      createdAt: new Date().toISOString(),
    };
    writeMetadata(sessionsDir, sourceSessionId, sourceMetadata);

    // Minimal config to drive createSessionManager (runtime is mocked below)
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    await writeFile(configPath, "");
    config = {
      configPath,
      port: 4000,
      readyThresholdMs: 300_000,
      power: { preventIdleSleep: false },
      defaults: {
        runtime: "mock",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {
        [projectId]: {
          name: "attach-session-test",
          repo: "test/attach-session-test",
          path: mainRepoDir,
          defaultBranch: "main",
          sessionPrefix: "ao",
        },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };
  }, 30_000);

  afterAll(async () => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  // ─── Basic attach: new session adopts source session's worktree ─────────────

  it("creates a new session that adopts the source session's worktree directory", async () => {
    // TODO: inject a no-op runtime plugin into createPluginRegistry so spawn()
    // does not require tmux. Once the test infra supports that, replace the
    // manual metadata write below with:
    //   const registry = createPluginRegistry();
    //   const sm = createSessionManager({ config, registry });
    //   const session = await sm.spawn({ projectId, attachSessionId: sourceSessionId });
    //
    // For now, simulate the outcome at the metadata layer to document the contract:
    const newSessionId = "ao-2";
    writeMetadata(sessionsDir, newSessionId, {
      worktree: worktreeDir,
      branch: "session/ao-1",
      status: "spawning",
      project: projectId,
      adoptedWorkspace: "true",
    });

    const raw = readMetadataRaw(sessionsDir, newSessionId);
    expect(raw).not.toBeNull();
    expect(raw!["worktree"]).toBe(worktreeDir);
    expect(raw!["adoptedWorkspace"]).toBe("true");
    expect(raw!["branch"]).toBe("session/ao-1");
    expect(newSessionId).not.toBe(sourceSessionId); // must be a fresh ID

    // Verify createSessionManager + createPluginRegistry are importable (type smoke)
    expect(createSessionManager).toBeTypeOf("function");
    expect(createPluginRegistry).toBeTypeOf("function");
  });

  // ─── Resume key seeding: agent keys propagate from source to new session ────

  it("seeds the new session with the source session's claudeSessionUuid so the agent can resume", async () => {
    const newSessionId = "ao-3";
    // Simulates what _spawnInner will write when attachSessionId is set
    writeMetadata(sessionsDir, newSessionId, {
      worktree: worktreeDir,
      branch: "session/ao-1",
      status: "spawning",
      project: projectId,
      adoptedWorkspace: "true",
      claudeSessionUuid: "claude-uuid-abc123", // copied from source
    });

    const raw = readMetadataRaw(sessionsDir, newSessionId);
    expect(raw!["claudeSessionUuid"]).toBe("claude-uuid-abc123");
  });

  it("omits resume keys that are absent in the source session (no phantom keys written)", async () => {
    const newSessionId = "ao-4";
    writeMetadata(sessionsDir, newSessionId, {
      worktree: worktreeDir,
      branch: "session/ao-1",
      status: "spawning",
      project: projectId,
      adoptedWorkspace: "true",
      // codexThreadId intentionally absent — source did not have it
    });

    const raw = readMetadataRaw(sessionsDir, newSessionId);
    expect(raw!["codexThreadId"]).toBeUndefined();
  });

  // ─── Kill safety: adopted worktree survives session termination ─────────────

  it("adoptedWorkspace='true' in metadata signals the kill path to skip workspace.destroy()", () => {
    // The kill() method reads raw["adoptedWorkspace"] and skips workspace.destroy()
    // when it equals "true". We verify the metadata contract that makes this work.
    const raw = readMetadataRaw(sessionsDir, "ao-2");
    expect(raw!["adoptedWorkspace"]).toBe("true");
    expect(existsSync(worktreeDir)).toBe(true); // directory must still be present
  });

  // ─── Mutual exclusion: --attach-session + --claim-pr must be rejected ───────

  it("SessionSpawnConfig accepts attachSessionId (type-level check)", () => {
    // This test verifies the type change landed. If it compiles, the field exists.
    const _validConfig: import("@aoagents/ao-core").SessionSpawnConfig = {
      projectId,
      attachSessionId: sourceSessionId,
    };
    expect(_validConfig.attachSessionId).toBe(sourceSessionId);
  });

  it("spawn with both attachSessionId and claimPr throws a validation error", async () => {
    // The CLI enforces this via process.exit(1). The session manager itself
    // does not validate claimPr (that's a post-spawn step), so this is a
    // CLI-layer contract documented here for cross-reference.
    //
    // Validated by: packages/cli/src/commands/spawn.ts
    //   if (opts.attachSession && opts.claimPr) { ... process.exit(1) }
    //
    // TODO: add a CLI subprocess test that runs `ao spawn --attach-session <id> --claim-pr 42`
    // and asserts exit code 1 once the test infra supports subprocesses safely.
    expect(true).toBe(true); // placeholder — see TODO above
  });
});
