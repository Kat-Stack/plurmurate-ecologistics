import type { TierDefinitionRow } from "./discord-tiers.server";

export interface TierDraftInput {
  id?: string;
  slug: string;
  label: string;
  rankOrder: number;
  roleIds: string[];
  voteWeight: number;
  canNominate: boolean;
  canVote: boolean;
  canApprove: boolean;
}

export function slugifyTierName(input: string): string {
  const cleaned = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `tier-${Date.now().toString(36)}`;
}

function makeTierId(communityId: string, slug: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${communityId}:${slug}:${suffix}`;
}

/**
 * Programmatically builds starter tiers for any community without hardcoding
 * a fixed count—pass `count` (e.g., 1, 4, 10) or custom tier specs.
 */
export function buildStarterTierDrafts(params?: {
  count?: number;
  presets?: Array<{
    slug: string;
    label: string;
    rankOrder: number;
    voteWeight: number;
    canNominate?: boolean;
    canVote?: boolean;
    canApprove?: boolean;
  }>;
}): TierDraftInput[] {
  if (params?.presets && params.presets.length > 0) {
    return params.presets.map((p) => ({
      slug: slugifyTierName(p.slug),
      label: p.label,
      rankOrder: p.rankOrder,
      roleIds: [],
      voteWeight: p.voteWeight,
      canNominate: p.canNominate ?? true,
      canVote: p.canVote ?? true,
      canApprove: p.canApprove ?? false,
    }));
  }

  const count = Math.max(1, Math.min(50, Math.floor(params?.count ?? 1)));
  if (count === 1) {
    return [
      {
        slug: "members",
        label: "Members",
        rankOrder: 100,
        roleIds: [],
        voteWeight: 1,
        canNominate: true,
        canVote: true,
        canApprove: true,
      },
    ];
  }

  // Generate N evenly stepped tiers from highest rank/weight down to lowest
  return Array.from({ length: count }, (_, idx) => {
    const rankOrder = (count - idx) * 10;
    const voteWeight = Number((count - idx).toFixed(2));
    return {
      slug: `tier-${idx + 1}`,
      label: `Tier ${idx + 1}`,
      rankOrder,
      roleIds: [],
      voteWeight,
      canNominate: idx < count - 1,
      canVote: true,
      canApprove: idx === 0,
    };
  });
}

export async function seedTiersIfEmpty(
  db: D1Database,
  communityId: string,
  starterDrafts: TierDraftInput[] = buildStarterTierDrafts({ count: 1 })
): Promise<TierDefinitionRow[]> {
  const existing = await db
    .prepare(
      `SELECT id, community_id, slug, label, rank_order, discord_role_ids_json,
              vote_weight, can_nominate, can_vote, can_approve
       FROM discord_tier_definitions
       WHERE community_id = ?1
       ORDER BY rank_order DESC`
    )
    .bind(communityId)
    .all<TierDefinitionRow>();

  if ((existing.results?.length ?? 0) > 0) {
    return existing.results!;
  }

  for (const draft of starterDrafts) {
    await addTierDefinition(db, communityId, draft);
  }

  const after = await db
    .prepare(
      `SELECT id, community_id, slug, label, rank_order, discord_role_ids_json,
              vote_weight, can_nominate, can_vote, can_approve
       FROM discord_tier_definitions
       WHERE community_id = ?1
       ORDER BY rank_order DESC`
    )
    .bind(communityId)
    .all<TierDefinitionRow>();

  return after.results ?? [];
}

export async function addTierDefinition(
  db: D1Database,
  communityId: string,
  draft: TierDraftInput
): Promise<string> {
  const slug = slugifyTierName(draft.slug || draft.label);
  const id = draft.id || makeTierId(communityId, slug);

  await db
    .prepare(
      `INSERT INTO discord_tier_definitions (
         id, community_id, slug, label, rank_order, discord_role_ids_json,
         vote_weight, can_nominate, can_vote, can_approve
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    )
    .bind(
      id,
      communityId,
      slug,
      draft.label.trim() || slug,
      Number.isFinite(draft.rankOrder) ? draft.rankOrder : 0,
      JSON.stringify(Array.from(new Set(draft.roleIds.map(String).filter(Boolean)))),
      Number.isFinite(draft.voteWeight) ? draft.voteWeight : 1,
      draft.canNominate ? 1 : 0,
      draft.canVote ? 1 : 0,
      draft.canApprove ? 1 : 0
    )
    .run();

  return id;
}

export async function updateTierDefinition(
  db: D1Database,
  communityId: string,
  tierId: string,
  patch: Partial<TierDraftInput>
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (patch.label !== undefined) {
    fields.push(`label = ?${idx++}`);
    values.push(patch.label.trim());
  }
  if (patch.slug !== undefined) {
    fields.push(`slug = ?${idx++}`);
    values.push(slugifyTierName(patch.slug));
  }
  if (patch.rankOrder !== undefined && Number.isFinite(patch.rankOrder)) {
    fields.push(`rank_order = ?${idx++}`);
    values.push(patch.rankOrder);
  }
  if (patch.roleIds !== undefined) {
    fields.push(`discord_role_ids_json = ?${idx++}`);
    values.push(JSON.stringify(Array.from(new Set(patch.roleIds.map(String).filter(Boolean)))));
  }
  if (patch.voteWeight !== undefined && Number.isFinite(patch.voteWeight)) {
    fields.push(`vote_weight = ?${idx++}`);
    values.push(patch.voteWeight);
  }
  if (patch.canNominate !== undefined) {
    fields.push(`can_nominate = ?${idx++}`);
    values.push(patch.canNominate ? 1 : 0);
  }
  if (patch.canVote !== undefined) {
    fields.push(`can_vote = ?${idx++}`);
    values.push(patch.canVote ? 1 : 0);
  }
  if (patch.canApprove !== undefined) {
    fields.push(`can_approve = ?${idx++}`);
    values.push(patch.canApprove ? 1 : 0);
  }

  if (fields.length === 0) return;

  values.push(tierId, communityId);
  await db
    .prepare(
      `UPDATE discord_tier_definitions
       SET ${fields.join(", ")}
       WHERE id = ?${idx++} AND community_id = ?${idx++}`
    )
    .bind(...values)
    .run();
}

export async function deleteTierDefinition(
  db: D1Database,
  communityId: string,
  tierId: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE community_discord_configs
       SET fallback_tier_id = NULL
       WHERE id = ?1 AND fallback_tier_id = ?2`
    )
    .bind(communityId, tierId)
    .run();

  await db
    .prepare(
      `DELETE FROM discord_tier_definitions
       WHERE id = ?1 AND community_id = ?2`
    )
    .bind(tierId, communityId)
    .run();
}
