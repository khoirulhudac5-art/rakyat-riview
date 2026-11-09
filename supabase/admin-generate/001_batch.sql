-- BODY ONLY: use the local generated transaction package; never standalone.
CREATE TABLE rr_v2_generate.batches(
 request_id uuid PRIMARY KEY,quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 1000),
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 150),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),complete boolean NOT NULL DEFAULT false
);
CREATE TABLE rr_v2_generate.cards(
 id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,card_code text PRIMARY KEY CHECK(card_code ~ '^[A-Za-z0-9_-]{24}$'),
 request_id uuid NOT NULL REFERENCES rr_v2_generate.batches,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 1000),
 UNIQUE(request_id,ordinal),FOREIGN KEY(card_code) REFERENCES public.card(card_code) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE rr_v2_generate.context(backend integer NOT NULL,xid xid8 NOT NULL,request_id uuid NOT NULL REFERENCES rr_v2_generate.batches,card_code text,admitted_fingerprint text NOT NULL,PRIMARY KEY(backend,xid));

CREATE FUNCTION rr_v2_generate.next_code() RETURNS text LANGUAGE sql VOLATILE SET search_path='' AS $$
 SELECT translate(encode(extensions.gen_random_bytes(18),'base64'),'+/','-_') $$;

CREATE FUNCTION rr_v2_generate.write_allowed(tab text,op text,n jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE ctx rr_v2_generate.context%ROWTYPE;
BEGIN
 IF op<>'INSERT' OR NOT EXISTS(SELECT 1 FROM rr_v2_generate.control WHERE id AND enabled)
 OR NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND stage=6 AND state='closed') THEN RETURN false;END IF;
 SELECT * INTO ctx FROM rr_v2_generate.context WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id_if_assigned();
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND fingerprint=ctx.admitted_fingerprint) OR ctx.card_code IS DISTINCT FROM n->>'card_code' OR NOT EXISTS(
 SELECT 1 FROM rr_v2_generate.cards g JOIN rr_v2_generate.batches b USING(request_id)
 WHERE g.request_id=ctx.request_id AND g.card_code=ctx.card_code AND NOT b.complete AND g.ordinal<=b.quantity) THEN RETURN false;END IF;
 IF tab='card' THEN RETURN n->>'claim_mode'='google_first_claim' AND n->>'pin_hash' IS NULL AND n->>'review_url' IS NULL AND n->>'business_name' IS NULL AND n->>'v2_activated_at' IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.card WHERE card_code=ctx.card_code);END IF;
 IF tab='buyer_card_inventory' THEN RETURN n->>'state'='ready' AND n->>'ready_at' IS NOT NULL AND n->>'claimed_at' IS NULL AND n->>'updated_by'='admin:generate'
 AND EXISTS(SELECT 1 FROM public.card WHERE card_code=ctx.card_code AND claim_mode='google_first_claim' AND pin_hash IS NULL AND v2_activated_at IS NULL);END IF;
 RETURN false;
END $$;

CREATE FUNCTION public.admin_generate_v2_batch(p_request_id uuid,p_quantity integer,p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE b rr_v2_generate.batches%ROWTYPE;code text;i integer;tries integer;result jsonb;
BEGIN
 IF p_request_id IS NULL OR p_quantity IS NULL OR p_quantity NOT BETWEEN 1 AND 1000 OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 150 THEN RAISE EXCEPTION 'Invalid batch request' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock_shared(728401);
 PERFORM rr_v2_test.verify_state('closed');
 IF NOT EXISTS(SELECT 1 FROM rr_v2_generate.control WHERE id AND enabled) THEN RAISE EXCEPTION 'Generation closed' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,61490));
 SELECT * INTO b FROM rr_v2_generate.batches WHERE request_id=p_request_id;
 IF FOUND THEN
  IF b.quantity<>p_quantity OR b.actor<>p_actor OR NOT b.complete THEN RAISE EXCEPTION 'Idempotency payload mismatch' USING ERRCODE='22023';END IF;
 ELSE
  INSERT INTO rr_v2_generate.batches(request_id,quantity,actor) VALUES(p_request_id,p_quantity,p_actor);
  INSERT INTO rr_v2_generate.context SELECT pg_backend_pid(),pg_current_xact_id(),p_request_id,NULL,fingerprint FROM rr_v2_control.state WHERE id;
  FOR i IN 1..p_quantity LOOP
   tries:=0;
   LOOP
    tries:=tries+1;IF tries>32 THEN RAISE EXCEPTION 'Code allocation exhausted';END IF;
    code:=rr_v2_generate.next_code();
    IF code !~ '^[A-Za-z0-9_-]{24}$' THEN RAISE EXCEPTION 'Invalid generated code';END IF;
    IF EXISTS(SELECT 1 FROM public.card WHERE card_code=code) THEN CONTINUE;END IF;
    INSERT INTO rr_v2_generate.cards(card_code,request_id,ordinal) VALUES(code,p_request_id,i) ON CONFLICT DO NOTHING;
    EXIT WHEN FOUND;
   END LOOP;
   UPDATE rr_v2_generate.context SET card_code=code WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id();
   INSERT INTO public.card(card_code,claim_mode) VALUES(code,'google_first_claim');
   INSERT INTO public.buyer_card_inventory(card_code,state,ready_at,updated_by) VALUES(code,'ready',clock_timestamp(),'admin:generate');
  END LOOP;
  DELETE FROM rr_v2_generate.context WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id();
  UPDATE rr_v2_generate.batches SET complete=true WHERE request_id=p_request_id;
 END IF;
 SELECT jsonb_build_object('success',true,'batch_id',p_request_id,'cards',jsonb_agg(jsonb_build_object('card_code',g.card_code) ORDER BY ordinal)) INTO result FROM rr_v2_generate.cards g WHERE request_id=p_request_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.admin_generate_v2_batch(uuid,integer,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION rr_v2_generate.assert_acl() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE app text;r record;e boolean;
BEGIN
 SELECT enabled INTO STRICT e FROM rr_v2_generate.control WHERE id;
 FOREACH app IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(app,'public.admin_generate_v2_batch(uuid,integer,text)','EXECUTE') IS DISTINCT FROM (e AND app='service_role')
  OR has_schema_privilege(app,'rr_v2_generate','USAGE') THEN RAISE EXCEPTION 'Generate ACL mismatch' USING ERRCODE='42501';END IF;
  FOR r IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_v2_generate' AND c.relkind IN ('r','v') LOOP
   IF has_table_privilege(app,r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(app,r.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Generate private table exposed';END IF;
  END LOOP;
  FOR r IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_v2_generate' AND c.relkind='S' LOOP
   IF has_sequence_privilege(app,r.oid,'USAGE,SELECT,UPDATE') THEN RAISE EXCEPTION 'Generate private sequence exposed';END IF;
  END LOOP;
  FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='rr_v2_generate' LOOP
   IF has_function_privilege(app,r.oid,'EXECUTE') THEN RAISE EXCEPTION 'Generate private helper exposed';END IF;
  END LOOP;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.admin_generate_v2_batch(uuid,integer,text)'::regprocedure AND proowner='postgres'::regrole AND prosecdef AND provolatile='v' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Generate function owner/config mismatch';END IF;
 IF EXISTS(SELECT 1 FROM rr_v2_generate.context) THEN RAISE EXCEPTION 'Leaked generate context';END IF;
END $$;
