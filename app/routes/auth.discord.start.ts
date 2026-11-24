import { redirect, type LoaderFunctionArgs } from "react-router";

function randomStateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env as {
    DISCORD_CLIENT_ID?: string;
    DB: D1Database;
  };

  // TODO: Replace with your app's actual signed-in X user session lookup
  const url = new URL(request.url);
  const xUserId = url.searchParams.get("xUserId")?.trim() || "";
  if (!xUserId) {
    return redirect("/login?error=missing_x_session");
  }

  if (!env.DISCORD_CLIENT_ID) {
    return new Response("DISCORD_CLIENT_ID is not configured on Worker.", { status: 500 });
  }

  const state = randomStateToken();
  const redirectUri = `${url.origin}/auth/discord/callback`;

  const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
  authorizeUrl.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "identify");
  authorizeUrl.searchParams.set("state", state);

  const cookiePayload = encodeURIComponent(JSON.stringify({ state, xUserId }));
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `plur_discord_oauth=${cookiePayload}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  headers.set("Location", authorizeUrl.toString());

  return new Response(null, { status: 302, headers });
}
