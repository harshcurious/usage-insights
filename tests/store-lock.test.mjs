import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { workerClaimActive } from "../mods/insights/core/fence.mjs";
import { isLocalOwner, machineId, withStoreLock } from "../mods/insights/core/util.mjs";

const DEAD_PID = 999_999_999;

async function storeDir(t) {
  const root = await mkdtemp(path.join(tmpdir(), "insights-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "insights.json");
}

async function writeOwner(storePath, owner) {
  const lockPath = `${storePath}.lock`;
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner-old.json"), JSON.stringify(owner));
  return lockPath;
}

test("a dead lock owner is reclaimed after this machine's hostname changes", async (t) => {
  const machine = machineId();
  if (!machine) {
    t.skip("no stable machine id on this platform");
    return;
  }
  const storePath = await storeDir(t);
  await writeOwner(storePath, {
    pid: DEAD_PID, host: "renamed-host.local", machine, startedAt: Date.now() - 1000, token: "old",
  });
  const ran = await withStoreLock(storePath, async () => "ran", { timeoutMs: 2_000 });
  assert.equal(ran, "ran");
});

test("a lock from another machine still fails closed", async (t) => {
  const storePath = await storeDir(t);
  await writeOwner(storePath, {
    pid: DEAD_PID, host: "other-host", machine: "00000000-0000-0000-0000-000000000000",
    startedAt: Date.now() - 1000, token: "other",
  });
  await assert.rejects(
    withStoreLock(storePath, async () => "ran", { timeoutMs: 300 }),
    /busy/,
  );
});

test("an old empty lock directory is removed, a fresh one is not", async (t) => {
  const storePath = await storeDir(t);
  const lockPath = `${storePath}.lock`;
  await mkdir(lockPath);
  await assert.rejects(
    withStoreLock(storePath, async () => "ran", { timeoutMs: 300 }),
    /busy/,
  );
  const old = new Date(Date.now() - 11 * 60 * 1000);
  await utimes(lockPath, old, old);
  const ran = await withStoreLock(storePath, async () => "ran", { timeoutMs: 2_000 });
  assert.equal(ran, "ran");
});

test("worker claims recognise this machine across hostname changes", (t) => {
  const machine = machineId();
  if (!machine) {
    t.skip("no stable machine id on this platform");
    return;
  }
  const renamed = { host: "renamed-host.local", machine, pid: DEAD_PID };
  assert.equal(isLocalOwner(renamed), true);
  assert.equal(workerClaimActive(renamed), false, "a dead local worker's claim is not active");
  assert.equal(workerClaimActive({ host: "renamed-host.local", pid: DEAD_PID }), true,
    "a claim without a machine id from another host fails closed");
});
