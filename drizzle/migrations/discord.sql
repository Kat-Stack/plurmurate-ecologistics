-- 1. Community / workspace settings (one per host X account / community)
CREATE TABLE IF NOT EXISTS community_discord_configs (
  id TEXT PRIMARY KEY,
  host_x_user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  notification_channel_id TEXT,
  fallback_tier_id TEXT,
  disable_follower_gate INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- 2. Ordered tiers per community (re-contextable to any server's hierarchy)
CREATE TABLE IF NOT EXISTS discord_tier_definitions (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES community_discord_configs(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,                -- e.g. 'vera', 'veralla', 'public', 'outsiders'
  label TEXT NOT NULL,               -- e.g. 'Vera (Inner Circle)', 'Veralla (Little Sisters)'
  rank_order INTEGER NOT NULL,       -- Higher number = higher precedence when user has multiple roles
  discord_role_ids_json TEXT NOT NULL DEFAULT '[]', -- JSON array of Discord Role IDs in this guild
  vote_weight REAL NOT NULL DEFAULT 1.0,
  can_nominate INTEGER NOT NULL DEFAULT 1,
  can_vote INTEGER NOT NULL DEFAULT 1,
  can_approve INTEGER NOT NULL DEFAULT 0
);

-- 3. Cached link between X user, Discord user, and resolved tier for a community
CREATE TABLE IF NOT EXISTS community_member_tiers (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES community_discord_configs(id) ON DELETE CASCADE,
  x_user_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  discord_username TEXT,
  resolved_tier_id TEXT,
  resolved_tier_slug TEXT NOT NULL,
  vote_weight REAL NOT NULL DEFAULT 0.0,
  can_nominate INTEGER NOT NULL DEFAULT 0,
  can_vote INTEGER NOT NULL DEFAULT 0,
  can_approve INTEGER NOT NULL DEFAULT 0,
  roles_synced_at TEXT NOT NULL,
  UNIQUE(community_id, x_user_id)
);
