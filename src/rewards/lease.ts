import { timingSafeEqual } from "node:crypto";

export interface RewardLease {
  status: string;
  claimed_by_principal_id: string | null;
  lease_expires_at: Date | null;
  lease_token: string | null;
}

export function matchesRewardLeaseToken(stored: string | null, provided: string): boolean {
  if (typeof stored !== "string" || typeof provided !== "string" || !stored || !provided) return false;
  const expected = Buffer.from(stored);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isActiveRewardLease(lease: RewardLease, actorId: string, token: string, now = Date.now()): boolean {
  return lease.status === "processing"
    && lease.claimed_by_principal_id === actorId
    && matchesRewardLeaseToken(lease.lease_token, token)
    && lease.lease_expires_at instanceof Date
    && lease.lease_expires_at.getTime() > now;
}
