import { createClient } from "@supabase/supabase-js";

let browserSupabase: ReturnType<typeof createClient> | undefined;
let browserSupabaseConfigKey: string | undefined;

export function getBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) return undefined;

  const configKey = `${url}:${key}`;
  if (!browserSupabase || browserSupabaseConfigKey !== configKey) {
    browserSupabase = createClient(url, key);
    browserSupabaseConfigKey = configKey;
  }

  return browserSupabase;
}
