import { test, after } from "node:test";
import assert from "node:assert/strict";
import { stampPeerIp } from "../../../scripts/dev/peer-stamp.mjs";
import { getLoginLockoutKey } from "../../../src/server/auth/loginPeer";
import {
  recordLoginFailure,
  checkLoginGuard,
  resetLoginGuardForTests,
} from "../../../src/server/auth/loginGuard";
const old = process.env.OMNIROUTE_TRUSTED_PROXIES;
const token = process.env.OMNIROUTE_PEER_STAMP_TOKEN;
after(() => {
  if (old === undefined) delete process.env.OMNIROUTE_TRUSTED_PROXIES;
  else process.env.OMNIROUTE_TRUSTED_PROXIES = old;
  if (token === undefined) delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
  else process.env.OMNIROUTE_PEER_STAMP_TOKEN = token;
});
function stamp(peer: string, forwarded?: string) {
  const req = {
    socket: { remoteAddress: peer },
    headers: { "x-forwarded-for": forwarded, "x-omniroute-login-client-ip": "forged|1.2.3.4" },
  };
  stampPeerIp(req);
  return req.headers["x-omniroute-login-client-ip"]?.split("|")[1];
}
test("explicit proxy separates login budgets", () => {
  process.env.OMNIROUTE_TRUSTED_PROXIES = "127.0.0.1";
  resetLoginGuardForTests();
  const keys = ["198.51.100.1", "198.51.100.2"].map((ip) =>
    getLoginLockoutKey(
      new Request("http://localhost", {
        headers: {
          "x-omniroute-trusted-peer-ip": "127.0.0.1",
          "x-omniroute-trusted-login-client-ip": stamp("127.0.0.1", ip)!,
        },
      }),
      null
    )
  );
  for (let i = 0; i < 5; i++) recordLoginFailure(keys[0], { enabled: true });
  assert.equal(checkLoginGuard(keys[1], { enabled: true }).allowed, true);
});
test("unconfigured private peer cannot spoof", () => {
  process.env.OMNIROUTE_TRUSTED_PROXIES = "";
  assert.equal(stamp("10.1.2.3", "198.51.100.1"), "10.1.2.3");
});
test("malformed chain falls back; rightmost untrusted wins", () => {
  process.env.OMNIROUTE_TRUSTED_PROXIES = "127.0.0.1,192.0.2.10";
  assert.equal(stamp("127.0.0.1", "198.51.100.1, bad"), "invalid");
  assert.equal(stamp("127.0.0.1", "1.2.3.4,198.51.100.1,192.0.2.10"), "198.51.100.1");
  assert.equal(stamp("127.0.0.1"), "127.0.0.1");
});
test("IPv6 and mapped addresses canonicalize", () => {
  process.env.OMNIROUTE_TRUSTED_PROXIES = "127.0.0.1";
  assert.equal(stamp("127.0.0.1", "2001:0DB8:0:0:0:0:0:1"), "2001:db8::1");
  assert.equal(stamp("127.0.0.1", "::ffff:c633:6401"), "198.51.100.1");
});

test("malformed configured CIDRs do not grant login trust", () => {
  for (const config of ["127.0.0.1/32/0", "127.0.0.1/", "127.0.0.1/+32", "127.0.0.1/3e1"]) {
    process.env.OMNIROUTE_TRUSTED_PROXIES = config;
    assert.equal(stamp("127.0.0.1", "198.51.100.1"), "127.0.0.1", config);
  }
});
test("CIDR boundaries constrain login trust", () => {
  process.env.OMNIROUTE_TRUSTED_PROXIES = "192.0.2.0/24,2001:db8::/32";
  assert.equal(stamp("192.0.2.255", "198.51.100.1"), "198.51.100.1");
  assert.equal(stamp("192.0.3.0", "198.51.100.1"), "192.0.3.0");
  assert.equal(stamp("2001:db8::ffff", "198.51.100.1"), "198.51.100.1");
  assert.equal(stamp("2001:db9::1", "198.51.100.1"), "2001:db9::1");
});

test("non-mapped IPv6 never aliases a trusted IPv4 proxy", () => {
  process.env.OMNIROUTE_TRUSTED_PROXIES = "127.0.0.1/32";
  assert.equal(stamp("::ffff:7f00:1:abcd", "198.51.100.1"), "::ffff:7f00:1:abcd");
});
test("attacker-controlled XFF prefixes cannot change a resolved client bucket", () => {
  process.env.OMNIROUTE_TRUSTED_PROXIES = "127.0.0.1/32";
  for (const prefix of ["bad,".repeat(100), "x".repeat(9000)]) {
    assert.equal(stamp("127.0.0.1", prefix + ",198.51.100.1"), "198.51.100.1");
  }
});

test("unresolved trusted suffix is rejected rather than given a proxy budget", () => {
  process.env.OMNIROUTE_TRUSTED_PROXIES = "127.0.0.1/32,192.0.2.10/32";
  assert.equal(stamp("127.0.0.1", "bad"), "invalid");
  assert.equal(stamp("127.0.0.1", Array(65).fill("192.0.2.10").join(",")), "invalid");
  assert.equal(stamp("127.0.0.1", "bad,,198.51.100.1,192.0.2.10"), "198.51.100.1");
});
