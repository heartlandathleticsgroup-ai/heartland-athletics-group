-- Independent CMS release. Apply only after review; no Gmail/auth changes.
begin;
create table hag_private.hag_cms_items (
 id uuid primary key default gen_random_uuid(),
 kind text not null check (kind in ('news','event','sponsor')),
 draft jsonb not null,
 revision integer not null default 1 check (revision > 0),
 updated_at timestamptz not null default now(),
 updated_by uuid not null
);
alter table hag_private.hag_cms_items enable row level security;
revoke all on hag_private.hag_cms_items from public,anon,authenticated,service_role;
create index hag_cms_items_kind_idx on hag_private.hag_cms_items(kind,updated_at desc);
-- Public snapshot contains only reviewed public fields. No user IDs, drafts or financial records.
create table public.hag_cms_publications (
 id uuid primary key references hag_private.hag_cms_items(id) on delete restrict,
 kind text not null check (kind in ('news','event','sponsor')),
 content jsonb not null,
 published_revision integer not null,
 published_at timestamptz not null default now()
);
alter table public.hag_cms_publications enable row level security;
revoke all on public.hag_cms_publications from public,anon,authenticated,service_role;
grant select on public.hag_cms_publications to anon,authenticated;
create policy hag_cms_public_read on public.hag_cms_publications for select to anon,authenticated using (true);
create index hag_cms_publications_kind_idx on public.hag_cms_publications(kind,published_at desc);
create table hag_private.hag_cms_audit (
 id bigint generated always as identity primary key,
 item_id uuid not null references hag_private.hag_cms_items(id),
 actor uuid not null,
 action text not null check(action in ('save','publish','unpublish')),
 revision integer not null,
 occurred_at timestamptz not null default now()
);
alter table hag_private.hag_cms_audit enable row level security;
revoke all on hag_private.hag_cms_audit from public,anon,authenticated,service_role;
create index hag_cms_audit_item_idx on hag_private.hag_cms_audit(item_id,occurred_at desc);
create function hag_private.hag_cms_guard() returns void language plpgsql stable set search_path='' as $$
begin
 if auth.uid() is null or hag_private.admin_session_state() is distinct from 'authorized' then
  raise exception 'Administrative access required' using errcode='42501';
 end if;
end $$;
create function hag_private.hag_cms_validate(k text,d jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare t text; b text; l text; i text; dt text; loc text; approved boolean;
begin
 if k is null or k not in ('news','event','sponsor') or jsonb_typeof(d) is distinct from 'object' or octet_length(d::text)>22000 then raise exception 'Invalid content'; end if;
 if exists(select 1 from jsonb_object_keys(d) x where x not in ('title','body','url','image','date','location','permission')) then raise exception 'Unsupported field'; end if;
 if exists(select 1 from jsonb_each(d) x where (x.key='permission' and jsonb_typeof(x.value)<>'boolean') or (x.key<>'permission' and jsonb_typeof(x.value)<>'string')) then raise exception 'Invalid field type'; end if;
 t:=btrim(coalesce(d->>'title','')); b:=btrim(coalesce(d->>'body','')); l:=btrim(coalesce(d->>'url','')); i:=btrim(coalesce(d->>'image','')); dt:=coalesce(d->>'date',''); loc:=btrim(coalesce(d->>'location','')); approved:=coalesce((d->>'permission')::boolean,false);
 if char_length(t) not between 1 and 140 or char_length(b)>4000 or char_length(loc)>200 or char_length(l)>500 or char_length(i)>300 then raise exception 'Field length invalid'; end if;
 if l<>'' and l !~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(/[A-Za-z0-9._~:/?&=%+@!$(),;-]*)?(\?[A-Za-z0-9._~:/?&=%+@!$(),;-]*)?(#[A-Za-z0-9._~:/?&=%+@!$(),;-]*)?$' then raise exception 'Use a valid HTTPS link'; end if;
 if i<>'' and (i !~ '^/assets/[A-Za-z0-9_./-]+\.(png|jpg|jpeg|webp|avif|gif)$' or i ~ '(^|/)\.\.?(/|$)' or i ~ '//') then raise exception 'Use an existing local raster image'; end if;
 if k='event' then
  if dt !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Event date required'; end if;
  perform dt::date;
 else dt:=''; loc:=''; end if;
 return jsonb_build_object('title',t,'body',b,'url',l,'image',i,'date',dt,'location',loc,'permission',case when k='sponsor' then approved else false end);
end $$;
create function hag_private.hag_cms_list() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform hag_private.hag_cms_guard();
 return coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'draft',i.draft,'revision',i.revision,'updated_at',i.updated_at,'published_revision',p.published_revision) order by i.updated_at desc,i.id) from hag_private.hag_cms_items i left join public.hag_cms_publications p on p.id=i.id),'[]'::jsonb);
end $$;
create function hag_private.hag_cms_change(a text,k text,item uuid,expected integer,d jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare rec hag_private.hag_cms_items%rowtype; validated jsonb; pubrev integer;
begin
 perform hag_private.hag_cms_guard();
 if a is null or a not in ('save','publish','unpublish') or k is null or k not in ('news','event','sponsor') then raise exception 'Invalid action'; end if;
 if item is null then
  if a<>'save' or expected is distinct from 0 then raise exception 'Invalid new item'; end if;
  validated:=hag_private.hag_cms_validate(k,d);
  perform pg_advisory_xact_lock(38101,case k when 'news' then 1 when 'event' then 2 else 3 end);
  if (select count(*) from hag_private.hag_cms_items where kind=k)>=200 then raise exception 'Content limit reached'; end if;
  insert into hag_private.hag_cms_items(kind,draft,updated_by) values(k,validated,auth.uid()) returning * into rec;
 else
  select * into rec from hag_private.hag_cms_items where id=item and kind=k for update;
  if not found or expected is distinct from rec.revision then raise exception 'Content changed. Refresh and try again.' using errcode='40001'; end if;
  if a='save' then
   validated:=hag_private.hag_cms_validate(k,d);
   update hag_private.hag_cms_items set draft=validated,revision=revision+1,updated_at=now(),updated_by=auth.uid() where id=item returning * into rec;
  elsif a='publish' then
   validated:=hag_private.hag_cms_validate(k,rec.draft);
   if k='sponsor' and not (validated->>'permission')::boolean then raise exception 'Sponsor permission required'; end if;
   insert into public.hag_cms_publications(id,kind,content,published_revision) values(rec.id,k,validated-'permission',rec.revision)
   on conflict(id) do update set content=excluded.content,published_revision=excluded.published_revision,published_at=now();
  else
   delete from public.hag_cms_publications where id=item;
  end if;
 end if;
 insert into hag_private.hag_cms_audit(item_id,actor,action,revision) values(rec.id,auth.uid(),a,rec.revision);
 select published_revision into pubrev from public.hag_cms_publications where id=rec.id;
 return jsonb_build_object('id',rec.id,'kind',rec.kind,'draft',rec.draft,'revision',rec.revision,'updated_at',rec.updated_at,'published_revision',pubrev);
end $$;
-- Explicit private execution permissions; public wrappers are invoker-only.
revoke all on function hag_private.hag_cms_guard(),hag_private.hag_cms_validate(text,jsonb),hag_private.hag_cms_list(),hag_private.hag_cms_change(text,text,uuid,integer,jsonb) from public,anon,authenticated,service_role;
grant execute on function hag_private.hag_cms_list(),hag_private.hag_cms_change(text,text,uuid,integer,jsonb) to authenticated;
create function public.hag_cms_list() returns jsonb language sql stable security invoker set search_path='' as $$ select hag_private.hag_cms_list() $$;
create function public.hag_cms_change(p_action text,p_kind text,p_id uuid,p_revision integer,p_draft jsonb) returns jsonb language sql security invoker set search_path='' as $$ select hag_private.hag_cms_change(p_action,p_kind,p_id,p_revision,p_draft) $$;
revoke all on function public.hag_cms_list(),public.hag_cms_change(text,text,uuid,integer,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.hag_cms_list(),public.hag_cms_change(text,text,uuid,integer,jsonb) to authenticated;
commit;
