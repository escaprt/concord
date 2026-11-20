import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRuntime } from "../src/main.js";
import { loadConfig, type Config } from "../src/config.js";
import { verifyBackupFile } from "../src/cli.js";

const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("CLI backup and restore", { timeout: 30_000 }, () => {
  let liveDataDir: string;
  let backupDir: string;
  let restoreDir: string;
  let orgId: string;
  let config: Config;

  beforeAll(async () => {
    liveDataDir = mkdtempSync(join(tmpdir(), "concord-live-"));
    backupDir = mkdtempSync(join(tmpdir(), "concord-backup-"));
    restoreDir = mkdtempSync(join(tmpdir(), "concord-restore-"));

    config = loadConfig({ CONCORD_DATA_DIR: liveDataDir });
    const runtime = openRuntime(config);
    const { orgId: newOrgId } = await runtime.auth.signUp({
      email: "operator@example.test",
      name: "Operator",
      password: "Password123!",
      orgName: "Operator Workspace",
    });
    orgId = newOrgId;

    const concord = runtime.tenants.forOrg(orgId);
    concord.db.insert(
      `INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "ASSET1",
      "testnet",
      "ASSET1",
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "Asset One",
      7,
      "ledger",
      "ready",
      "2026-10-01T00:00:00Z",
    );
    runtime.close();
  });

  afterAll(() => {
    for (const d of [liveDataDir, backupDir, restoreDir]) {
      try {
        if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
      } catch {
        // Ignore file lock release delay on Windows
      }
    }
  });

  function run(args: string[]): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execFileSync(process.execPath, [tsx, cliPath, ...args], {
        env: {
          ...process.env,
          CONCORD_DATA_DIR: liveDataDir,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, stderr: "", status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
    }
  }

  it("creates a verified backup with backup --verify", () => {
    const res = run(["backup", backupDir, "--verify"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`backed up control.db and 1 workspaces to ${backupDir}`);
    expect(existsSync(join(backupDir, "control.db"))).toBe(true);
    expect(existsSync(join(backupDir, "orgs", `${orgId}.db`))).toBe(true);
  });

  it("reports a corrupted backup with the file name when integrity or version fails", () => {
    const corruptFile = join(backupDir, "corrupt.db");
    writeFileSync(corruptFile, "not a valid sqlite database");
    expect(() => verifyBackupFile(corruptFile, 1)).toThrow(/corrupted backup: .*corrupt\.db/);

    const validControl = join(backupDir, "control.db");
    expect(() => verifyBackupFile(validControl, 9999)).toThrow(
      /corrupted backup: .*control\.db.*user_version mismatch/,
    );
  });

  it("refuses to restore into a non-empty directory without --force", () => {
    // Put a dummy file in restoreDir
    const dummyFile = join(restoreDir, "dummy.txt");
    writeFileSync(dummyFile, "dummy content");

    const res = run(["restore", backupDir, "--into", restoreDir]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("destination directory");
    expect(res.stderr).toContain("is not empty; pass --force to overwrite");
  });

  it("restores into an empty directory and yields a working server", () => {
    // Empty the restoreDir
    rmSync(join(restoreDir, "dummy.txt"), { force: true });
    expect(readdirSync(restoreDir)).toHaveLength(0);

    const res = run(["restore", backupDir, "--into", restoreDir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`restored backup from ${backupDir} into ${restoreDir}`);

    // Verify restored server works
    const restoredConfig = loadConfig({ CONCORD_DATA_DIR: restoreDir });
    const restoredRuntime = openRuntime(restoredConfig);

    expect(restoredRuntime.auth.orgIds()).toContain(orgId);
    const concord = restoredRuntime.tenants.forOrg(orgId);
    expect(concord.asset("ASSET1")).toMatchObject({
      code: "ASSET1",
      network: "testnet",
    });

    restoredRuntime.close();
  });

  it("restores into a non-empty directory when --force is passed", () => {
    // Put a dummy file in restoreDir
    writeFileSync(join(restoreDir, "file-to-overwrite.txt"), "to overwrite");

    const res = run(["restore", backupDir, "--into", restoreDir, "--force"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`restored backup from ${backupDir} into ${restoreDir}`);

    // Verify restored server works
    const restoredConfig = loadConfig({ CONCORD_DATA_DIR: restoreDir });
    const restoredRuntime = openRuntime(restoredConfig);
    expect(restoredRuntime.auth.orgIds()).toContain(orgId);
    restoredRuntime.close();
  });
});
