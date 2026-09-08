// SafeWalk — delete your account
//
// The right this app most obviously owed and could not honour: erasure. Deleting an auth user needs
// the service_role key, which must never be in the client, so it has to happen here.
//
// The database already describes what should survive, and it was designed this way on purpose:
//
//   pins.user_id        ON DELETE SET NULL   — your ratings stay on the map, with no author
//   votes               ON DELETE CASCADE    — gone
//   incidents           ON DELETE CASCADE    — gone
//   walks               ON DELETE CASCADE    — gone
//   pin_confirmations   ON DELETE CASCADE    — gone
//   incident_confirmations ON DELETE CASCADE — gone
//
// So this function does not delete rows itself. It deletes the user and lets the foreign keys do
// exactly what they already say, which is far safer than a hand-written list that drifts out of
// date the next time a table is added. The consequence — that public ratings remain, unlinked from
// anybody — is stated plainly in the app before anyone confirms, because a deletion that quietly
// leaves things behind is not a deletion.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Whose account is being deleted is decided by the token, never by the request body. Taking a
  // user id from the caller would let anyone delete anyone.
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'not signed in' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: auth } } });
  const { data: who, error: whoError } = await asCaller.auth.getUser();
  if (whoError || !who?.user) {
    return new Response(JSON.stringify({ error: 'not signed in' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const admin = createClient(url, serviceKey);
  const { error } = await admin.auth.admin.deleteUser(who.user.id);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ deleted: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
});
