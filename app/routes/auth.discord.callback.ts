import { redirect, type LoaderFunctionArgs } from "react-router";
import { syncMemberTierInDb } from "../lib/discord-tiers.server";
import { getActiveCommunityId } from "../lib/gating.server";

function parseOAuthCookie(cookieHeader: string | null): {
  state?: string;
  xUserId?: string;
} {
  if (!cookieHeader) return {};
  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("plur_discord_oauth="));
  if (!match) return {};
  try {
    return JSON.parse(decodeURIComponent(match.slice("plur_discord_oauth=".length)));
  } catch {
    return {};
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env as {
    DB: D1Database;
    DISCORD_BOT_TOKEN?: string;
    DISCORD_CLIENT_ID?: string;
    DISCORD_CLIENT_SECRET?: string;
  };

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const stored = parseOAuthCookie(request.headers.get("Cookie"));

  if (
    !code ||
    !returnedState ||
    !stored.state ||
    returnedState !== stored.state ||
    !stored.xUserId
  ) {
    return redirect("/settings?discord_error=invalid_oauth_state");
  }

  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.DISCORD_BOT_TOKEN) {
    return redirect("/settings?discord_error=missing_discord_env");
  }

  const redirectUri = `${url.origin}/auth/discord/callback`;
  const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "PlurmurateBot/1.0",
    },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    return redirect("/settings?discord_error=token_exchange_failed");
  }

  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    return redirect("/settings?discord_error=missing_access_token");
  }

  const userRes = await fetch("https://discord.com/api/v10/users/@me", {
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      "User-Agent": "PlurmurateBot/1.0",
    },
  });

  if (!userRes.ok) {
    return redirect("/settings?discord_error=discord_user_fetch_failed");
  }

  const discordUser = (await userRes.json()) as {
    id: string;
    username?: string;
    global_name?: string | null;
  };

  const communityId = await getActiveCommunityId(env.DB);
  if (communityId) {
    await syncMemberTierInDb(env.DB, {
      communityId,
      xUserId: stored.xUserId,
      discordUserId: discordUser.id,
      discordUsername: discordUser.global_name || discordUser.username || null,
      botToken: env.DISCORD_BOT_TOKEN,
    });
  }

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    "plur_discord_oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );
  headers.set("Location", "/settings?discord_linked=1");
  return new Response(null, { status: 302, headers });
}
