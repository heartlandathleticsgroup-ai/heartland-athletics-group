-- Bounded raster library: at most 100 images / 40 MiB decoded payload.
-- Public reads only when a published record references the image.
begin;
create table public.hag_cms_media (
 id uuid primary key default gen_random_uuid(),
 label text not null check(char_length(label) between 1 and 140),
 mime text not null check(mime in ('image/png','image/jpeg','image/webp')),
 payload text not null check(char_length(payload)<=546136),
 created_at timestamptz not null default now()
);
alter table public.hag_cms_media enable row level security;
alter table public.hag_cms_media force row level security;
revoke all on public.hag_cms_media from public,anon,authenticated,service_role;
grant select(id,payload,mime) on public.hag_cms_media to anon,authenticated;
create policy hag_cms_media_published_read on public.hag_cms_media for select to anon,authenticated using (
 exists(select 1 from public.hag_cms_publications p where p.content->>'image'='media:'||hag_cms_media.id::text)
);
create index hag_cms_publications_image_idx on public.hag_cms_publications((content->>'image'));
create function hag_private.hag_cms_media_list() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform hag_private.hag_cms_guard();
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label,'mime',mime,'created_at',created_at) order by created_at desc) from public.hag_cms_media),'[]'::jsonb);
end $$;
create function hag_private.hag_cms_media_get(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform hag_private.hag_cms_guard();
 return (select jsonb_build_object('id',id,'mime',mime,'payload',payload) from public.hag_cms_media where id=p_id);
end $$;
create function hag_private.hag_cms_media_add(p_label text,p_mime text,p_payload text) returns jsonb language plpgsql security definer set search_path='' as $$
declare b bytea; mid uuid; normalized text;
begin
 perform hag_private.hag_cms_guard();
 if p_label is null or char_length(btrim(p_label)) not between 1 and 140 or p_mime is null or p_mime not in ('image/png','image/jpeg','image/webp') or p_payload is null or char_length(p_payload)>546136 or p_payload !~ '^[A-Za-z0-9+/]+={0,2}$' then raise exception 'Invalid image'; end if;
 b:=decode(p_payload,'base64');
 if octet_length(b) not between 20 and 409600 then raise exception 'Image exceeds limits'; end if;
 if not (case p_mime when 'image/png' then substring(b from 1 for 8)=decode('89504e470d0a1a0a','hex') when 'image/jpeg' then substring(b from 1 for 3)=decode('ffd8ff','hex') when 'image/webp' then substring(b from 1 for 4)=decode('52494646','hex') and substring(b from 9 for 4)=decode('57454250','hex') else false end) then raise exception 'Unsupported raster image'; end if;
 perform pg_advisory_xact_lock(38102,1);
 if (select count(*) from public.hag_cms_media)>=100 then raise exception 'Media library full'; end if;
 normalized:=replace(encode(b,'base64'),E'\n','');
 insert into public.hag_cms_media(label,mime,payload) values(btrim(p_label),p_mime,normalized) returning id into mid;
 return jsonb_build_object('id',mid,'label',btrim(p_label),'mime',p_mime);
end $$;
create function hag_private.hag_cms_media_remove(p_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform hag_private.hag_cms_guard();
 perform pg_advisory_xact_lock(38102,1);
 if exists(select 1 from hag_private.hag_cms_items where draft->>'image'='media:'||p_id::text) or exists(select 1 from public.hag_cms_publications where content->>'image'='media:'||p_id::text) then raise exception 'Image in use'; end if;
 delete from public.hag_cms_media where id=p_id;
 return found;
end $$;
create or replace function hag_private.hag_cms_validate(k text,d jsonb) returns jsonb language plpgsql stable set search_path='' as $$
declare t text; b text; l text; i text; dt text; loc text; approved boolean; finish text; placement text; logo_size text;
begin
 if k is null or k not in ('news','event','sponsor') or jsonb_typeof(d) is distinct from 'object' or octet_length(d::text)>22000 then raise exception 'Invalid content'; end if;
 if exists(select 1 from jsonb_object_keys(d) x where x not in ('title','body','url','image','date','location','permission','end_date','scope','logo_size')) then raise exception 'Unsupported field'; end if;
 if exists(select 1 from jsonb_each(d) x where (x.key='permission' and jsonb_typeof(x.value)<>'boolean') or (x.key<>'permission' and jsonb_typeof(x.value)<>'string')) then raise exception 'Invalid field type'; end if;
 t:=btrim(coalesce(d->>'title','')); b:=btrim(coalesce(d->>'body','')); l:=btrim(coalesce(d->>'url','')); i:=btrim(coalesce(d->>'image','')); dt:=coalesce(d->>'date',''); loc:=btrim(coalesce(d->>'location','')); approved:=coalesce((d->>'permission')::boolean,false); finish:=coalesce(d->>'end_date',''); placement:=coalesce(d->>'scope','general'); logo_size:=coalesce(d->>'logo_size','standard');
 if char_length(t) not between 1 and 140 or char_length(b)>4000 or char_length(loc)>200 or char_length(l)>500 or char_length(i)>300 then raise exception 'Field length invalid'; end if;
 if l<>'' and l !~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(/[A-Za-z0-9._~:/?&=%+@!$(),;-]*)?(\?[A-Za-z0-9._~:/?&=%+@!$(),;-]*)?(#[A-Za-z0-9._~:/?&=%+@!$(),;-]*)?$' then raise exception 'Use a valid HTTPS link'; end if;
 if i ~ '^media:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  if not exists(select 1 from public.hag_cms_media where id=substring(i from 7)::uuid) then raise exception 'Media not found'; end if;
 elsif i<>'' and (i !~ '^/assets/[A-Za-z0-9_./-]+\.(png|jpg|jpeg|webp|avif|gif)$' or i ~ '(^|/)\.\.?(/|$)' or i ~ '//') then raise exception 'Use an existing local raster image'; end if;
 if k='event' then
  if dt !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Event date required'; end if;
  perform dt::date;
  if finish<>'' then
   if finish !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Invalid event end date'; end if;
   if finish::date<dt::date then raise exception 'Invalid event end date'; end if;
  end if;
 else dt:=''; finish:=''; loc:=''; end if;
 if k<>'sponsor' then placement:='general'; logo_size:='standard'; end if;
 if logo_size not in ('compact','standard','large','premier') then raise exception 'Invalid logo size'; end if;
 if placement not in ('general','gus-macker','gus-macker-featured') then raise exception 'Invalid sponsor placement'; end if;
 return jsonb_build_object('title',t,'body',b,'url',l,'image',i,'date',dt,'location',loc,'end_date',finish,'scope',placement,'logo_size',logo_size,'permission',case when k='sponsor' then approved else false end);
end $$;
create or replace function hag_private.hag_cms_change(a text,k text,item uuid,expected integer,d jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare rec hag_private.hag_cms_items%rowtype; validated jsonb; pubrev integer;
begin
 perform hag_private.hag_cms_guard();
 perform pg_advisory_xact_lock(38102,1);
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
   update hag_private.hag_cms_items set revision=revision+1,updated_at=now(),updated_by=auth.uid() where id=item returning * into rec;
   insert into public.hag_cms_publications(id,kind,content,published_revision) values(rec.id,k,validated-'permission',rec.revision)
   on conflict(id) do update set content=excluded.content,published_revision=excluded.published_revision,published_at=now();
  else
   update hag_private.hag_cms_items set revision=revision+1,updated_at=now(),updated_by=auth.uid() where id=item returning * into rec;
   delete from public.hag_cms_publications where id=item;
  end if;
 end if;
 insert into hag_private.hag_cms_audit(item_id,actor,action,revision) values(rec.id,auth.uid(),a,rec.revision);
 select published_revision into pubrev from public.hag_cms_publications where id=rec.id;
 return jsonb_build_object('id',rec.id,'kind',rec.kind,'draft',rec.draft,'revision',rec.revision,'updated_at',rec.updated_at,'published_revision',pubrev);
end $$;

create function public.hag_cms_media_list() returns jsonb language sql stable security invoker set search_path='' as $$ select hag_private.hag_cms_media_list() $$;
create function public.hag_cms_media_get(p_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$ select hag_private.hag_cms_media_get(p_id) $$;
create function public.hag_cms_media_add(p_label text,p_mime text,p_payload text) returns jsonb language sql security invoker set search_path='' as $$ select hag_private.hag_cms_media_add(p_label,p_mime,p_payload) $$;
create function public.hag_cms_media_remove(p_id uuid) returns boolean language sql security invoker set search_path='' as $$ select hag_private.hag_cms_media_remove(p_id) $$;
revoke all on function public.hag_cms_media_list(),public.hag_cms_media_get(uuid),public.hag_cms_media_add(text,text,text),public.hag_cms_media_remove(uuid) from public,anon,authenticated,service_role;
grant execute on function public.hag_cms_media_list(),public.hag_cms_media_get(uuid),public.hag_cms_media_add(text,text,text),public.hag_cms_media_remove(uuid) to authenticated;
revoke all on function hag_private.hag_cms_media_list(),hag_private.hag_cms_media_get(uuid),hag_private.hag_cms_media_add(text,text,text),hag_private.hag_cms_media_remove(uuid) from public,anon,authenticated,service_role;
grant execute on function hag_private.hag_cms_media_list(),hag_private.hag_cms_media_get(uuid),hag_private.hag_cms_media_add(text,text,text),hag_private.hag_cms_media_remove(uuid) to authenticated;
commit;
