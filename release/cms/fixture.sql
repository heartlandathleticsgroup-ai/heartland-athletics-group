-- Disposable CI database only. Simulated existing access gate; no real user records.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create schema hag_private;
grant usage on schema auth,hag_private to authenticated;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
create function hag_private.admin_session_state() returns text language sql stable as $$ select current_setting('test.state',true) $$;
