import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.10';
import { handleNotificationRequest } from './worker.mjs';

// Cron uses its own secret header. Configure verify_jwt=false only when enabling this
// server-only function; the handler still rejects every call without the exact secret.
Deno.serve((request: Request) => handleNotificationRequest(request, {
  createClient,
  env: {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    RESEND_API_KEY: Deno.env.get('RESEND_API_KEY'),
    FORUM_MAIL_FROM: Deno.env.get('FORUM_MAIL_FROM'),
    FORUM_MAIL_WORKER_SECRET: Deno.env.get('FORUM_MAIL_WORKER_SECRET'),
  },
}));
