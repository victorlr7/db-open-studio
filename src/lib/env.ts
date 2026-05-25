export function getAppDatabaseUrl() {
  return process.env.DBOPENSTUDIO_DATABASE_URL || "";
}

export function isSupabaseAppPersistenceConfigured() {
  return Boolean(
    getAppDatabaseUrl() &&
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}
