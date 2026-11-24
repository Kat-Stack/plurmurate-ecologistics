export interface DiscordRoleSummary {
  id: string;
  name: string;
  position: number;
}

export interface TierDefinitionRow {
  id: string;
  community_id: string;
  slug: string;
  label: string;
  rank_order: number;
  discord_role_ids_json: string;
  vote_weight: number;
  can_nominate: number;
  can_vote: number;
  can_approve: number;
}

export interface ResolvedTierResult {
  tierId: string | null;
  tierSlug: string;
  voteWeight: number;
  canNominate: boolean;
  canVote: boolean;
  canApprove: boolean;
  inGuild: boolean;
}

const DISCORD_API = "https://discord.com/api/v10";

export async function fetchGuildRoles(
  guildId: string,
  botToken: string
): Promise<DiscordRoleSummary[]> {
  const res = await fetch(`${DISCORD_API}/guilds/${encodeURIComponent(guildId)}/roles`, {
    headers: {
      Authorization: `Bot ${botToken}`,
      "User-Agent": "PlurmurateBot/1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord guild roles lookup failed (${res.status}): ${body}`);
  }

  const roles = (await res.json()) as Array<{
    id: string;
    name: string;
    position: number;
  }>;

  return roles
    .filter((r) => r.name !== "@everyone")
    .sort((a, b) => b.position - a.position);
}

export async function fetchGuildMemberRoleIds(
  guildId: string,
  discordUserId: string,
  botToken: string
): Promise<{ inGuild: boolean; roleIds: string[] }> {
  const res = await fetch(
    `${DISCORD_API}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(discordUserId)}`,
    {
      headers: {
        Authorization: `Bot ${botToken}`,
        "User-Agent": "PlurmurateBot/1.0",
      },
    }
  );

  if (res.status === 404) {
    return { inGuild: false, roleIds: [] };
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord member lookup failed (${res.status}): ${body}`);
  }

  const member = (await res.json()) as { roles?: string[] };
  return {
    inGuild: true,
    roleIds: Array.isArray(member.roles) ? member.roles : [],
  };
}

function parseRoleIds(jsonStr: string): string[] {
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function resolveTierFromRoles(
  tiers: TierDefinitionRow[],
  memberRoleIds: string[],
  inGuild: boolean,
  fallbackTierId?: string | null
): ResolvedTierResult {
  const sorted = [...tiers].sort((a, b) => b.rank_order - a.rank_order);
  const roleSet = new Set(memberRoleIds);

  if (inGuild) {
    for (const tier of sorted) {
      const assignedRoleIds = parseRoleIds(tier.discord_role_ids_json);
      if (assignedRoleIds.some((roleId) => roleSet.has(roleId))) {
        return {
          tierId: tier.id,
          tierSlug: tier.slug,
          voteWeight: Number(tier.vote_weight ?? 0),
          canNominate: Boolean(tier.can_nominate),
          canVote: Boolean(tier.can_vote),
          canApprove: Boolean(tier.can_approve),
          inGuild: true,
        };
      }
    }
  }

  const fallbackTier =
    (fallbackTierId ? sorted.find((t) => t.id === fallbackTierId) : undefined) ??
    sorted[sorted.length - 1];

  if (!fallbackTier) {
    return {
      tierId: null,
      tierSlug: inGuild ? "public" : "outsiders",
      voteWeight: inGuild ? 1 : 0,
      canNominate: inGuild,
      canVote: inGuild,
      canApprove: false,
      inGuild,
    };
  }

  // If not in guild, prevent granting elevated permissions even if fallback is higher
  const effectiveCanNominate = inGuild ? Boolean(fallbackTier.can_nominate) : false;
  const effectiveCanVote = inGuild ? Boolean(fallbackTier.can_vote) : false;
  const effectiveCanApprove = inGuild ? Boolean(fallbackTier.can_approve) : false;
  const effectiveWeight = inGuild ? Number(fallbackTier.vote_weight ?? 0) : 0;

  return {
    tierId: fallbackTier.id,
    tierSlug: fallbackTier.slug,
    voteWeight: effectiveWeight,
    canNominate: effectiveCanNominate,
    canVote: effectiveCanVote,
    canApprove: effectiveCanApprove,
    inGuild,
  };
}

export async function syncMemberTierInDb(
  db: D1Database,
  params: {
    communityId: string;
    xUserId: string;
    discordUserId: string;
    discordUsername?: string | null;
    botToken: string;
  }
) {
  const config = await db
    .prepare(
      `SELECT id, guild_id, fallback_tier_id
       FROM community_discord_configs
       WHERE id = ?1 LIMIT 1`
    )
    .bind(params.communityId)
    .first<{ id: string; guild_id: string; fallback_tier_id: string | null }>();

  if (!config) {
    throw new Error(`Community Discord config not found for id: ${params.communityId}`);
  }

  const tiersRes = await db
    .prepare(
      `SELECT id, community_id, slug, label, rank_order, discord_role_ids_json,
              vote_weight, can_nominate, can_vote, can_approve
       FROM discord_tier_definitions
       WHERE community_id = ?1
       ORDER BY rank_order DESC`
    )
    .bind(params.communityId)
    .all<TierDefinitionRow>();

  const tiers = tiersRes.results ?? [];
  const { inGuild, roleIds } = await fetchGuildMemberRoleIds(
    config.guild_id,
    params.discordUserId,
    params.botToken
  );

  const resolved = resolveTierFromRoles(
    tiers,
    roleIds,
    inGuild,
    config.fallback_tier_id
  );

  const nowIso = new Date().toISOString();
  const rowId = `${params.communityId}:${params.xUserId}`;

  await db
    .prepare(
      `INSERT INTO community_member_tiers (
         id, community_id, x_user_id, discord_user_id, discord_username,
         resolved_tier_id, resolved_tier_slug, vote_weight,
         can_nominate, can_vote, can_approve, roles_synced_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(community_id, x_user_id) DO UPDATE SET
         discord_user_id = excluded.discord_user_id,
         discord_username = COALESCE(excluded.discord_username, community_member_tiers.discord_username),
         resolved_tier_id = excluded.resolved_tier_id,
         resolved_tier_slug = excluded.resolved_tier_slug,
         vote_weight = excluded.vote_weight,
         can_nominate = excluded.can_nominate,
         can_vote = excluded.can_vote,
         can_approve = excluded.can_approve,
         roles_synced_at = excluded.roles_synced_at`
    )
    .bind(
      rowId,
      params.communityId,
      params.xUserId,
      params.discordUserId,
      params.discordUsername ?? null,
      resolved.tierId,
      resolved.tierSlug,
      resolved.voteWeight,
      resolved.canNominate ? 1 : 0,
      resolved.canVote ? 1 : 0,
      resolved.canApprove ? 1 : 0,
      nowIso
    )
    .run();

  return {
    ...resolved,
    discordUserId: params.discordUserId,
    discordUsername: params.discordUsername ?? null,
    rolesSyncedAt: nowIso,
  };
}
