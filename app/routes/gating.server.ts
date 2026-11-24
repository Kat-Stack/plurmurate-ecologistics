import { syncMemberTierInDb } from "./discord-tiers.server";

export interface ActorPermissions {
  xUserId: string;
  communityId: string;
  discordLinked: boolean;
  discordUserId: string | null;
  discordUsername: string | null;
  tierSlug: string;
  voteWeight: number;
  canNominate: boolean;
  canVote: boolean;
  canApprove: boolean;
  rolesSyncedAt: string | null;
}

interface MemberTierRow {
  x_user_id: string;
  discord_user_id: string;
  discord_username: string | null;
  resolved_tier_slug: string;
  vote_weight: number;
  can_nominate: number;
  can_vote: number;
  can_approve: number;
  roles_synced_at: string;
}

export async function getActiveCommunityId(
  db: D1Database,
  hostXUserId?: string
): Promise<string | null> {
  if (hostXUserId) {
    const byHost = await db
      .prepare(
        `SELECT id FROM community_discord_configs WHERE host_x_user_id = ?1 LIMIT 1`
      )
      .bind(hostXUserId)
      .first<{ id: string }>();
    if (byHost?.id) return byHost.id;
  }

  const firstConfig = await db
    .prepare(`SELECT id FROM community_discord_configs ORDER BY updated_at DESC LIMIT 1`)
    .first<{ id: string }>();
  return firstConfig?.id ?? null;
}

export async function resolveActorPermissions(
  db: D1Database,
  params: {
    communityId: string;
    xUserId: string;
    botToken?: string;
    maxCacheAgeMs?: number;
    legacyFollowerCount?: number;
    isManualAllowlisted?: boolean;
  }
): Promise<ActorPermissions> {
  const maxAge = params.maxCacheAgeMs ?? 10 * 60 * 1000; // 10 minutes default TTL

  const config = await db
    .prepare(
      `SELECT id, disable_follower_gate FROM community_discord_configs WHERE id = ?1 LIMIT 1`
    )
    .bind(params.communityId)
    .first<{ id: string; disable_follower_gate: number }>();

  const followerGateDisabled = Boolean(config?.disable_follower_gate ?? 1);

  let row = await db
    .prepare(
      `SELECT x_user_id, discord_user_id, discord_username, resolved_tier_slug,
              vote_weight, can_nominate, can_vote, can_approve, roles_synced_at
       FROM community_member_tiers
       WHERE community_id = ?1 AND x_user_id = ?2
       LIMIT 1`
    )
    .bind(params.communityId, params.xUserId)
    .first<MemberTierRow>();

  if (row && params.botToken) {
    const syncedTime = Date.parse(row.roles_synced_at);
    const isStale = Number.isNaN(syncedTime) || Date.now() - syncedTime > maxAge;
    if (isStale) {
      try {
        await syncMemberTierInDb(db, {
          communityId: params.communityId,
          xUserId: params.xUserId,
          discordUserId: row.discord_user_id,
          discordUsername: row.discord_username,
          botToken: params.botToken,
        });
        row = await db
          .prepare(
            `SELECT x_user_id, discord_user_id, discord_username, resolved_tier_slug,
                    vote_weight, can_nominate, can_vote, can_approve, roles_synced_at
             FROM community_member_tiers
             WHERE community_id = ?1 AND x_user_id = ?2
             LIMIT 1`
          )
          .bind(params.communityId, params.xUserId)
          .first<MemberTierRow>();
      } catch {
        // Fall back to cached row if Discord API transiently fails
      }
    }
  }

  if (row) {
    return {
      xUserId: params.xUserId,
      communityId: params.communityId,
      discordLinked: true,
      discordUserId: row.discord_user_id,
      discordUsername: row.discord_username,
      tierSlug: row.resolved_tier_slug,
      voteWeight: Number(row.vote_weight ?? 0),
      canNominate: Boolean(row.can_nominate),
      canVote: Boolean(row.can_vote),
      canApprove: Boolean(row.can_approve),
      rolesSyncedAt: row.roles_synced_at,
    };
  }

  // Unlinked user fallback: if follower gate is still active on this workspace, allow legacy check
  if (!followerGateDisabled && params.isManualAllowlisted) {
    return {
      xUserId: params.xUserId,
      communityId: params.communityId,
      discordLinked: false,
      discordUserId: null,
      discordUsername: null,
      tierSlug: "legacy_allowlist",
      voteWeight: 1,
      canNominate: true,
      canVote: true,
      canApprove: false,
      rolesSyncedAt: null,
    };
  }

  return {
    xUserId: params.xUserId,
    communityId: params.communityId,
    discordLinked: false,
    discordUserId: null,
    discordUsername: null,
    tierSlug: "outsiders",
    voteWeight: 0,
    canNominate: false,
    canVote: false,
    canApprove: false,
    rolesSyncedAt: null,
  };
}

export function tallyWeightedVotes(
  votes: Array<{ choice: "A" | "B" | "U" | string; voteWeight: number }>
) {
  const totals = { A: 0, B: 0, U: 0 };
  for (const v of votes) {
    const weight = Number.isFinite(v.voteWeight) ? v.voteWeight : 0;
    if (v.choice === "A") totals.A += weight;
    else if (v.choice === "B") totals.B += weight;
    else if (v.choice === "U") totals.U += weight;
  }
  return totals;
}
