import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.10';
import webpush from 'npm:web-push@3.6.7';
import { handlePushRequest } from './worker.mjs';

// Run with verify_jwt=false. Authentication is the independent secret checked in Vault
// through a service_role-only RPC; no VAPID material or custom secret enters this source.
Deno.serve((request: Request) => handlePushRequest(request, {
  createClient,
  generateRequestDetails: webpush.generateRequestDetails.bind(webpush),
  env: {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  },
}));
