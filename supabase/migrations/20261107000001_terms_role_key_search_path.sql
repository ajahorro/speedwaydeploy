-- Security Advisor: pin the search_path of the terms helper added in 20261103000001.
alter function public.terms_role_key(text) set search_path = public;
