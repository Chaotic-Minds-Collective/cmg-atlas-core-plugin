import test from "node:test";
import assert from "node:assert/strict";
import { isActiveRewardLease, matchesRewardLeaseToken } from "../dist/rewards/lease.js";
const a = "ae2134a1-4bd4-4eb8-9ebc-456c38be9caa";
const b = "126b35fa-dd2f-436f-9f76-fecfe3a476e0";
const row = (extra = {}) => ({ status: "processing", claimed_by_principal_id: "worker", lease_expires_at: new Date(2000), lease_token: a, ...extra });
test("accepts the current owning service and rejects another service", () => {
  assert.equal(isActiveRewardLease(row(), "worker", a, 1000), true);
  assert.equal(isActiveRewardLease(row(), "other", a, 1000), false);
});
test("same-service reclaim fences the previous token", () => {
  assert.equal(isActiveRewardLease(row({ lease_token: b }), "worker", a, 1000), false);
  assert.equal(isActiveRewardLease(row({ lease_token: b }), "worker", b, 1000), true);
});
test("expired or non-processing claims cannot acknowledge", () => {
  assert.equal(isActiveRewardLease(row(), "worker", a, 2000), false);
  assert.equal(isActiveRewardLease(row({ status: "failed" }), "worker", a, 1000), false);
  assert.equal(isActiveRewardLease(row({ lease_expires_at: null }), "worker", a, 1000), false);
});
test("missing, malformed and different tokens fail closed", () => {
  for (const value of [null, "", "invalid", b]) assert.equal(matchesRewardLeaseToken(value, a), false);
  assert.equal(matchesRewardLeaseToken(a, a), true);
});
