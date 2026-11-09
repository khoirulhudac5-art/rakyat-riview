-- Partial-safe, checkpoint-aware emergency pause. Separate approval required externally.
BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SELECT pg_advisory_xact_lock(728401);DO $$ BEGIN
 IF to_regclass('rr_v2_control.state') IS NOT NULL THEN
  PERFORM set_config('rr_v2_control.pause_verified',(SELECT coalesce(bool_and(fingerprint=(SELECT md5(jsonb_build_object(
 'relations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.relname) FROM (SELECT c.relname,c.relkind,c.relacl,c.reloptions,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','v','S'))t),
 'columns',(SELECT jsonb_agg(to_jsonb(t) ORDER BY table_name,ordinal_position) FROM information_schema.columns t WHERE table_schema='public'),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_functiondef(p.oid),p.proacl) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.conname,pg_get_constraintdef(c.oid)) ORDER BY c.conname) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='public'),
 'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname,c.relname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal),
 'views',(SELECT jsonb_agg(jsonb_build_array(c.relname,pg_get_viewdef(c.oid,true)) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v'),
 'column_acl',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.attacl) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped),
 'owners',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','v','S')),
 'schema_acl',(SELECT jsonb_build_array(nspowner,nspacl) FROM pg_namespace WHERE nspname='public'),
 'default_acl',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_default_acl d),
 'membership',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor) FROM pg_auth_members m)
)::text)) AND state IN ('open','closed')),false)::text FROM rr_v2_control.state),true);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.v2_pause_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $guard$
BEGIN
 IF TG_TABLE_NAME='card' THEN
  IF TG_OP<>'INSERT' AND to_jsonb(OLD)->>'claim_mode'='google_first_claim' THEN RAISE EXCEPTION 'V2 writes paused' USING ERRCODE='42501'; END IF;
  IF TG_OP<>'DELETE' AND to_jsonb(NEW)->>'claim_mode'='google_first_claim' THEN RAISE EXCEPTION 'V2 writes paused' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME IN ('card_activation','card_pin_attempts') THEN
  IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.card c WHERE c.card_code=OLD.card_code AND to_jsonb(c)->>'claim_mode'='google_first_claim') THEN RAISE EXCEPTION 'V2 writes paused' USING ERRCODE='42501'; END IF;
  IF TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM public.card c WHERE c.card_code=NEW.card_code AND to_jsonb(c)->>'claim_mode'='google_first_claim') THEN RAISE EXCEPTION 'V2 writes paused' USING ERRCODE='42501'; END IF;
 ELSE RAISE EXCEPTION 'V2 writes paused' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $guard$;
REVOKE ALL ON FUNCTION public.v2_pause_guard() FROM PUBLIC,anon,authenticated,service_role;
DO $pause$ DECLARE r record; tab text; BEGIN
 FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%') AND p.proname NOT IN ('buyer_list_cards','buyer_public_card_status','admin_list_v2_activation_cards') LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION '||r.signature||' FROM PUBLIC,anon,authenticated,service_role';
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['card','card_activation','card_pin_attempts','buyer_card_ownership','buyer_card_inventory','buyer_claim_limits','buyer_ownership_audit','buyer_activation_reset_audit'] LOOP
  IF to_regclass('public.'||tab) IS NULL THEN CONTINUE; END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS v2_pause_write ON public.%I',tab);
  IF tab IN ('card','card_activation','card_pin_attempts') THEN
   EXECUTE format('CREATE TRIGGER v2_pause_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.v2_pause_guard()',tab);
   EXECUTE format('REVOKE TRUNCATE,TRIGGER,MAINTAIN ON public.%I FROM PUBLIC,anon,authenticated,service_role',tab);
  ELSE
   EXECUTE format('CREATE TRIGGER v2_pause_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.v2_pause_guard()',tab);
   EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN ON public.%I FROM PUBLIC,anon,authenticated,service_role',tab);
  END IF;
 END LOOP;
 FOR r IN SELECT c.oid::regclass signature FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' AND c.relname LIKE 'buyer_%' LOOP
  EXECUTE 'REVOKE ALL ON SEQUENCE '||r.signature||' FROM PUBLIC,anon,authenticated,service_role';
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%') AND p.proname NOT IN ('buyer_list_cards','buyer_public_card_status','admin_list_v2_activation_cards') AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE'))) THEN
  RAISE EXCEPTION 'Effective RPC access remains open; inspect inherited grants';
 END IF;
END $pause$;DO $$ BEGIN IF to_regclass('rr_v2_control.state') IS NOT NULL THEN
 UPDATE rr_v2_control.state SET state=CASE WHEN current_setting('rr_v2_control.pause_verified',true)='true' THEN 'closed' ELSE 'review_required' END,fingerprint=(SELECT md5(jsonb_build_object(
 'relations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.relname) FROM (SELECT c.relname,c.relkind,c.relacl,c.reloptions,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','v','S'))t),
 'columns',(SELECT jsonb_agg(to_jsonb(t) ORDER BY table_name,ordinal_position) FROM information_schema.columns t WHERE table_schema='public'),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_functiondef(p.oid),p.proacl) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.conname,pg_get_constraintdef(c.oid)) ORDER BY c.conname) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='public'),
 'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname,c.relname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal),
 'views',(SELECT jsonb_agg(jsonb_build_array(c.relname,pg_get_viewdef(c.oid,true)) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v'),
 'column_acl',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.attacl) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped),
 'owners',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','v','S')),
 'schema_acl',(SELECT jsonb_build_array(nspowner,nspacl) FROM pg_namespace WHERE nspname='public'),
 'default_acl',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_default_acl d),
 'membership',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor) FROM pg_auth_members m)
)::text));
END IF; END $$; COMMIT;
