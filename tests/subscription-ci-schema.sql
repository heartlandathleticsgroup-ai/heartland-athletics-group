-- Isolated CI schema: six tables' column and constraint metadata only, no production records.
create schema hag_private;
create schema extensions;
create extension pgcrypto with schema extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table hag_private.hag_consent_events (
 id uuid default gen_random_uuid() not null,
 subscription_id uuid not null,
 event_kind text not null,
 consent_version text not null,
 consent_text text not null,
 source text not null,
 occurred_at timestamp with time zone default now() not null,
 channel text not null
);
create table hag_private.hag_contact_methods (
 id uuid default gen_random_uuid() not null,
 contact_id uuid not null,
 channel text not null,
 destination text not null,
 verified_at timestamp with time zone,
 created_at timestamp with time zone default now() not null
);
create table hag_private.hag_contacts (
 id uuid default gen_random_uuid() not null,
 display_name text not null,
 adult_confirmed boolean default false not null,
 created_at timestamp with time zone default now() not null
);
create table hag_private.hag_subscriptions (
 id uuid default gen_random_uuid() not null,
 contact_method_id uuid not null,
 channel text not null,
 topic_code text not null,
 topic_purpose text generated always as ('subscription'::text) stored,
 status text default 'pending'::text not null,
 confirmation_event_id uuid,
 confirmation_event_kind text generated always as ('confirmed'::text) stored,
 created_at timestamp with time zone default now() not null
);
create table hag_private.hag_suppressions (
 id uuid default gen_random_uuid() not null,
 contact_method_id uuid not null,
 reason text not null,
 active boolean default true not null,
 created_at timestamp with time zone default now() not null
);
create table hag_private.hag_topics (
 code text not null,
 label text not null,
 purpose text not null,
 active boolean default true not null
);
alter table hag_private.hag_consent_events add constraint "hag_consent_events_channel_check" CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text])));
alter table hag_private.hag_consent_events add constraint "hag_consent_events_check" CHECK (((event_kind <> 'confirmed'::text) OR (source = ANY (ARRAY['email_confirmation'::text, 'sms_confirmation'::text]))));
alter table hag_private.hag_consent_events add constraint "hag_consent_events_consent_text_check" CHECK (((char_length(btrim(consent_text)) >= 1) AND (char_length(btrim(consent_text)) <= 4000)));
alter table hag_private.hag_consent_events add constraint "hag_consent_events_consent_version_check" CHECK (((char_length(btrim(consent_version)) >= 1) AND (char_length(btrim(consent_version)) <= 80)));
alter table hag_private.hag_consent_events add constraint "hag_consent_events_event_kind_check" CHECK ((event_kind = ANY (ARRAY['requested'::text, 'confirmed'::text, 'withdrawn'::text])));
alter table hag_private.hag_consent_events add constraint "hag_consent_events_source_check" CHECK ((source = ANY (ARRAY['website'::text, 'email_confirmation'::text, 'sms_confirmation'::text, 'unsubscribe'::text, 'provider_stop'::text, 'manual_revocation'::text])));
alter table hag_private.hag_consent_events add constraint "hag_consent_source_channel_check" CHECK ((((event_kind = 'requested'::text) AND (source = 'website'::text)) OR ((event_kind = 'confirmed'::text) AND (((channel = 'email'::text) AND (source = 'email_confirmation'::text)) OR ((channel = 'sms'::text) AND (source = 'sms_confirmation'::text)))) OR ((event_kind = 'withdrawn'::text) AND ((source = ANY (ARRAY['unsubscribe'::text, 'manual_revocation'::text])) OR ((channel = 'sms'::text) AND (source = 'provider_stop'::text))))));
alter table hag_private.hag_contact_methods add constraint "hag_contact_methods_channel_check" CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text])));
alter table hag_private.hag_contact_methods add constraint "hag_contact_methods_check" CHECK ((((channel = 'email'::text) AND (destination = lower(btrim(destination))) AND (char_length(destination) <= 254) AND (destination ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'::text)) OR ((channel = 'sms'::text) AND (destination ~ '^[+][1-9][0-9]{7,14}$'::text))));
alter table hag_private.hag_contacts add constraint "hag_contacts_display_name_check" CHECK (((char_length(btrim(display_name)) >= 1) AND (char_length(btrim(display_name)) <= 120)));
alter table hag_private.hag_subscriptions add constraint "hag_subscriptions_channel_check" CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text])));
alter table hag_private.hag_subscriptions add constraint "hag_subscriptions_check" CHECK (((status <> 'active'::text) OR (confirmation_event_id IS NOT NULL)));
alter table hag_private.hag_subscriptions add constraint "hag_subscriptions_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'withdrawn'::text])));
alter table hag_private.hag_suppressions add constraint "hag_suppressions_reason_check" CHECK ((reason = ANY (ARRAY['unsubscribe'::text, 'stop'::text, 'bounce'::text, 'complaint'::text, 'manual'::text])));
alter table hag_private.hag_topics add constraint "hag_topics_code_check" CHECK ((code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text));
alter table hag_private.hag_topics add constraint "hag_topics_label_check" CHECK (((char_length(label) >= 1) AND (char_length(label) <= 160)));
alter table hag_private.hag_topics add constraint "hag_topics_purpose_check" CHECK ((purpose = ANY (ARRAY['inquiry'::text, 'subscription'::text])));
alter table hag_private.hag_consent_events add constraint "hag_consent_events_pkey" PRIMARY KEY (id);
alter table hag_private.hag_contact_methods add constraint "hag_contact_methods_pkey" PRIMARY KEY (id);
alter table hag_private.hag_contacts add constraint "hag_contacts_pkey" PRIMARY KEY (id);
alter table hag_private.hag_subscriptions add constraint "hag_subscriptions_pkey" PRIMARY KEY (id);
alter table hag_private.hag_suppressions add constraint "hag_suppressions_pkey" PRIMARY KEY (id);
alter table hag_private.hag_topics add constraint "hag_topics_pkey" PRIMARY KEY (code);
alter table hag_private.hag_consent_events add constraint "hag_consent_events_id_subscription_id_event_kind_key" UNIQUE (id, subscription_id, event_kind);
alter table hag_private.hag_contact_methods add constraint "hag_contact_methods_channel_destination_key" UNIQUE (channel, destination);
alter table hag_private.hag_contact_methods add constraint "hag_contact_methods_id_channel_key" UNIQUE (id, channel);
alter table hag_private.hag_subscriptions add constraint "hag_subscriptions_contact_method_id_topic_code_key" UNIQUE (contact_method_id, topic_code);
alter table hag_private.hag_subscriptions add constraint "hag_subscriptions_id_channel_key" UNIQUE (id, channel);
alter table hag_private.hag_subscriptions add constraint "hag_subscriptions_id_topic_code_channel_key" UNIQUE (id, topic_code, channel);
alter table hag_private.hag_suppressions add constraint "hag_suppressions_contact_method_id_reason_key" UNIQUE (contact_method_id, reason);
alter table hag_private.hag_topics add constraint "hag_topics_code_purpose_key" UNIQUE (code, purpose);
alter table hag_private.hag_consent_events add constraint "hag_consent_event_channel_fk" FOREIGN KEY (subscription_id, channel) REFERENCES hag_private.hag_subscriptions(id, channel);
alter table hag_private.hag_consent_events add constraint "hag_consent_events_subscription_id_fkey" FOREIGN KEY (subscription_id) REFERENCES hag_private.hag_subscriptions(id) ON DELETE RESTRICT;
alter table hag_private.hag_contact_methods add constraint "hag_contact_methods_contact_id_fkey" FOREIGN KEY (contact_id) REFERENCES hag_private.hag_contacts(id) ON DELETE RESTRICT;
alter table hag_private.hag_subscriptions add constraint "hag_subscriptions_contact_method_id_channel_fkey" FOREIGN KEY (contact_method_id, channel) REFERENCES hag_private.hag_contact_methods(id, channel);
alter table hag_private.hag_subscriptions add constraint "hag_subscriptions_topic_code_topic_purpose_fkey" FOREIGN KEY (topic_code, topic_purpose) REFERENCES hag_private.hag_topics(code, purpose);
alter table hag_private.hag_subscriptions add constraint "subscription_confirmation_fk" FOREIGN KEY (confirmation_event_id, id, confirmation_event_kind) REFERENCES hag_private.hag_consent_events(id, subscription_id, event_kind);
alter table hag_private.hag_suppressions add constraint "hag_suppressions_contact_method_id_fkey" FOREIGN KEY (contact_method_id) REFERENCES hag_private.hag_contact_methods(id) ON DELETE RESTRICT;
alter table hag_private.hag_consent_events enable row level security;
alter table hag_private.hag_consent_events force row level security;
revoke all on hag_private.hag_consent_events from public,anon,authenticated,service_role;
alter table hag_private.hag_contact_methods enable row level security;
alter table hag_private.hag_contact_methods force row level security;
revoke all on hag_private.hag_contact_methods from public,anon,authenticated,service_role;
alter table hag_private.hag_contacts enable row level security;
alter table hag_private.hag_contacts force row level security;
revoke all on hag_private.hag_contacts from public,anon,authenticated,service_role;
alter table hag_private.hag_subscriptions enable row level security;
alter table hag_private.hag_subscriptions force row level security;
revoke all on hag_private.hag_subscriptions from public,anon,authenticated,service_role;
alter table hag_private.hag_suppressions enable row level security;
alter table hag_private.hag_suppressions force row level security;
revoke all on hag_private.hag_suppressions from public,anon,authenticated,service_role;
alter table hag_private.hag_topics enable row level security;
alter table hag_private.hag_topics force row level security;
revoke all on hag_private.hag_topics from public,anon,authenticated,service_role;
grant usage on schema hag_private to service_role;
insert into hag_private.hag_topics(code,label,purpose,active) values('camps-clinics','Camps and clinics','subscription',true);
insert into hag_private.hag_topics(code,label,purpose,active) values('enforcers-tryouts','Upcoming tryouts','subscription',true);
insert into hag_private.hag_topics(code,label,purpose,active) values('enforcers-updates','Heartland Enforcers Basketball Club','subscription',true);
insert into hag_private.hag_topics(code,label,purpose,active) values('gus-macker-local','Gus Macker - Quincy local event updates','subscription',true);
insert into hag_private.hag_topics(code,label,purpose,active) values('gus-macker-registration','Gus Macker - Quincy registration opening','subscription',true);
insert into hag_private.hag_topics(code,label,purpose,active) values('hag-announcements','General H.A.G. announcements','subscription',true);
insert into hag_private.hag_topics(code,label,purpose,active) values('sponsorship-updates','Sponsorship opportunities','subscription',true);
insert into hag_private.hag_topics(code,label,purpose,active) values('tournaments-events','Tournaments and events','subscription',true);
insert into hag_private.hag_topics(code,label,purpose,active) values('volunteer-updates','Volunteer opportunities','subscription',true);
