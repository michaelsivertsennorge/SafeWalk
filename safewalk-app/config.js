// Supabase connection details.
//
// The anon key is *designed* to be public and shipped in client code — it grants no privileges on
// its own. Every table is protected by Row Level Security (verified: an anonymous write is
// rejected with "violates row-level security policy"), so what a user may read or change is decided
// by the database, not by this file. The service_role key is the secret one and must never appear here.
const SUPABASE_URL = 'https://cxvwxqjbyplyvxufibii.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4dnd4cWpieXBseXZ4dWZpYmlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MjU2NzMsImV4cCI6MjEwNDIwMTY3M30.ssSV4BfgePTD34pt9NjQCSFezJKAxGNyE-QQwrgYufw';
