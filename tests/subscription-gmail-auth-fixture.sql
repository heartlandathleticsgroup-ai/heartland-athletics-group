-- Isolated CI metadata fixture; never run against production.
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create table auth.mfa_amr_claims(session_id uuid,created_at timestamptz,updated_at timestamptz,authentication_method text);
create table auth.webauthn_credentials(id uuid,user_id uuid);
create table hag_private.hag_verified_passkey_sessions(session_id uuid,user_id uuid,credential_id uuid,verified_at timestamptz);
create table hag_private.hag_approved_passkeys(credential_id uuid,user_id uuid,revoked_at timestamptz);
create function hag_private.admin_session_state() returns text language sql stable as $$ select coalesce(current_setting('hag.fixture.gate',true),'denied') $$;
grant usage on schema hag_private to authenticated;
