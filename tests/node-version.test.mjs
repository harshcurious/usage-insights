import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_NODE_VERSION,
  assertSupportedNodeVersion,
  isNodeVersionSupported,
} from "../scripts/lib.mjs";

test("Node version gate accepts 22.15+ and rejects older runtimes", () => {
  assert.equal(MIN_NODE_VERSION, "22.15");

  for (const version of ["20.0.0", "22.0.0", "22.14.0", "22.14.99"]) {
    assert.equal(isNodeVersionSupported(version), false, version);
    assert.throws(
      () => assertSupportedNodeVersion(version),
      { message: `Node >=22.15 is required; running ${version}.` },
      version,
    );
  }

  for (const version of ["22.15.0", "22.15.1", "22.99.0", "24.0.0", "v24.22.1"]) {
    assert.equal(isNodeVersionSupported(version), true, version);
    assert.doesNotThrow(() => assertSupportedNodeVersion(version), version);
  }
});

test("runtime.json prefers a stable node on PATH over a versioned Cellar path", async () => {
  const { stableNodePath } = await import("../scripts/lib.mjs");
  const cellar = "/opt/homebrew/Cellar/node/26.1.0/bin/node";
  const links = { "/opt/homebrew/bin/node": cellar, [cellar]: cellar, "/usr/bin/node": "/usr/bin/node" };
  const realpath = (file) => {
    if (!(file in links)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return links[file];
  };
  assert.equal(
    stableNodePath({ execPath: cellar, pathEnv: "/usr/bin:/opt/homebrew/bin", realpath }),
    "/opt/homebrew/bin/node",
  );
  assert.equal(
    stableNodePath({ execPath: cellar, pathEnv: "/usr/bin", realpath }),
    cellar,
    "without an equivalent on PATH the real path is kept",
  );
  assert.equal(
    stableNodePath({ execPath: "/usr/bin/node", pathEnv: "/usr/bin", realpath }),
    "/usr/bin/node",
  );
});
