-- Opaque slugs: replace the readable/enumerable slugs introduced by
-- 20260918000000_resource_slugs with unpredictable 12-char base36 tokens
-- (~62 bits) for User, Course, BunnyVideo and Quiz. Data-only migration.
--
-- Each row keeps its unique slug; the loop re-rolls on any collision.

CREATE OR REPLACE FUNCTION _opaque_slug_random_base36(len integer)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  chars text := '0123456789abcdefghijklmnopqrstuvwxyz';
  out text := '';
  i integer;
  v integer;
BEGIN
  FOR i IN 1..len LOOP
    LOOP
      v := get_byte(gen_random_bytes(1), 0);
      EXIT WHEN v < 252; -- 252 = 7 * 36, keeps byte→char mapping uniform
    END LOOP;
    out := out || substr(chars, (v % 36) + 1, 1);
  END LOOP;
  RETURN out;
END;
$$;

DO $$
DECLARE
  r record;
  new_slug text;
BEGIN
  FOR r IN SELECT id FROM "Course" ORDER BY id LOOP
    LOOP
      new_slug := _opaque_slug_random_base36(12);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "Course" WHERE "slug" = new_slug);
    END LOOP;
    UPDATE "Course" SET "slug" = new_slug WHERE "id" = r.id;
  END LOOP;

  FOR r IN SELECT id FROM "BunnyVideo" ORDER BY id LOOP
    LOOP
      new_slug := _opaque_slug_random_base36(12);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "BunnyVideo" WHERE "slug" = new_slug);
    END LOOP;
    UPDATE "BunnyVideo" SET "slug" = new_slug WHERE "id" = r.id;
  END LOOP;

  FOR r IN SELECT id FROM "Quiz" ORDER BY id LOOP
    LOOP
      new_slug := _opaque_slug_random_base36(12);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "Quiz" WHERE "slug" = new_slug);
    END LOOP;
    UPDATE "Quiz" SET "slug" = new_slug WHERE "id" = r.id;
  END LOOP;

  FOR r IN SELECT id FROM "User" ORDER BY id LOOP
    LOOP
      new_slug := _opaque_slug_random_base36(12);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "User" WHERE "slug" = new_slug);
    END LOOP;
    UPDATE "User" SET "slug" = new_slug WHERE "id" = r.id;
  END LOOP;
END;
$$;

DROP FUNCTION _opaque_slug_random_base36(integer);