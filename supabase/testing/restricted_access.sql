-- LOCAL PREPARATION ONLY. Wrapped by prepare-restricted-local.mjs, not standalone.
-- Original 11 business RPCs remain revoked. No new legacy table grants.
CREATE SCHEMA rr_v2_test;
REVOKE ALL ON SCHEMA rr_v2_test FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE rr_v2_test.baseline(id boolean PRIMARY KEY CHECK(id),hashes jsonb NOT NULL);
INSERT INTO rr_v2_test.baseline SELECT true,hashes FROM rr_v2_control.state WHERE id;
CREATE TABLE rr_v2_test.runs(
 run_id uuid PRIMARY KEY,user_a uuid NOT NULL REFERENCES auth.users,user_b uuid NOT NULL REFERENCES auth.users,
 expires_at timestamptz NOT NULL,status text NOT NULL CHECK(status IN ('provisioning','active','retired')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),closed_at timestamptz,CHECK(user_a<>user_b)
);
CREATE UNIQUE INDEX one_restricted_run ON rr_v2_test.runs((true)) WHERE status IN ('provisioning','active');
CREATE TABLE rr_v2_test.cards(
 card_code text PRIMARY KEY REFERENCES public.card(card_code) DEFERRABLE INITIALLY DEFERRED,
 run_id uuid NOT NULL REFERENCES rr_v2_test.runs,label text NOT NULL,retired boolean NOT NULL DEFAULT false
);
CREATE TABLE rr_v2_test.context(
 backend integer NOT NULL,xid xid8 NOT NULL,nonce uuid NOT NULL,
 run_id uuid NOT NULL REFERENCES rr_v2_test.runs,kind text NOT NULL,card_code text,actor uuid,
 PRIMARY KEY(backend,xid),CHECK(kind IN ('provision','claim','update','admin_reset','cleanup'))
);
CREATE TABLE rr_v2_test.limit_snapshot(
 run_id uuid NOT NULL REFERENCES rr_v2_test.runs,user_id uuid NOT NULL REFERENCES auth.users,
 existed boolean NOT NULL,window_start timestamptz,attempts integer,PRIMARY KEY(run_id,user_id)
);
CREATE TABLE rr_v2_test.events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,run_id uuid NOT NULL REFERENCES rr_v2_test.runs,
 event text NOT NULL,actor uuid,card_code text,detail jsonb NOT NULL DEFAULT '{}',at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT c.oid::regclass rel FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_v2_test' AND c.relkind='r' LOOP
  EXECUTE 'ALTER TABLE '||r.rel||' ENABLE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON '||r.rel||' FROM PUBLIC,anon,authenticated,service_role';
 END LOOP;
END $$;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA rr_v2_test FROM PUBLIC,anon,authenticated,service_role;
REVOKE SELECT ON public.buyer_card_ownership,public.buyer_card_inventory,public.buyer_claim_limits,public.buyer_ownership_audit,public.buyer_activation_reset_audit FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION rr_v2_test.assert_acl() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r record;app text;testing boolean;
BEGIN
 SELECT coalesce(bool_or(state='testing_restricted'),false) INTO testing FROM rr_v2_control.state;
 IF pg_has_role('anon','authenticated','MEMBER') OR pg_has_role('anon','service_role','MEMBER')
 OR pg_has_role('authenticated','service_role','MEMBER') OR pg_has_role('service_role','authenticated','MEMBER')
 OR EXISTS(SELECT 1 FROM pg_roles p CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) a WHERE (p.rolsuper OR p.rolname='postgres') AND pg_has_role(a,p.oid,'MEMBER')) THEN
  RAISE EXCEPTION 'Unsafe application role inheritance' USING ERRCODE='42501';
 END IF;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
 ('buyer_list_cards','buyer_activate_card','buyer_claim_card','buyer_update_card','buyer_first_claim','buyer_public_card_status','admin_create_v2_cards','admin_recover_v2_owner','admin_set_v2_card_ready','admin_list_v2_activation_cards','admin_reset_v2_activation'))<>11 THEN RAISE EXCEPTION 'Original RPC inventory mismatch' USING ERRCODE='42501'; END IF;
 FOREACH app IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(app,'public.buyer_test_action(uuid,text,text,text,text)','EXECUTE') IS DISTINCT FROM (testing AND app='authenticated')
  OR has_function_privilege(app,'public.admin_test_reset(uuid,text,text,bigint,text,text)','EXECUTE') IS DISTINCT FROM (testing AND app='service_role') THEN
   RAISE EXCEPTION 'Restricted wrapper permission matrix mismatch' USING ERRCODE='42501';
  END IF;
  IF has_schema_privilege(app,'rr_v2_test','USAGE') OR has_schema_privilege(app,'rr_v2_control','USAGE') THEN RAISE EXCEPTION 'Private schema access remains effective' USING ERRCODE='42501'; END IF;
  FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='rr_v2_test' OR
   (n.nspname='public' AND p.proname IN ('buyer_list_cards','buyer_activate_card','buyer_claim_card','buyer_update_card','buyer_first_claim','buyer_public_card_status','admin_create_v2_cards','admin_recover_v2_owner','admin_set_v2_card_ready','admin_list_v2_activation_cards','admin_reset_v2_activation')) LOOP
   IF has_function_privilege(app,r.oid,'EXECUTE') THEN RAISE EXCEPTION 'Private/original RPC access remains effective' USING ERRCODE='42501'; END IF;
  END LOOP;
  FOR r IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND
   (n.nspname IN ('rr_v2_test','rr_v2_control') OR (n.nspname='public' AND c.relname IN ('buyer_card_ownership','buyer_card_inventory','buyer_claim_limits','buyer_ownership_audit','buyer_activation_reset_audit'))) LOOP
   IF has_table_privilege(app,r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(app,r.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Private table/column access remains effective' USING ERRCODE='42501'; END IF;
  END LOOP;
 END LOOP;
END $$;

CREATE FUNCTION rr_v2_test.verify_state(wanted text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM rr_v2_test.assert_acl();
 IF NOT EXISTS(SELECT 1 FROM rr_v2_control.state s JOIN rr_v2_test.baseline b ON b.id=s.id
 WHERE s.stage=6 AND s.state=wanted AND s.hashes=b.hashes AND s.fingerprint=rr_v2_test.fingerprint()) THEN
  RAISE EXCEPTION 'Restricted checkpoint/hash/fingerprint mismatch' USING ERRCODE='42501';
 END IF;
END $$;

CREATE FUNCTION rr_v2_test.admit(p_run uuid,p_card text,p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r rr_v2_test.runs%ROWTYPE;
BEGIN
 SELECT * INTO r FROM rr_v2_test.runs WHERE run_id=p_run FOR SHARE;
 IF NOT FOUND OR r.status<>'active' OR clock_timestamp()>=r.expires_at
 OR NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND stage=6 AND state='testing_restricted') THEN RETURN false; END IF;
 IF p_user IS NOT NULL AND (p_user NOT IN(r.user_a,r.user_b) OR NOT EXISTS(SELECT 1 FROM auth.identities WHERE user_id=p_user AND provider='google')) THEN RETURN false; END IF;
 IF p_card IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rr_v2_test.cards WHERE run_id=p_run AND card_code=p_card AND NOT retired) THEN RETURN false; END IF;
 PERFORM rr_v2_test.verify_state('testing_restricted');
 RETURN true;
END $$;

CREATE FUNCTION rr_v2_test.write_allowed(tab text,operation text,oldrow jsonb,newrow jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE ctx rr_v2_test.context%ROWTYPE;r rr_v2_test.runs%ROWTYPE;code text;uid uuid;
BEGIN
 SELECT * INTO ctx FROM rr_v2_test.context WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id_if_assigned();
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO r FROM rr_v2_test.runs WHERE run_id=ctx.run_id;
 IF NOT FOUND THEN RETURN false; END IF;
 IF ctx.kind IN ('provision','cleanup') THEN
  IF (ctx.kind='provision' AND r.status<>'provisioning') OR (ctx.kind='cleanup' AND r.status<>'active') THEN RETURN false; END IF;
 ELSE
  IF r.status<>'active' OR clock_timestamp()>=r.expires_at OR NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND state='testing_restricted') THEN RETURN false; END IF;
  IF ctx.kind IN ('claim','update') AND (ctx.actor IS DISTINCT FROM auth.uid() OR ctx.actor NOT IN(r.user_a,r.user_b) OR NOT EXISTS(SELECT 1 FROM auth.identities WHERE user_id=ctx.actor AND provider='google')) THEN RETURN false; END IF;
 END IF;
 IF tab='buyer_claim_limits' THEN
  IF ctx.kind NOT IN ('claim','cleanup') THEN RETURN false; END IF;
  IF operation<>'INSERT' THEN
   uid:=(oldrow->>'user_id')::uuid;
   IF uid NOT IN(r.user_a,r.user_b) OR (ctx.kind='claim' AND uid IS DISTINCT FROM ctx.actor) THEN RETURN false; END IF;
  END IF;
  IF operation<>'DELETE' THEN
   uid:=(newrow->>'user_id')::uuid;
   IF uid NOT IN(r.user_a,r.user_b) OR (ctx.kind='claim' AND uid IS DISTINCT FROM ctx.actor) THEN RETURN false; END IF;
  END IF;
  RETURN true;
 END IF;
 code:=coalesce(newrow->>'card_code',oldrow->>'card_code');
 IF code IS DISTINCT FROM ctx.card_code OR (operation='UPDATE' AND (oldrow->>'card_code') IS DISTINCT FROM (newrow->>'card_code'))
 OR NOT EXISTS(SELECT 1 FROM rr_v2_test.cards WHERE run_id=ctx.run_id AND card_code=code AND NOT retired) THEN RETURN false; END IF;
 IF tab='card' THEN
  IF operation='DELETE' OR (newrow->>'claim_mode') IS DISTINCT FROM 'google_first_claim' OR newrow->>'pin_hash' IS NOT NULL THEN RETURN false; END IF;
  IF operation='UPDATE' AND (oldrow->'id' IS DISTINCT FROM newrow->'id' OR oldrow->'created_at' IS DISTINCT FROM newrow->'created_at') THEN RETURN false; END IF;
  IF ctx.kind='provision' THEN RETURN operation='INSERT' AND newrow->>'review_url' IS NULL AND newrow->>'v2_activated_at' IS NULL; END IF;
  IF ctx.kind IN ('admin_reset','cleanup') THEN RETURN newrow->>'review_url' IS NULL AND newrow->>'business_name' IS NULL AND newrow->>'v2_activated_at' IS NULL; END IF;
  RETURN ctx.kind IN ('claim','update') AND operation='UPDATE';
 ELSIF tab IN ('card_activation','card_pin_attempts') THEN RETURN false;
 ELSIF tab='buyer_card_ownership' THEN
  IF ctx.kind='claim' THEN RETURN operation='INSERT' AND (newrow->>'user_id')::uuid=ctx.actor; END IF;
  RETURN ctx.kind IN ('admin_reset','cleanup') AND operation='DELETE' AND (oldrow->>'user_id')::uuid IN(r.user_a,r.user_b);
 ELSIF tab='buyer_card_inventory' THEN RETURN ctx.kind IN ('provision','claim','admin_reset','cleanup');
 ELSIF tab='buyer_ownership_audit' THEN RETURN ctx.kind='claim' AND operation='INSERT' AND (newrow->>'new_owner')::uuid=ctx.actor;
 ELSIF tab='buyer_activation_reset_audit' THEN RETURN ctx.kind IN ('admin_reset','cleanup') AND operation='INSERT';
 END IF;
 RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.v2_pause_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o jsonb;n jsonb;scoped boolean:=true;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Restricted TRUNCATE denied' USING ERRCODE='42501'; END IF;
 IF TG_OP<>'INSERT' THEN o:=to_jsonb(OLD); END IF; IF TG_OP<>'DELETE' THEN n:=to_jsonb(NEW); END IF;
 IF TG_TABLE_NAME='card' THEN scoped:=coalesce(o->>'claim_mode','legacy')='google_first_claim' OR coalesce(n->>'claim_mode','legacy')='google_first_claim';
 ELSIF TG_TABLE_NAME IN ('card_activation','card_pin_attempts') THEN
  SELECT EXISTS(SELECT 1 FROM public.card WHERE card_code IN(o->>'card_code',n->>'card_code') AND claim_mode='google_first_claim') INTO scoped;
 END IF;
 IF scoped AND NOT rr_v2_test.write_allowed(TG_TABLE_NAME,TG_OP,o,n) THEN RAISE EXCEPTION 'Restricted write scope denied' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['card','card_activation','card_pin_attempts','buyer_card_ownership','buyer_card_inventory','buyer_claim_limits','buyer_ownership_audit','buyer_activation_reset_audit'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS v2_pause_write ON public.%I',tab);
  EXECUTE format('CREATE TRIGGER v2_pause_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.v2_pause_guard()',tab);
  IF tab LIKE 'buyer_%' THEN EXECUTE format('CREATE TRIGGER restricted_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.v2_pause_guard()',tab); END IF;
 END LOOP;
END $$;

CREATE FUNCTION rr_v2_test.open_run(p_run uuid,p_a uuid,p_b uuid,p_minutes integer DEFAULT 30)
RETURNS TABLE(card_code text) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i integer;code text;uid uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(728401); PERFORM rr_v2_test.verify_state('closed');
 IF p_run IS NULL OR p_a IS NULL OR p_b IS NULL OR p_a=p_b OR p_minutes NOT BETWEEN 1 AND 60 OR p_minutes IS NULL
 OR EXISTS(SELECT 1 FROM rr_v2_test.runs WHERE status IN ('active','provisioning') OR run_id=p_run)
 OR (SELECT count(DISTINCT user_id) FROM auth.identities WHERE user_id IN(p_a,p_b) AND provider='google')<>2 THEN RAISE EXCEPTION 'Invalid restricted run' USING ERRCODE='42501'; END IF;
 INSERT INTO rr_v2_test.runs(run_id,user_a,user_b,expires_at,status) VALUES(p_run,p_a,p_b,clock_timestamp()+p_minutes*interval '1 minute','provisioning');
 FOREACH uid IN ARRAY ARRAY[p_a,p_b] LOOP
  INSERT INTO rr_v2_test.limit_snapshot SELECT p_run,uid,EXISTS(SELECT 1 FROM public.buyer_claim_limits WHERE user_id=uid),l.window_start,l.attempts FROM (SELECT 1) t LEFT JOIN public.buyer_claim_limits l ON l.user_id=uid;
 END LOOP;
 INSERT INTO rr_v2_test.context VALUES(pg_backend_pid(),pg_current_xact_id(),gen_random_uuid(),p_run,'provision',NULL,NULL);
 FOR i IN 1..2 LOOP
  LOOP
   code:=translate(encode(extensions.gen_random_bytes(18),'base64'),'+/','-_'); EXIT WHEN NOT EXISTS(SELECT 1 FROM public.card c WHERE c.card_code=code);
  END LOOP;
  INSERT INTO rr_v2_test.cards VALUES(code,p_run,'RR-JWT-DUMMY-0'||i,false);
  UPDATE rr_v2_test.context SET card_code=code WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id();
  INSERT INTO public.card(card_code,claim_mode) VALUES(code,'google_first_claim');
  INSERT INTO public.buyer_card_inventory(card_code,state,ready_at,updated_by) VALUES(code,'ready',clock_timestamp(),'restricted-provision');
  card_code:=code; RETURN NEXT;
 END LOOP;
 DELETE FROM rr_v2_test.context WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id();
 UPDATE rr_v2_test.runs SET status='active' WHERE run_id=p_run;
 GRANT EXECUTE ON FUNCTION public.buyer_test_action(uuid,text,text,text,text) TO authenticated;
 GRANT EXECUTE ON FUNCTION public.admin_test_reset(uuid,text,text,bigint,text,text) TO service_role;
 UPDATE rr_v2_control.state SET state='testing_restricted',fingerprint=rr_v2_test.fingerprint() WHERE id;
 PERFORM rr_v2_test.assert_acl();
 INSERT INTO rr_v2_test.events(run_id,event) VALUES(p_run,'opened');
END $$;

CREATE FUNCTION public.buyer_test_action(p_run uuid,p_op text,p_card_code text DEFAULT NULL,p_business_name text DEFAULT NULL,p_review_url text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid:=auth.uid();result jsonb;
BEGIN
 IF u IS NULL OR p_op IS NULL OR p_op NOT IN ('list','status','claim','update') OR (p_op<>'list' AND p_card_code IS NULL)
 OR NOT rr_v2_test.admit(p_run,p_card_code,u) THEN RETURN jsonb_build_object('success',false,'code','test_denied'); END IF;
 IF p_op='list' THEN
  SELECT jsonb_build_object('success',true,'cards',coalesce(jsonb_agg(jsonb_build_object('card_code',c.card_code,'business_name',c.business_name,'review_url',c.review_url,'active',c.v2_activated_at IS NOT NULL)),'[]'::jsonb)) INTO result
  FROM public.card c JOIN rr_v2_test.cards t USING(card_code) JOIN public.buyer_card_ownership o USING(card_code) WHERE t.run_id=p_run AND NOT t.retired AND o.user_id=u;
 ELSIF p_op='status' THEN result:=jsonb_build_object('success',true,'status',public.buyer_public_card_status(p_card_code));
 ELSE
  INSERT INTO rr_v2_test.context VALUES(pg_backend_pid(),pg_current_xact_id(),gen_random_uuid(),p_run,p_op,p_card_code,u);
  IF p_op='claim' THEN result:=public.buyer_first_claim(p_card_code,p_business_name,p_review_url);
  ELSE result:=jsonb_build_object('success',public.buyer_update_card(p_card_code,p_business_name,p_review_url)); END IF;
  DELETE FROM rr_v2_test.context WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id();
  INSERT INTO rr_v2_test.events(run_id,event,actor,card_code,detail) VALUES(p_run,p_op,u,p_card_code,jsonb_build_object('success',result->'success'));
 END IF;
 IF NOT rr_v2_test.admit(p_run,p_card_code,u) THEN RAISE EXCEPTION 'Restricted run expired during operation' USING ERRCODE='42501'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION public.admin_test_reset(p_run uuid,p_card_code text,p_confirmation text,p_expected_revision bigint,p_actor text,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result boolean;
BEGIN
 IF p_card_code IS NULL OR p_confirmation IS DISTINCT FROM p_card_code OR p_expected_revision IS NULL OR p_expected_revision<0
 OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 110 OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 20 AND 1000
 OR NOT rr_v2_test.admit(p_run,p_card_code,NULL) THEN RETURN false; END IF;
 INSERT INTO rr_v2_test.context VALUES(pg_backend_pid(),pg_current_xact_id(),gen_random_uuid(),p_run,'admin_reset',p_card_code,NULL);
 result:=public.admin_reset_v2_activation(p_card_code,p_confirmation,p_expected_revision,'restricted-admin:'||btrim(p_actor),p_reason);
 DELETE FROM rr_v2_test.context WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id();
 IF NOT rr_v2_test.admit(p_run,p_card_code,NULL) THEN RAISE EXCEPTION 'Restricted run expired during reset' USING ERRCODE='42501'; END IF;
 INSERT INTO rr_v2_test.events(run_id,event,card_code,detail) VALUES(p_run,'admin_reset',p_card_code,jsonb_build_object('success',result,'server_actor',p_actor));
 RETURN result;
END $$;

CREATE FUNCTION rr_v2_test.close_run(p_run uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r rr_v2_test.runs%ROWTYPE;c record;l record;revision bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(728401);
 SELECT * INTO r FROM rr_v2_test.runs WHERE run_id=p_run FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF r.status='retired' THEN PERFORM rr_v2_test.verify_state('closed'); RETURN true; END IF;
 PERFORM rr_v2_test.verify_state('testing_restricted');
 INSERT INTO rr_v2_test.context VALUES(pg_backend_pid(),pg_current_xact_id(),gen_random_uuid(),p_run,'cleanup',NULL,NULL);
 FOR c IN SELECT card_code FROM rr_v2_test.cards WHERE run_id=p_run AND NOT retired LOOP
  UPDATE rr_v2_test.context SET card_code=c.card_code WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id();
  IF EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code=c.card_code) THEN
   SELECT activation_revision INTO revision FROM public.buyer_card_inventory WHERE card_code=c.card_code;
   IF public.admin_reset_v2_activation(c.card_code,c.card_code,revision,'test-cleanup:'||p_run,'Close restricted test fixture; preserve identity and audit') IS NOT TRUE THEN RAISE EXCEPTION 'Fixture cleanup reset failed'; END IF;
  END IF;
  UPDATE public.buyer_card_inventory SET state='draft',ready_at=NULL,claimed_at=NULL,updated_at=clock_timestamp(),updated_by='restricted-retired' WHERE card_code=c.card_code;
  UPDATE rr_v2_test.cards SET retired=true WHERE card_code=c.card_code;
 END LOOP;
 UPDATE rr_v2_test.context SET card_code=NULL WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id();
 FOR l IN SELECT * FROM rr_v2_test.limit_snapshot WHERE run_id=p_run LOOP
  IF l.existed THEN INSERT INTO public.buyer_claim_limits(user_id,window_start,attempts) VALUES(l.user_id,l.window_start,l.attempts) ON CONFLICT(user_id) DO UPDATE SET window_start=excluded.window_start,attempts=excluded.attempts;
  ELSE DELETE FROM public.buyer_claim_limits WHERE user_id=l.user_id; END IF;
 END LOOP;
 DELETE FROM rr_v2_test.context WHERE backend=pg_backend_pid() AND xid=pg_current_xact_id();
 UPDATE rr_v2_test.runs SET status='retired',closed_at=clock_timestamp() WHERE run_id=p_run;
 REVOKE ALL ON FUNCTION public.buyer_test_action(uuid,text,text,text,text),public.admin_test_reset(uuid,text,text,bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;
 UPDATE rr_v2_control.state SET state='closed',fingerprint=rr_v2_test.fingerprint() WHERE id;
 PERFORM rr_v2_test.assert_acl();
 INSERT INTO rr_v2_test.events(run_id,event) VALUES(p_run,'closed');
 RETURN true;
END $$;

CREATE FUNCTION rr_v2_test.lockdown() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE f record;
BEGIN
 PERFORM pg_advisory_xact_lock(728401);
 -- Emergency closure deliberately does not accept a new fingerprint or clean up
 -- fixture rows. Unknown drift requires operator review, never automatic resume.
 PERFORM 1 FROM rr_v2_test.runs WHERE status IN ('provisioning','active') FOR UPDATE;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%') LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION '||f.signature||' FROM PUBLIC,anon,authenticated,service_role';
 END LOOP;
 UPDATE rr_v2_control.state SET state='review_required' WHERE id;
 INSERT INTO rr_v2_test.events(run_id,event) SELECT run_id,'locked_down' FROM rr_v2_test.runs WHERE status='active';
END $$;

-- Explicit grants only at open_run; no PUBLIC execute defaults survive install.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rr_v2_test FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.buyer_test_action(uuid,text,text,text,text),public.admin_test_reset(uuid,text,text,bigint,text,text),public.v2_pause_guard() FROM PUBLIC,anon,authenticated,service_role;
