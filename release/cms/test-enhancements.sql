\set ON_ERROR_STOP on
-- Fixture owner only, no real account.
create table hag_private.hag_staff(user_id uuid,active boolean,role text);
insert into hag_private.hag_staff values('00000000-0000-4000-8000-000000000001',true,'admin');
\ir import-existing.sql
set role authenticated;
select set_config('test.uid','00000000-0000-4000-8000-000000000001',false);
select set_config('test.state','authorized',false);
do $$
declare m jsonb; u uuid; p jsonb; x uuid;
begin
 -- Header-valid PNG fixture, used only for SQL checks.
 m:=public.hag_cms_media_add('Fixture','image/png','iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcR0AAAAASUVORK5CYII=');
 u:=(m->>'id')::uuid;
 if exists(select id from public.hag_cms_media where id=u) then raise exception 'Private media leaked'; end if;
 if (public.hag_cms_media_get(u)->>'mime') is distinct from 'image/png' then raise exception 'Admin preview unavailable'; end if;
 p:=public.hag_cms_change('save','news',null,0,jsonb_build_object('title','Media news','image','media:'||u::text)); x:=(p->>'id')::uuid;
 begin perform public.hag_cms_media_remove(u); raise exception 'Referenced media removed' using errcode='XX000'; exception when raise_exception then null; end;
 perform public.hag_cms_change('publish','news',x,1,null);
 if not exists(select id from public.hag_cms_media where id=u) then raise exception 'Published media missing'; end if;
 perform public.hag_cms_change('unpublish','news',x,2,null);
 if exists(select id from public.hag_cms_media where id=u) then raise exception 'Unpublished media leaked'; end if;
 perform public.hag_cms_change('save','news',x,3,'{"title":"Media detached"}');
 if public.hag_cms_media_remove(u) is distinct from true then raise exception 'Unused media not removed'; end if;
 begin perform public.hag_cms_media_add('Bad','image/png','PHN2Zz48L3N2Zz4='); raise exception 'Invalid media accepted' using errcode='XX000'; exception when raise_exception then null; end;
 begin perform public.hag_cms_change('save','news',null,0,'{"title":"Bad","image":"media:00000000-0000-4000-8000-000000000001"}'); raise exception 'Missing media accepted' using errcode='XX000'; exception when raise_exception then null; end;
end $$;
select set_config('test.state','challenge',false);
do $$ begin
 begin perform public.hag_cms_media_list(); raise exception 'Unauthorized media list'; exception when insufficient_privilege then null; end;
 begin perform public.hag_cms_media_add('Denied','image/png','AAAA'); raise exception 'Unauthorized upload'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role anon;
do $$ begin
 if (select count(id) from public.hag_cms_media)<>0 then raise exception 'Private media visible'; end if;
 if (select count(*) from public.hag_cms_publications where id in ('8b110000-0000-4000-8000-000000000001','8b110000-0000-4000-8000-000000000002','8b110000-0000-4000-8000-000000000003'))<>3 then raise exception 'Import mismatch'; end if;
 begin perform public.hag_cms_media_list(); raise exception 'Anon library access'; exception when insufficient_privilege then null; end;
 begin perform label from public.hag_cms_media; raise exception 'Anon metadata access'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'CMS enhancement SQL tests passed' as result;
