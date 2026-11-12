import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-update-cursor'
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(psqlBin, 'psql.exe'),
      ['-X', '-q', '-w', '-c', query],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '', err = '';
    child.stdout.on('data', x => out += x);
    child.stderr.on('data', x => err += x);
    child.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(Error(`psql failed (${code}): ${err}`));
    });
  });
}

const updateSql = `
BEGIN;
CREATE OR REPLACE FUNCTION public.admin_read_v2_inventory(p_limit integer DEFAULT 200, p_after text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;
BEGIN
 PERFORM rr_v2_control.admin_read_admit();
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR (p_after IS NOT NULL AND p_after !~ '^[A-Za-z0-9_-]{8,30}$') THEN
  RAISE EXCEPTION 'Invalid read cursor/limit' USING ERRCODE='22023';
 END IF;
 WITH batch AS MATERIALIZED (
  SELECT * FROM rr_v2_control.admin_read_inventory
  WHERE p_after IS NULL OR card_code COLLATE "C">p_after COLLATE "C"
  ORDER BY card_code COLLATE "C" LIMIT p_limit+1
 ), page AS MATERIALIZED (SELECT * FROM batch ORDER BY card_code COLLATE "C" LIMIT p_limit)
 SELECT jsonb_build_object('cards',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.card_code COLLATE "C") FROM page p),'[]'::jsonb),
 'next_cursor',CASE WHEN (SELECT count(*) FROM batch)>p_limit THEN
 (SELECT card_code FROM page ORDER BY card_code COLLATE "C" DESC LIMIT 1) ELSE NULL END) INTO result;
 RETURN result;
END $function$;

UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;
SELECT rr_v2_test.assert_acl();
COMMIT;
`;

psql(updateSql).then(r => console.log('Successfully updated cursor regex:', r)).catch(console.error);
