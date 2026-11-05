-- Business Hub › About & Map: photos (with captions and a layout) for the landing page's About section, and the
-- shop's map pin. Services no longer carry photos.
--
-- Security, in layers:
--   1. Writes come only from the backend (service role). A trigger rejects any change to these columns made with an
--      ordinary signed-in session, even an administrator's, so the browser cannot write them directly.
--   2. The backend checks the administrator, re-encodes every upload (which strips metadata and anything hidden in the
--      file), names files itself and rate-limits uploads.
--   3. This file validates the stored values as a last line: photo URLs must point at our own public bucket with a
--      server-made file name, captions are short plain text, the layout is one of four, the pin is a real coordinate.
--   4. The site-photos bucket accepts only WebP up to 3 MB and has no upload policy for browsers.

alter table public.business_config
  add column if not exists about_photos jsonb not null default '[]'::jsonb,
  add column if not exists about_layout text not null default 'mosaic',
  add column if not exists shop_location jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_config_about_layout_check') then
    alter table public.business_config add constraint business_config_about_layout_check
      check (about_layout in ('mosaic', 'carousel', 'grid', 'split'));
  end if;
end $$;

create or replace function public.validate_site_content()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_photo jsonb;
  v_caption text;
  v_lat numeric;
  v_lng numeric;
  v_zoom numeric;
begin
  -- 1. only the backend may change these columns
  if (tg_op = 'INSERT' and (new.about_photos <> '[]'::jsonb or new.shop_location is not null))
     or (tg_op = 'UPDATE' and (new.about_photos is distinct from old.about_photos
                               or new.about_layout is distinct from old.about_layout
                               or new.shop_location is distinct from old.shop_location)) then
    if current_user not in ('service_role', 'postgres', 'supabase_admin') then
      raise exception 'About photos and the map pin can only be changed through the Business Hub.' using errcode = '42501';
    end if;
  end if;

  -- 3. shape checks
  if jsonb_typeof(new.about_photos) <> 'array' then
    raise exception 'about_photos must be a list' using errcode = '23514';
  end if;
  if jsonb_array_length(new.about_photos) > 12 then
    raise exception 'At most 12 About photos' using errcode = '23514';
  end if;
  for v_photo in select value from jsonb_array_elements(new.about_photos) loop
    if jsonb_typeof(v_photo) <> 'object'
       or coalesce(v_photo->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(v_photo->>'url', '') !~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/site-photos/' || (v_photo->>'id') || '\.webp$') then
      raise exception 'An About photo is not valid' using errcode = '23514';
    end if;
    v_caption := coalesce(v_photo->>'caption', '');
    if char_length(v_caption) > 140 or v_caption ~ '[<>\x00-\x08\x0B\x0C\x0E-\x1F]' then
      raise exception 'A photo caption is too long or has characters that are not allowed' using errcode = '23514';
    end if;
  end loop;

  if new.shop_location is not null then
    begin
      v_lat := (new.shop_location->>'lat')::numeric;
      v_lng := (new.shop_location->>'lng')::numeric;
      v_zoom := coalesce((new.shop_location->>'zoom')::numeric, 16);
    exception when others then
      raise exception 'The map pin is not valid' using errcode = '23514';
    end;
    if v_lat is null or v_lng is null or v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180 or v_zoom < 3 or v_zoom > 19
       or char_length(coalesce(new.shop_location->>'label', '')) > 120
       or coalesce(new.shop_location->>'label', '') ~ '[<>\x00-\x1F]' then
      raise exception 'The map pin is not valid' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_site_content on public.business_config;
create trigger trg_validate_site_content
  before insert or update on public.business_config
  for each row execute function public.validate_site_content();

-- 4. the bucket: public to read (the landing page shows these), WebP only, 3 MB, no browser upload policy
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-photos', 'site-photos', true, 3145728, array['image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/webp'];
