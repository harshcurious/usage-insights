import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { workerClaimActive } from "../mods/insights/core/fence.mjs";
import { isLocalOwner, machineId, sweepStoreLeftovers, withStoreLock } from "../mods/insights/core/util.mjs";

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

test("leftover temp, lock and reap files are swept once old; three corrupt backups are kept", async (t) => {
  const storePath = await storeDir(t);
  const dir = path.dirname(storePath);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const oldNames = [
    ".insights.json.tmp-123-1700000000000-abcd1234",
    "insights.json.worker.json.123-abcdef012345.reap",
  ];
  for (const name of oldNames) await writeFile(path.join(dir, name), "x");
  await mkdir(path.join(dir, ".insights.json.lock.acquire-tok"));
  await mkdir(path.join(dir, "insights.json.lock.release-tok"));
  await writeFile(path.join(dir, "insights.json.lock.release-tok", "owner-tok.json"), "{}");
  for (const name of [...oldNames, ".insights.json.lock.acquire-tok", "insights.json.lock.release-tok"]) {
    await utimes(path.join(dir, name), old, old);
  }
  const fresh = ".insights.json.tmp-456-1700000000001-beef0000";
  await writeFile(path.join(dir, fresh), "x");
  const unrelated = ".other.json.tmp-123-1700000000000-abcd1234";
  await writeFile(path.join(dir, unrelated), "x");
  await utimes(path.join(dir, unrelated), old, old);
  for (const stamp of ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"]) {
    await writeFile(path.join(dir, `insights.json.corrupt-${stamp}`), "{");
  }

  await sweepStoreLeftovers(storePath);

  const left = (await readdir(dir)).sort();
  assert.deepEqual(left, [
    fresh,
    unrelated,
    "insights.json.corrupt-2026-03-01",
    "insights.json.corrupt-2026-04-01",
    "insights.json.corrupt-2026-05-01",
  ].sort());
});

test("taking the store lock sweeps old leftovers", async (t) => {
  const storePath = await storeDir(t);
  const dir = path.dirname(storePath);
  const stale = path.join(dir, ".insights.json.tmp-1-1-aa");
  await writeFile(stale, "x");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(stale, old, old);
  await withStoreLock(storePath, async () => {}, { timeoutMs: 2_000 });
  assert.equal((await readdir(dir)).includes(".insights.json.tmp-1-1-aa"), false);
});
