import { createClient } from "@supabase/supabase-js";
import { isSupabaseAppPersistenceConfigured } from "./env";
import { normalizeLocale } from "./i18n";
import type { AppUser } from "./types";

export function isSupabaseConfigured() {
  return isSupabaseAppPersistenceConfigured();
}

export async function userFromRequest(request: Request): Promise<AppUser | undefined> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  if (!token || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    return undefined;
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false } },
  );
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return undefined;

  return {
    id: data.user.id,
    name:
      typeof data.user.user_metadata.display_name === "string"
        ? data.user.user_metadata.display_name
        : data.user.email?.split("@")[0] ?? "User",
    email: data.user.email,
    locale: normalizeLocale(data.user.user_metadata.locale),
    createdAt: data.user.created_at,
  };
}
