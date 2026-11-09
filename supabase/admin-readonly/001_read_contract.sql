-- BODY ONLY. Apply only through the reviewed generated transaction package.
-- No business row writes, RLS changes, direct application table grants or resume.
CREATE ROLE rr_admin_read_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT rr_admin_read_definer TO postgres;
GRANT USAGE,CREATE ON SCHEMA public TO rr_admin_read_definer;
GRANT USAGE ON SCHEMA rr_v2_control TO rr_admin_read_definer;

CREATE VIEW rr_v2_control.admin_read_inventory WITH (security_barrier=true) AS
 SELECT c.card_code,c.business_name,c.review_url,c.created_at,o.user_id AS owner_id,
 c.v2_activated_at IS NOT NULL AS active,i.activation_revision,i.state AS inventory_state
 FROM public.card c JOIN public.buyer_card_inventory i USING(card_code)
 LEFT JOIN public.buyer_card_ownership o USING(card_code)
 WHERE c.claim_mode='google_first_claim'
 AND NOT EXISTS(SELECT 1 FROM rr_v2_test.cards t WHERE t.card_code=c.card_code);

CREATE VIEW rr_v2_control.admin_read_audit WITH (security_barrier=true) AS
 SELECT 'ownership:'||a.id::text AS id,a.created_at AS at,
 CASE WHEN a.reason='first_claim' THEN 'claim' ELSE 'transfer' END::text AS action,
 a.card_code,a.actor,a.reason,a.old_owner,a.new_owner
 FROM public.buyer_ownership_audit a JOIN public.card c USING(card_code)
 WHERE c.claim_mode='google_first_claim'
 AND NOT EXISTS(SELECT 1 FROM rr_v2_test.cards t WHERE t.card_code=c.card_code)
 UNION ALL
 SELECT 'reset:'||a.id::text,a.reset_at,'reset'::text,a.card_code,a.actor,a.reason,a.old_owner,NULL::uuid
 FROM public.buyer_activation_reset_audit a JOIN public.card c USING(card_code)
 WHERE c.claim_mode='google_first_claim'
 AND NOT EXISTS(SELECT 1 FROM rr_v2_test.cards t WHERE t.card_code=c.card_code);
REVOKE ALL ON rr_v2_control.admin_read_inventory,rr_v2_control.admin_read_audit FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON rr_v2_control.admin_read_inventory,rr_v2_control.admin_read_audit TO rr_admin_read_definer;

CREATE FUNCTION public.admin_read_v2_inventory(p_limit integer DEFAULT 200,p_after text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $read$
DECLARE result jsonb;
BEGIN
 PERFORM rr_v2_control.admin_read_admit();
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR (p_after IS NOT NULL AND p_after !~ '^[A-Za-z0-9_-]{24}$') THEN
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
END $read$;

CREATE FUNCTION public.admin_read_v2_audit(p_limit integer DEFAULT 200,p_after text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $read$
DECLARE last_at timestamptz;last_id text;cursor_data jsonb;result jsonb;
BEGIN
 PERFORM rr_v2_control.admin_read_admit();
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid read limit' USING ERRCODE='22023'; END IF;
 IF p_after IS NOT NULL THEN
  BEGIN
   IF length(p_after)>512 OR p_after !~ '^[A-Za-z0-9_-]+$' THEN RAISE EXCEPTION 'bad cursor'; END IF;
   cursor_data:=convert_from(decode(rpad(translate(p_after,'-_','+/'),((length(p_after)+3)/4)*4,'='),'base64'),'UTF8')::jsonb;
   last_at:=(cursor_data->>'at')::timestamptz;last_id:=cursor_data->>'id';
   IF last_at IS NULL OR last_id IS NULL OR last_id !~ '^(ownership|reset):[0-9]+$' THEN RAISE EXCEPTION 'bad cursor'; END IF;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid audit cursor' USING ERRCODE='22023'; END;
 END IF;
 WITH batch AS MATERIALIZED (
  SELECT * FROM rr_v2_control.admin_read_audit
  WHERE p_after IS NULL OR (at,id COLLATE "C")>(last_at,last_id COLLATE "C")
  ORDER BY at,id COLLATE "C" LIMIT p_limit+1
 ), page AS MATERIALIZED (SELECT * FROM batch ORDER BY at,id COLLATE "C" LIMIT p_limit)
 SELECT jsonb_build_object('events',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.at,p.id COLLATE "C") FROM page p),'[]'::jsonb),
 'next_cursor',CASE WHEN (SELECT count(*) FROM batch)>p_limit THEN
 (SELECT replace(replace(translate(encode(convert_to(jsonb_build_object('at',at,'id',id)::text,'UTF8'),'base64'),'+/','-_'),E'\n',''),'=','')
 FROM page ORDER BY at DESC,id COLLATE "C" DESC LIMIT 1) ELSE NULL END) INTO result;
 RETURN result;
END $read$;

ALTER FUNCTION public.admin_read_v2_inventory(integer,text) OWNER TO rr_admin_read_definer;
ALTER FUNCTION public.admin_read_v2_audit(integer,text) OWNER TO rr_admin_read_definer;
REVOKE CREATE ON SCHEMA public FROM rr_admin_read_definer;
REVOKE ALL ON FUNCTION public.admin_read_v2_inventory(integer,text),public.admin_read_v2_audit(integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_read_v2_inventory(integer,text),public.admin_read_v2_audit(integer,text) TO service_role;
