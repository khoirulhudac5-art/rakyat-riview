-- Body only. Local package builder wraps transaction, baseline and recovery.
CREATE TABLE rr_claim_pilot.context(backend integer,xid xid8,uid uuid NOT NULL,card_code text NOT NULL,admitted_fingerprint text NOT NULL,PRIMARY KEY(backend,xid));
CREATE TABLE rr_claim_pilot.attempts(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,uid uuid NOT NULL REFERENCES auth.users(id),at timestamptz NOT NULL DEFAULT clock_timestamp(),result_code text NOT NULL DEFAULT 'pending');
CREATE FUNCTION rr_claim_pilot.admit(op text,code text,need_user boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE c rr_claim_pilot.control%ROWTYPE;
BEGIN
 SELECT * INTO c FROM rr_claim_pilot.control WHERE id;
 IF NOT FOUND OR code IS DISTINCT FROM c.card_code OR (CASE op WHEN 'status' THEN c.public_on WHEN 'claim' THEN c.claim_on AND c.expires_at>clock_timestamp() WHEN 'owner' THEN c.owner_on WHEN 'redirect' THEN c.redirect_on ELSE false END) IS DISTINCT FROM true THEN RETURN false;END IF;
 IF need_user AND auth.uid() IS NULL THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND stage=6 AND state='closed' AND fingerprint=rr_v2_test.fingerprint()) THEN RETURN false;END IF;
 RETURN true;
END $$;
CREATE FUNCTION rr_claim_pilot.write_allowed(tab text,op text,o jsonb,n jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE x rr_claim_pilot.context%ROWTYPE;
BEGIN
 SELECT * INTO x FROM rr_claim_pilot.context WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id_if_assigned();
 IF NOT FOUND OR x.uid IS DISTINCT FROM auth.uid() OR NOT EXISTS(SELECT 1 FROM rr_claim_pilot.control WHERE id AND claim_on AND expires_at>clock_timestamp() AND card_code=x.card_code) OR NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND state='closed' AND fingerprint=x.admitted_fingerprint) THEN RETURN false;END IF;
 IF tab='buyer_claim_limits' THEN RETURN op IN ('INSERT','UPDATE') AND (n->>'user_id')::uuid=x.uid AND (o IS NULL OR (o->>'user_id')::uuid=x.uid);END IF;
 IF coalesce(n->>'card_code',o->>'card_code') IS DISTINCT FROM x.card_code OR (o IS NOT NULL AND o->>'card_code' IS DISTINCT FROM x.card_code) THEN RETURN false;END IF;
 IF tab='buyer_card_ownership' THEN RETURN op='INSERT' AND (n->>'user_id')::uuid=x.uid;END IF;
 IF tab='card' THEN RETURN op='UPDATE' AND o->>'v2_activated_at' IS NULL AND n->>'v2_activated_at' IS NOT NULL AND n->'id'=o->'id' AND n->'created_at'=o->'created_at' AND n->>'claim_mode'='google_first_claim' AND o->>'claim_mode'='google_first_claim' AND n->>'pin_hash' IS NULL AND o->>'pin_hash' IS NULL AND n->>'review_url' ~ '^https://search\.google\.com/local/writereview\?placeid=ChI[A-Za-z0-9_-]{5,250}$' AND length(btrim(n->>'business_name')) BETWEEN 1 AND 150 AND EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code=x.card_code AND user_id=x.uid);END IF;
 IF tab='buyer_card_inventory' THEN RETURN op='UPDATE' AND o->>'state'='ready' AND n->>'state'='claimed' AND n->>'claimed_at' IS NOT NULL AND n->'activation_revision'=o->'activation_revision' AND n->'ready_at'=o->'ready_at' AND n->>'updated_by'='google:'||x.uid::text;END IF;
 IF tab='buyer_ownership_audit' THEN RETURN op='INSERT' AND (n->>'new_owner')::uuid=x.uid AND n->>'old_owner' IS NULL AND n->>'actor'='google:'||x.uid::text AND n->>'reason'='first_claim';END IF;
 RETURN false;
END $$;
CREATE FUNCTION public.buyer_pilot_public_status(p_card_code text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF NOT rr_claim_pilot.admit('status',p_card_code) THEN RETURN jsonb_build_object('activation_state','unavailable','claim_allowed',false);END IF;
 SELECT jsonb_build_object('code',c.card_code,'activation_state',CASE WHEN c.v2_activated_at IS NOT NULL THEN 'active' ELSE 'inactive' END,
 'claim_allowed',c.v2_activated_at IS NULL AND c.pin_hash IS NULL AND c.review_url IS NULL AND i.state='ready' AND NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code=c.card_code) AND (SELECT claim_on AND expires_at>clock_timestamp() FROM rr_claim_pilot.control WHERE id)) INTO result FROM public.card c JOIN public.buyer_card_inventory i USING(card_code) WHERE c.card_code=p_card_code AND c.claim_mode='google_first_claim';
 RETURN coalesce(result,jsonb_build_object('activation_state','unavailable','claim_allowed',false));END $$;
CREATE FUNCTION public.buyer_pilot_first_claim(p_card_code text,p_business_name text,p_review_url text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r jsonb;attempt_id bigint;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(728401);
 IF NOT rr_claim_pilot.admit('claim',p_card_code,true) OR NOT EXISTS(SELECT 1 FROM auth.identities WHERE user_id=auth.uid() AND provider='google') THEN RETURN jsonb_build_object('success',false,'code','pilot_denied');END IF;
 PERFORM rr_v2_test.verify_state('closed');
 INSERT INTO rr_claim_pilot.attempts(uid) VALUES(auth.uid()) RETURNING id INTO attempt_id;
 INSERT INTO rr_claim_pilot.context SELECT pg_backend_pid(),pg_current_xact_id(),auth.uid(),p_card_code,fingerprint FROM rr_v2_control.state WHERE id;
 r:=public.buyer_first_claim(p_card_code,p_business_name,p_review_url);
 DELETE FROM rr_claim_pilot.context WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id();
 UPDATE rr_claim_pilot.attempts SET result_code=CASE WHEN (r->>'success')::boolean THEN 'claimed' ELSE 'not_claimable' END WHERE id=attempt_id;
 RETURN jsonb_build_object('success',coalesce((r->>'success')::boolean,false),'code',CASE WHEN r->>'code'='rate_limited' THEN 'rate_limited' WHEN (r->>'success')::boolean THEN 'claimed' ELSE 'not_claimable' END);
END $$;
CREATE FUNCTION public.buyer_pilot_list_cards() RETURNS TABLE(card_code text,business_name text,review_url text,created_at timestamptz,active boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT c.card_code,c.business_name,c.review_url,c.created_at,c.v2_activated_at IS NOT NULL FROM public.card c JOIN public.buyer_card_ownership o USING(card_code) WHERE o.user_id=auth.uid() AND rr_claim_pilot.admit('owner',c.card_code,true) $$;
CREATE FUNCTION public.buyer_pilot_redirect_target(p_card_code text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('review_url',c.review_url) FROM public.card c JOIN public.buyer_card_inventory i USING(card_code) JOIN public.buyer_card_ownership o USING(card_code) WHERE c.card_code=p_card_code AND rr_claim_pilot.admit('redirect',c.card_code) AND c.v2_activated_at IS NOT NULL AND i.state='claimed' AND c.review_url ~ '^https://search\.google\.com/local/writereview\?placeid=ChI[A-Za-z0-9_-]{5,250}$' $$;
REVOKE ALL ON FUNCTION public.buyer_pilot_public_status(text),public.buyer_pilot_first_claim(text,text,text),public.buyer_pilot_list_cards(),public.buyer_pilot_redirect_target(text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION rr_claim_pilot.assert_acl() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg rr_claim_pilot.control%ROWTYPE;a text;f record;r record;wanted boolean;
BEGIN
 SELECT * INTO STRICT cfg FROM rr_claim_pilot.control WHERE id;
 FOREACH a IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_schema_privilege(a,'rr_claim_pilot','USAGE') THEN RAISE EXCEPTION 'Pilot schema exposed';END IF;
  FOR f IN SELECT p.oid,p.proname,p.proowner,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('buyer_pilot_public_status','buyer_pilot_first_claim','buyer_pilot_list_cards','buyer_pilot_redirect_target') LOOP
   wanted:=CASE f.proname WHEN 'buyer_pilot_public_status' THEN cfg.public_on AND a IN ('anon','authenticated') WHEN 'buyer_pilot_first_claim' THEN cfg.claim_on AND a='authenticated' WHEN 'buyer_pilot_list_cards' THEN cfg.owner_on AND a='authenticated' WHEN 'buyer_pilot_redirect_target' THEN cfg.redirect_on AND a='service_role' ELSE false END;
   IF has_function_privilege(a,f.oid,'EXECUTE') IS DISTINCT FROM wanted OR pg_get_userbyid(f.proowner)<>'postgres' OR NOT f.prosecdef OR NOT f.proconfig @> ARRAY['search_path=""'] THEN RAISE EXCEPTION 'Pilot RPC ACL/owner mismatch';END IF;
  END LOOP;
  FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='rr_claim_pilot' LOOP IF has_function_privilege(a,r.oid,'EXECUTE') THEN RAISE EXCEPTION 'Pilot helper exposed';END IF;END LOOP;
  FOR r IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_claim_pilot' AND c.relkind='r' LOOP IF has_table_privilege(a,r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(a,r.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Pilot table exposed';END IF;END LOOP;
  FOR r IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_claim_pilot' AND c.relkind='S' LOOP IF has_sequence_privilege(a,r.oid,'SELECT,USAGE,UPDATE') THEN RAISE EXCEPTION 'Pilot sequence exposed';END IF;END LOOP;
 END LOOP;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('buyer_pilot_public_status','buyer_pilot_first_claim','buyer_pilot_list_cards','buyer_pilot_redirect_target'))<>4 THEN RAISE EXCEPTION 'Pilot RPC inventory mismatch';END IF;
END $$;
