import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { readAdminEnv } from './admin-readonly-config.mjs';

const env = readAdminEnv('.env.admin-readonly');
const child = spawn('psql', [env.SUPABASE_DB_URL, '-c', "SELECT proname, pg_get_function_arguments(oid) FROM pg_proc WHERE proname = 'buyer_v2_analytics';"], { stdio: 'inherit' });
child.on('close', code => process.exit(code));
