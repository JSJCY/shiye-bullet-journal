-- PostgreSQL storage for journal aggregates. No existing tables or user data are modified.
CREATE TABLE IF NOT EXISTS public.shiye_documents (
 collection text NOT NULL CHECK (collection IN ('records','history','change_log','sync_meta','sync_ops','widget_tokens')),
 doc_id text NOT NULL,
 owner_id text NOT NULL,
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND payload->>'ownerId'=owner_id),
 version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(collection,doc_id)
);
CREATE INDEX IF NOT EXISTS shiye_owner_documents ON public.shiye_documents(collection,owner_id,doc_id);
ALTER TABLE public.shiye_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shiye_documents FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.shiye_documents TO authenticated;
GRANT ALL ON public.shiye_documents TO service_role;
DROP POLICY IF EXISTS shiye_meta_owner_read ON public.shiye_documents;
CREATE POLICY shiye_meta_owner_read ON public.shiye_documents FOR SELECT TO authenticated
 USING(collection='sync_meta' AND owner_id=auth.uid());

CREATE OR REPLACE FUNCTION public.shiye_store(p_action text,p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $body$
DECLARE item jsonb; row_value jsonb; row_version bigint; lock_key text; result jsonb;
BEGIN
 -- An endpoint or EXECUTE grant alone is not an authorization boundary.
 IF coalesce(auth.role(),current_user::text,'') <> 'service_role' THEN
  RAISE EXCEPTION 'Journal storage requires server role' USING ERRCODE='42501';
 END IF;
 IF p_action='get' THEN
  SELECT jsonb_build_object('value',payload,'version',version) INTO result
   FROM public.shiye_documents WHERE collection=p_args->>'collection' AND doc_id=p_args->>'id';
  RETURN result;
 ELSIF p_action='list' THEN
  SELECT coalesce(jsonb_agg(payload),'[]'::jsonb) INTO result FROM
   (SELECT payload FROM public.shiye_documents
    WHERE collection=p_args->>'collection' AND owner_id=p_args->>'ownerId'
    ORDER BY doc_id LIMIT 100 OFFSET greatest(0,coalesce((p_args->>'offset')::integer,0))) AS page;
  RETURN result;
 ELSIF p_action='commit' THEN
  -- Lock read and write identities in one fixed order, including currently absent rows.
  FOR lock_key IN
   SELECT DISTINCT x->>'collection'||'|'||(x->>'id') FROM
    jsonb_array_elements(coalesce(p_args->'reads','[]'::jsonb)||coalesce(p_args->'writes','[]'::jsonb)) x
    ORDER BY 1
  LOOP PERFORM pg_advisory_xact_lock(hashtextextended('shiye:'||lock_key,0)); END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_args->'reads') LOOP
   SELECT version INTO row_version FROM public.shiye_documents
    WHERE collection=item->>'collection' AND doc_id=item->>'id';
   IF coalesce(row_version,0) <> (item->>'version')::bigint THEN RETURN 'false'::jsonb; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_args->'writes') LOOP
   row_value=item->'value';
   INSERT INTO public.shiye_documents(collection,doc_id,owner_id,payload)
    VALUES(item->>'collection',item->>'id',row_value->>'ownerId',row_value)
    ON CONFLICT(collection,doc_id) DO UPDATE
     SET owner_id=excluded.owner_id,payload=excluded.payload,version=shiye_documents.version+1;
  END LOOP;
  RETURN 'true'::jsonb;
 END IF;
 RAISE EXCEPTION 'Unknown journal storage action' USING ERRCODE='22023';
END;
$body$;
REVOKE EXECUTE ON FUNCTION public.shiye_store(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.shiye_store(text,jsonb) TO service_role;
