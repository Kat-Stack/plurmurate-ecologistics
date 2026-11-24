import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import {
  fetchGuildRoles,
  syncMemberTierInDb,
  type DiscordRoleSummary,
  type TierDefinitionRow,
} from "../lib/discord-tiers.server";
import { getActiveCommunityId } from "../lib/gating.server";
import {
  addTierDefinition,
  buildStarterTierDrafts,
  deleteTierDefinition,
  seedTiersIfEmpty,
  updateTierDefinition,
} from "../lib/tier-builder.server";

interface CommunityConfigRow {
  id: string;
  host_x_user_id: string;
  guild_id: string;
  notification_channel_id: string | null;
  fallback_tier_id: string | null;
  disable_follower_gate: number;
}

interface WorkerEnv {
  DB: D1Database;
  DISCORD_BOT_TOKEN?: string;
}

function getEnv(context: LoaderFunctionArgs["context"]): WorkerEnv {
  const ctx = context as { cloudflare?: { env?: WorkerEnv }; env?: WorkerEnv };
  return (ctx.cloudflare?.env ?? ctx.env ?? {}) as WorkerEnv;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const url = new URL(request.url);
  const communityId =
    url.searchParams.get("communityId") || (await getActiveCommunityId(env.DB));

  if (!communityId) {
    return {
      community: null,
      tiers: [] as TierDefinitionRow[],
      guildRoles: [] as DiscordRoleSummary[],
      linkedMemberCount: 0,
      roleFetchError: "No community_discord_configs row found in D1.",
    };
  }

  const community = await env.DB
    .prepare(
      `SELECT id, host_x_user_id, guild_id, notification_channel_id,
              fallback_tier_id, disable_follower_gate
       FROM community_discord_configs
       WHERE id = ?1 LIMIT 1`
    )
    .bind(communityId)
    .first<CommunityConfigRow>();

  const tiersRes = await env.DB
    .prepare(
      `SELECT id, community_id, slug, label, rank_order, discord_role_ids_json,
              vote_weight, can_nominate, can_vote, can_approve
       FROM discord_tier_definitions
       WHERE community_id = ?1
       ORDER BY rank_order DESC`
    )
    .bind(communityId)
    .all<TierDefinitionRow>();

  const countRow = await env.DB
    .prepare(
      `SELECT COUNT(*) AS cnt FROM community_member_tiers WHERE community_id = ?1`
    )
    .bind(communityId)
    .first<{ cnt: number }>();

  let guildRoles: DiscordRoleSummary[] = [];
  let roleFetchError: string | null = null;

  if (community?.guild_id && env.DISCORD_BOT_TOKEN) {
    try {
      guildRoles = await fetchGuildRoles(community.guild_id, env.DISCORD_BOT_TOKEN);
    } catch (err) {
      roleFetchError =
        err instanceof Error ? err.message : "Failed to fetch roles from Discord.";
    }
  } else if (!env.DISCORD_BOT_TOKEN) {
    roleFetchError = "DISCORD_BOT_TOKEN is not set on the Worker.";
  }

  return {
    community,
    tiers: tiersRes.results ?? [],
    guildRoles,
    linkedMemberCount: Number(countRow?.cnt ?? 0),
    roleFetchError,
  };
}

async function saveAllTiersFromForm(
  db: D1Database,
  communityId: string,
  formData: FormData
) {
  const guildId = String(formData.get("guild_id") || "").trim();
  const notificationChannelId =
    String(formData.get("notification_channel_id") || "").trim() || null;
  const fallbackTierId =
    String(formData.get("fallback_tier_id") || "").trim() || null;
  const disableFollowerGate = formData.get("disable_follower_gate") === "on" ? 1 : 0;

  await db
    .prepare(
      `UPDATE community_discord_configs
       SET guild_id = ?1,
           notification_channel_id = ?2,
           fallback_tier_id = ?3,
           disable_follower_gate = ?4,
           updated_at = ?5
       WHERE id = ?6`
    )
    .bind(
      guildId,
      notificationChannelId,
      fallbackTierId,
      disableFollowerGate,
      new Date().toISOString(),
      communityId
    )
    .run();

  const tierIds = formData.getAll("tier_id").map(String);
  for (const tierId of tierIds) {
    const label = String(formData.get(`label_${tierId}`) || "").trim();
    const slug = String(formData.get(`slug_${tierId}`) || "").trim();
    const rankOrder = Number(formData.get(`rank_order_${tierId}`) ?? 0);
    const voteWeight = Number(formData.get(`vote_weight_${tierId}`) ?? 0);
    const canNominate = formData.get(`can_nominate_${tierId}`) === "on";
    const canVote = formData.get(`can_vote_${tierId}`) === "on";
    const canApprove = formData.get(`can_approve_${tierId}`) === "on";

    const checkedRoles = formData.getAll(`roles_${tierId}`).map(String);
    const rawRoleIds = String(formData.get(`role_ids_raw_${tierId}`) || "");
    const extraRoles = rawRoleIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    await updateTierDefinition(db, communityId, tierId, {
      label: label || tierId,
      slug: slug || label || tierId,
      rankOrder,
      roleIds: [...checkedRoles, ...extraRoles],
      voteWeight,
      canNominate,
      canVote,
      canApprove,
    });
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "save");
  const communityId = String(formData.get("communityId") || "").trim();

  if (!communityId) {
    return { ok: false, message: "Missing communityId." };
  }

  if (intent === "add_tier") {
    const newLabel = String(formData.get("new_tier_label") || "").trim();
    const newSlug = String(formData.get("new_tier_slug") || newLabel).trim();
    const newRankOrder = Number(formData.get("new_tier_rank") ?? 10);
    const newWeight = Number(formData.get("new_tier_weight") ?? 1);

    if (!newLabel) {
      return { ok: false, message: "Enter a tier name before adding." };
    }

    await addTierDefinition(env.DB, communityId, {
      label: newLabel,
      slug: newSlug,
      rankOrder,
      roleIds: [],
      voteWeight: newWeight,
      canNominate: formData.get("new_tier_nominate") === "on",
      canVote: formData.get("new_tier_vote") === "on",
      canApprove: formData.get("new_tier_approve") === "on",
    });

    return { ok: true, message: `Added tier "${newLabel}".` };
  }

  if (intent === "delete_tier") {
    const deleteTierId = String(formData.get("delete_tier_id") || "").trim();
    if (deleteTierId) {
      await deleteTierDefinition(env.DB, communityId, deleteTierId);
    }
    return { ok: true, message: "Removed tier." };
  }

  if (intent === "generate_n_tiers") {
    const requestedCount = Number(formData.get("starter_tier_count") ?? 1);
    const drafts = buildStarterTierDrafts({ count: requestedCount });
    await seedTiersIfEmpty(env.DB, communityId, drafts);
    return {
      ok: true,
      message: `Initialized ${drafts.length} starter tier(s) for this community.`,
    };
  }

  await saveAllTiersFromForm(env.DB, communityId, formData);

  if (intent === "sync_members" && env.DISCORD_BOT_TOKEN) {
    const membersRes = await env.DB
      .prepare(
        `SELECT x_user_id, discord_user_id, discord_username
         FROM community_member_tiers
         WHERE community_id = ?1`
      )
      .bind(communityId)
      .all<{
        x_user_id: string;
        discord_user_id: string;
        discord_username: string | null;
      }>();

    let syncedCount = 0;
    for (const m of membersRes.results ?? []) {
      await syncMemberTierInDb(env.DB, {
        communityId,
        xUserId: m.x_user_id,
        discordUserId: m.discord_user_id,
        discordUsername: m.discord_username,
        botToken: env.DISCORD_BOT_TOKEN,
      });
      syncedCount += 1;
    }

    return {
      ok: true,
      message: `Saved ${formData.getAll("tier_id").length} tier(s) and re-synced ${syncedCount} member(s).`,
    };
  }

  return { ok: true, message: "Saved tier configuration." };
}

export default function SettingsTiersPage() {
  const { community, tiers, guildRoles, linkedMemberCount, roleFetchError } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  if (!community) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-bold">Discord Tiers &amp; Vote Weights</h1>
        <p className="mt-2 text-sm text-neutral-600">
          {roleFetchError || "No workspace configuration found."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Discord Tiers &amp; Vote Weights</h1>
        <p className="text-sm text-neutral-600">
          Any number of tiers (1, 4, 10+) per server. Higher rank order wins when a member holds multiple roles.
        </p>
      </div>

      {actionData?.message && (
        <div
          className={`rounded border p-3 text-sm ${
            actionData.ok
              ? "border-emerald-300 bg-emerald-50 text-emerald-900"
              : "border-red-300 bg-red-50 text-red-900"
          }`}
        >
          {actionData.message}
        </div>
      )}

      {roleFetchError && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Role sync note: {roleFetchError}
        </div>
      )}

      {tiers.length === 0 && (
        <Form method="post" className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
          <input type="hidden" name="communityId" value={community.id} />
          <label className="block text-sm font-medium">
            Number of starter tiers to generate
            <input
              type="number"
              name="starter_tier_count"
              min={1}
              max={50}
              defaultValue={1}
              className="mt-1 w-28 rounded border px-3 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            name="intent"
            value="generate_n_tiers"
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white"
          >
            Generate Starter Tiers
          </button>
        </Form>
      )}

      <Form method="post" className="space-y-6">
        <input type="hidden" name="communityId" value={community.id} />

        <section className="space-y-4 rounded-lg border p-4">
          <h2 className="text-lg font-semibold">Server &amp; Gate Configuration</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              Discord Guild (Server) ID
              <input
                type="text"
                name="guild_id"
                defaultValue={community.guild_id}
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
                required
              />
            </label>

            <label className="block text-sm font-medium">
              Notification Channel ID (Optional)
              <input
                type="text"
                name="notification_channel_id"
                defaultValue={community.notification_channel_id ?? ""}
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              Fallback Tier (No Matched Role / Unlinked)
              <select
                name="fallback_tier_id"
                defaultValue={community.fallback_tier_id ?? ""}
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
              >
                <option value="">Lowest Precedence Tier</option>
                {tiers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} ({t.slug})
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  name="disable_follower_gate"
                  defaultChecked={Boolean(community.disable_follower_gate)}
                />
                Use Discord roles instead of follower counts / whitelist
              </label>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-lg font-semibold">
            Active Tiers ({tiers.length})
          </h2>

          {tiers.map((tier) => {
            let selectedRoleIds: string[] = [];
            try {
              const parsed = JSON.parse(tier.discord_role_ids_json);
              if (Array.isArray(parsed)) selectedRoleIds = parsed.map(String);
            } catch {
              selectedRoleIds = [];
            }

            const unknownRoleIds = selectedRoleIds.filter(
              (id) => !guildRoles.some((gr) => gr.id === id)
            );

            return (
              <div key={tier.id} className="space-y-3 rounded-lg border p-4">
                <input type="hidden" name="tier_id" value={tier.id} />

                <div className="grid gap-3 sm:grid-cols-4">
                  <label className="block text-sm font-medium">
                    Tier Label
                    <input
                      type="text"
                      name={`label_${tier.id}`}
                      defaultValue={tier.label}
                      className="mt-1 w-full rounded border px-3 py-1.5 text-sm"
                    />
                  </label>

                  <label className="block text-sm font-medium">
                    Slug
                    <input
                      type="text"
                      name={`slug_${tier.id}`}
                      defaultValue={tier.slug}
                      className="mt-1 w-full rounded border px-3 py-1.5 text-sm"
                    />
                  </label>

                  <label className="block text-sm font-medium">
                    Precedence Rank
                    <input
                      type="number"
                      name={`rank_order_${tier.id}`}
                      defaultValue={tier.rank_order}
                      className="mt-1 w-full rounded border px-3 py-1.5 text-sm"
                    />
                  </label>

                  <label className="block text-sm font-medium">
                    Vote Weight
                    <input
                      type="number"
                      step="0.25"
                      name={`vote_weight_${tier.id}`}
                      defaultValue={tier.vote_weight}
                      className="mt-1 w-full rounded border px-3 py-1.5 text-sm"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 pt-1 text-sm">
                  <div className="flex flex-wrap gap-6">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name={`can_nominate_${tier.id}`}
                        defaultChecked={Boolean(tier.can_nominate)}
                      />
                      Can Nominate
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name={`can_vote_${tier.id}`}
                        defaultChecked={Boolean(tier.can_vote)}
                      />
                      Can Vote
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name={`can_approve_${tier.id}`}
                        defaultChecked={Boolean(tier.can_approve)}
                      />
                      Can Approve / Publish
                    </label>
                  </div>

                  <button
                    type="submit"
                    name="intent"
                    value="delete_tier"
                    formNoValidate
                    onClick={(e) => {
                      const hidden = e.currentTarget.parentElement?.querySelector(
                        'input[name="delete_tier_id"]'
                      ) as HTMLInputElement | null;
                      if (hidden) hidden.value = tier.id;
                    }}
                    className="rounded border border-red-300 px-2.5 py-1 text-xs text-red-700"
                  >
                    Delete Tier
                  </button>
                  <input type="hidden" name="delete_tier_id" value="" />
                </div>

                {guildRoles.length > 0 && (
                  <div className="pt-1">
                    <span className="block text-xs font-medium text-neutral-600">
                      Matching Discord Roles in Guild
                    </span>
                    <div className="mt-2 flex flex-wrap gap-3">
                      {guildRoles.map((role) => (
                        <label
                          key={role.id}
                          className="flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs"
                        >
                          <input
                            type="checkbox"
                            name={`roles_${tier.id}`}
                            value={role.id}
                            defaultChecked={selectedRoleIds.includes(role.id)}
                          />
                          <span>@{role.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <label className="block pt-1 text-xs font-medium text-neutral-600">
                  Additional / Manual Discord Role IDs (comma-separated)
                  <input
                    type="text"
                    name={`role_ids_raw_${tier.id}`}
                    defaultValue={unknownRoleIds.join(", ")}
                    placeholder="e.g. 123456789012345678, 987654321098765432"
                    className="mt-1 w-full rounded border px-2.5 py-1.5 text-xs"
                  />
                </label>
              </div>
            );
          })}
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            name="intent"
            value="save"
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white"
          >
            Save All Tiers
          </button>

          <button
            type="submit"
            name="intent"
            value="sync_members"
            className="rounded border px-4 py-2 text-sm font-medium"
          >
            Save &amp; Re-Sync {linkedMemberCount} Linked Member(s)
          </button>
        </div>
      </Form>

      <Form method="post" className="space-y-3 rounded-lg border p-4">
        <input type="hidden" name="communityId" value={community.id} />
        <h2 className="text-base font-semibold">Add a New Tier</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <input
            type="text"
            name="new_tier_label"
            placeholder="Tier name (e.g. Council)"
            className="rounded border px-3 py-1.5 text-sm"
            required
          />
          <input
            type="text"
            name="new_tier_slug"
            placeholder="Slug (optional)"
            className="rounded border px-3 py-1.5 text-sm"
          />
          <input
            type="number"
            name="new_tier_rank"
            defaultValue={25}
            placeholder="Rank order"
            className="rounded border px-3 py-1.5 text-sm"
          />
          <input
            type="number"
            step="0.25"
            name="new_tier_weight"
            defaultValue={1}
            placeholder="Vote weight"
            className="rounded border px-3 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap gap-5 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="new_tier_nominate" defaultChecked />
              Can Nominate
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="new_tier_vote" defaultChecked />
              Can Vote
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="new_tier_approve" />
              Can Approve
            </label>
          </div>
          <button
            type="submit"
            name="intent"
            value="add_tier"
            className="rounded border bg-neutral-100 px-3.5 py-1.5 text-sm font-medium"
          >
            + Add Tier
          </button>
        </div>
      </Form>
    </div>
  );
}
