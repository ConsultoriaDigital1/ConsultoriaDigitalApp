CREATE TABLE IF NOT EXISTS card_audit_log (
  id BIGSERIAL PRIMARY KEY,
  card_id TEXT NOT NULL,
  card_name TEXT NOT NULL,
  teams TEXT[] NOT NULL,
  action TEXT NOT NULL,
  actor JSONB NOT NULL,
  changes JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_card_audit_teams ON card_audit_log USING GIN (teams);
CREATE INDEX IF NOT EXISTS idx_card_audit_card ON card_audit_log (card_id, id DESC);

-- No FK a cards/users: el historial sobrevive a la eliminación de ambos.
CREATE OR REPLACE FUNCTION card_audit_snapshot(value JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  SELECT (value - ARRAY['id','created_at','updated_at','creado_por','creado_en','cover_image','banner_image','attachments'])
    || jsonb_build_object(
      'cover_image', jsonb_build_object('present', coalesce(value->>'cover_image','') <> '', 'fingerprint', md5(coalesce(value->>'cover_image',''))),
      'banner_image', jsonb_build_object('present', coalesce(value->>'banner_image','') <> '', 'fingerprint', md5(coalesce(value->>'banner_image',''))),
      'attachments', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', item->'id', 'name', item->'name', 'type', item->'type', 'size', item->'size',
        'fingerprint', md5(coalesce(item->>'data',''))))
        FROM jsonb_array_elements(coalesce(value->'attachments','[]'::jsonb)) item), '[]'::jsonb)
    );
$$;

CREATE OR REPLACE FUNCTION record_card_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous JSONB := '{}'::jsonb;
  following JSONB := '{}'::jsonb;
  delta JSONB;
  row_data JSONB;
  actor_data JSONB;
  action_name TEXT;
  visible_teams TEXT[];
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := card_audit_snapshot(to_jsonb(OLD)); END IF;
  IF TG_OP <> 'DELETE' THEN following := card_audit_snapshot(to_jsonb(NEW)); END IF;
  SELECT coalesce(jsonb_object_agg(key, jsonb_build_object('before', previous->key, 'after', following->key)), '{}'::jsonb)
    INTO delta FROM (SELECT jsonb_object_keys(previous || following) AS key) keys
    WHERE previous->key IS DISTINCT FROM following->key;
  IF delta = '{}'::jsonb THEN RETURN NULL; END IF;
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  SELECT ARRAY(SELECT DISTINCT team FROM unnest(ARRAY[previous->>'equipo', following->>'equipo']) team WHERE team IS NOT NULL) INTO visible_teams;
  actor_data := coalesce(nullif(current_setting('app.card_audit_actor', true), '')::jsonb,
    jsonb_build_object('id', NULL, 'name', 'Sistema', 'username', '', 'source', 'system'));
  action_name := CASE
    WHEN TG_OP = 'INSERT' THEN 'create'
    WHEN TG_OP = 'DELETE' THEN 'delete'
    WHEN previous->>'deleted_at' IS NULL AND following->>'deleted_at' IS NOT NULL THEN 'trash'
    WHEN previous->>'deleted_at' IS NOT NULL AND following->>'deleted_at' IS NULL THEN 'restore'
    WHEN delta ? 'estado' OR delta ? 'equipo' THEN 'move'
    WHEN (delta - 'position') = '{}'::jsonb THEN 'reorder'
    ELSE 'edit' END;
  INSERT INTO card_audit_log (card_id, card_name, teams, action, actor, changes)
    VALUES (row_data->>'id', coalesce(nullif(row_data->>'nf',''), nullif(row_data->>'rs',''), 'Sin nombre'), visible_teams, action_name, actor_data, delta);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS cards_audit_trigger ON cards;
CREATE TRIGGER cards_audit_trigger AFTER INSERT OR UPDATE OR DELETE ON cards
FOR EACH ROW EXECUTE FUNCTION record_card_audit();

CREATE OR REPLACE FUNCTION record_card_comment_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE card_row cards; actor_data JSONB;
BEGIN
  IF NEW.kind <> 'comentario' THEN RETURN NULL; END IF;
  SELECT * INTO card_row FROM cards WHERE id = NEW.card_id;
  actor_data := coalesce(nullif(current_setting('app.card_audit_actor', true), '')::jsonb,
    (SELECT jsonb_build_object('id', u.id, 'name', trim(u.nombre || ' ' || u.apellido), 'username', u.username, 'source', 'user') FROM users u WHERE u.id = NEW.user_id),
    jsonb_build_object('id', NULL, 'name', 'Sistema', 'username', '', 'source', 'system'));
  INSERT INTO card_audit_log (card_id, card_name, teams, action, actor, changes)
    VALUES (NEW.card_id, coalesce(nullif(card_row.nf,''), nullif(card_row.rs,''), 'Sin nombre'), ARRAY[card_row.equipo], 'comment', actor_data,
      jsonb_build_object('comentario', jsonb_build_object('before', NULL, 'after', NEW.description)));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS card_comments_audit_trigger ON card_description_history;
CREATE TRIGGER card_comments_audit_trigger AFTER INSERT ON card_description_history
FOR EACH ROW EXECUTE FUNCTION record_card_comment_audit();
