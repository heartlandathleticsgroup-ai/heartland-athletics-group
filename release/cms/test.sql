-- Isolated test database only.
\set ON_ERROR_STOP on
set role authenticated;
select set_config('test.uid','00000000-0000-4000-8000-000000000001',false);
select set_config('test.state','challenge',false);
do $$ begin
 begin perform public.hag_cms_list(); raise exception 'Gate bypass'; exception when insufficient_privilege then null; end;
 begin perform public.hag_cms_change('save','news',null,0,'{"title":"Denied"}'); raise exception 'Gate bypass'; exception when insufficient_privilege then null; end;
end $$;
select set_config('test.state','authorized',false);
do $$
declare r jsonb; u uuid; s jsonb;
begin
 r:=public.hag_cms_change('save','news',null,0,'{"title":"Draft","body":"Original"}'); u:=(r->>'id')::uuid;
 if exists(select 1 from public.hag_cms_publications where id=u) then raise exception 'Draft leaked'; end if;
 perform public.hag_cms_change('publish','news',u,1,null);
 perform public.hag_cms_change('save','news',u,2,'{"title":"Private edit"}');
 if (select content->>'title' from public.hag_cms_publications where id=u) is distinct from 'Draft' then raise exception 'Draft overwrote publication'; end if;
 begin perform public.hag_cms_change('publish','news',u,1,null); raise exception 'Stale write accepted'; exception when serialization_failure then null; end;
 perform public.hag_cms_change('publish','news',u,3,null);
 if (select content->>'title' from public.hag_cms_publications where id=u) is distinct from 'Private edit' then raise exception 'Publication mismatch'; end if;
 perform public.hag_cms_change('unpublish','news',u,4,null);
 if exists(select 1 from public.hag_cms_publications where id=u) then raise exception 'Unpublish failed'; end if;
 begin perform public.hag_cms_change('publish','news',u,4,null); raise exception 'Stale publication after unpublish'; exception when serialization_failure then null; end;
 s:=public.hag_cms_change('save','sponsor',null,0,'{"title":"Sponsor","permission":false}'); u:=(s->>'id')::uuid;
 begin perform public.hag_cms_change('publish','sponsor',u,1,null); raise exception 'Missing permission accepted' using errcode='XX000'; exception when raise_exception then null; end;
 perform public.hag_cms_change('save','sponsor',u,1,'{"title":"Sponsor","permission":true}');
 perform public.hag_cms_change('publish','sponsor',u,2,null);
 if (select content ? 'permission' from public.hag_cms_publications where id=u) then raise exception 'Permission leaked'; end if;
 begin perform public.hag_cms_change('save','news',null,0,'{"title":"Bad","url":"javascript:alert(1)"}'); raise exception 'Unsafe URL accepted' using errcode='XX000'; exception when raise_exception then null; end;
 begin perform public.hag_cms_change('save','news',null,0,'{"title":"Bad","image":"/assets/../bad.png"}'); raise exception 'Unsafe path accepted' using errcode='XX000'; exception when raise_exception then null; end;
 begin perform public.hag_cms_change('save','event',null,0,'{"title":"Bad","date":"2027-02-30"}'); raise exception 'Bad date accepted'; exception when datetime_field_overflow then null; end;
 perform public.hag_cms_change('save','event',null,0,'{"title":"Event","date":"2027-05-29","location":"Quincy"}');
 if jsonb_array_length(public.hag_cms_list())<>3 then raise exception 'List mismatch'; end if;
 begin insert into public.hag_cms_publications(id,kind,content,published_revision) values(gen_random_uuid(),'news','{}',1); raise exception 'Direct write allowed'; exception when insufficient_privilege then null; end;
 begin perform count(*) from hag_private.hag_cms_items; raise exception 'Draft table readable'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role anon;
do $$ begin
 if (select count(*) from public.hag_cms_publications)<>1 then raise exception 'Public feed mismatch'; end if;
 begin perform public.hag_cms_list(); raise exception 'Anonymous RPC allowed'; exception when insufficient_privilege then null; end;
 begin perform public.hag_cms_change('save','news',null,0,'{"title":"Bad"}'); raise exception 'Anonymous mutation allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'CMS SQL tests passed' as result;
