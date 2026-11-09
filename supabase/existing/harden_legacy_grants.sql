-- Prepared only. Separate approval required on existing project.
-- Preserve anon column SELECT and service-role legacy DML/sequence access.
BEGIN;
SET LOCAL lock_timeout='3s';
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON public.card,public.card_activation,public.card_pin_attempts FROM PUBLIC,anon,authenticated;
REVOKE TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON public.card,public.card_activation,public.card_pin_attempts FROM service_role;
REVOKE ALL ON SEQUENCE public.card_id_seq FROM PUBLIC,anon,authenticated;
REVOKE UPDATE ON SEQUENCE public.card_id_seq FROM service_role;
-- security_invoker view has no supported application write contract.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.card_public FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
