-- Business Hub › About & Map, part 2: the landing page's top-banner photo, the About heading and paragraph, and the
-- About highlight cards (up to 4, each an icon from a fixed set, a short title and a short line).
-- Same protection as the About photos (20261225000001): only the backend may change these columns, and every value is
-- checked here as a last line (banner photo must be a server-made file in our own bucket, plain short texts, known icons).

alter table public.business_config
  add column if not exists hero_photo jsonb,
  add column if not exists about_heading text,
  add column if not exists about_body text,
  add column if not exists about_cards jsonb;

create or replace function public.validate_site_content()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_photo jsonb;
  v_card jsonb;
  v_caption text;
  v_lat numeric;
  v_lng numeric;
  v_zoom numeric;
  v_url_re text := '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/site-photos/';
begin
  -- 1. only the backend may change these columns
  if (tg_op = 'INSERT' and (new.about_photos <> '[]'::jsonb or new.shop_location is not null or new.hero_photo is not null
                            or new.about_heading is not null or new.about_body is not null or new.about_cards is not null))
     or (tg_op = 'UPDATE' and (new.about_photos is distinct from old.about_photos
                               or new.about_layout is distinct from old.about_layout
                               or new.shop_location is distinct from old.shop_location
                               or new.hero_photo is distinct from old.hero_photo
                               or new.about_heading is distinct from old.about_heading
                               or new.about_body is distinct from old.about_body
                               or new.about_cards is distinct from old.about_cards)) then
    if current_user not in ('service_role', 'postgres', 'supabase_admin') then
      raise exception 'About photos, texts and the map pin can only be changed through the Business Hub.' using errcode = '42501';
    end if;
  end if;

  -- 2. About photos
  if jsonb_typeof(new.about_photos) <> 'array' then
    raise exception 'about_photos must be a list' using errcode = '23514';
  end if;
  if jsonb_array_length(new.about_photos) > 12 then
    raise exception 'At most 12 About photos' using errcode = '23514';
  end if;
  for v_photo in select value from jsonb_array_elements(new.about_photos) loop
    if jsonb_typeof(v_photo) <> 'object'
       or coalesce(v_photo->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(v_photo->>'url', '') !~ (v_url_re || (v_photo->>'id') || '\.webp$') then
      raise exception 'An About photo is not valid' using errcode = '23514';
    end if;
    v_caption := coalesce(v_photo->>'caption', '');
    if char_length(v_caption) > 140 or v_caption ~ '[<>\x00-\x08\x0B\x0C\x0E-\x1F]' then
      raise exception 'A photo caption is too long or has characters that are not allowed' using errcode = '23514';
    end if;
  end loop;

  -- 3. banner photo
  if new.hero_photo is not null then
    if jsonb_typeof(new.hero_photo) <> 'object'
       or coalesce(new.hero_photo->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(new.hero_photo->>'url', '') !~ (v_url_re || (new.hero_photo->>'id') || '\.webp$') then
      raise exception 'The banner photo is not valid' using errcode = '23514';
    end if;
  end if;

  -- 4. About texts and cards
  if char_length(coalesce(new.about_heading, '')) > 80 or coalesce(new.about_heading, '') ~ '[<>\x00-\x1F]' then
    raise exception 'The About heading is too long or has characters that are not allowed' using errcode = '23514';
  end if;
  if char_length(coalesce(new.about_body, '')) > 1200 or coalesce(new.about_body, '') ~ '[<>\x00-\x08\x0B\x0C\x0E-\x1F]' then
    raise exception 'The About paragraph is too long or has characters that are not allowed' using errcode = '23514';
  end if;
  if new.about_cards is not null then
    if jsonb_typeof(new.about_cards) <> 'array' or jsonb_array_length(new.about_cards) > 4 then
      raise exception 'At most 4 About highlights' using errcode = '23514';
    end if;
    for v_card in select value from jsonb_array_elements(new.about_cards) loop
      if jsonb_typeof(v_card) <> 'object'
         or coalesce(v_card->>'icon', '') not in ('shield', 'zap', 'star', 'clock', 'sparkles', 'droplets', 'car', 'wrench', 'award', 'thumbs-up', 'badge-check', 'heart')
         or char_length(btrim(coalesce(v_card->>'title', ''))) not between 1 and 40
         or char_length(coalesce(v_card->>'text', '')) > 100
         or (coalesce(v_card->>'title', '') || coalesce(v_card->>'text', '')) ~ '[<>\x00-\x1F]' then
        raise exception 'An About highlight is not valid' using errcode = '23514';
      end if;
    end loop;
  end if;

  -- 5. map pin
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
