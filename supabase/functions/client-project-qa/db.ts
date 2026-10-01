import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "./config.ts";

export type AdminClient = SupabaseClient;

export function createAdminClient(config: AppConfig): AdminClient {
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { "X-Client-Info": "wicontrol-qa-edge/1.0" },
    },
  });
}
