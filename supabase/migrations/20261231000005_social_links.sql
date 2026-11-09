-- Social media pages the admin links in the Business Hub (Business Profile). Shown as icons in the website footer.
-- A list of {platform, url}; the app keeps one link per platform and only links to that platform's own site.
alter table public.business_config add column if not exists social_links jsonb not null default '[]'::jsonb;
alter table public.business_config drop constraint if exists business_config_social_links_is_array;
alter table public.business_config add constraint business_config_social_links_is_array check (jsonb_typeof(social_links) = 'array');
