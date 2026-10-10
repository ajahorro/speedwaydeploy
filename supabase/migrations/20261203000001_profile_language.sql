-- Each account chooses its language (English or Filipino/Tagalog). It is asked once, right after the terms are
-- accepted (language is null until then), and can be changed any time in Settings.
alter table public.profiles add column if not exists language text;
alter table public.profiles drop constraint if exists profiles_language_check;
alter table public.profiles add constraint profiles_language_check check (language is null or language in ('en', 'tl'));

create or replace function public.set_my_language(p_language text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_language text := lower(btrim(coalesce(p_language, '')));
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if v_language not in ('en', 'tl') then raise exception 'The language must be English (en) or Filipino (tl).' using errcode = '22023'; end if;
  update public.profiles set language = v_language where id = auth.uid();
  return v_language;
end;
$$;
revoke all on function public.set_my_language(text) from public, anon;
grant execute on function public.set_my_language(text) to authenticated;
