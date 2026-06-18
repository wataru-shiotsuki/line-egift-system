const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://ivtesoqgbkwkmoxekjrp.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
module.exports = supabase;