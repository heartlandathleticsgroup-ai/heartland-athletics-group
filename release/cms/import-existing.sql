-- Import only the exact already-public records from the reviewed static pages.
-- Existing authorized CMS account is recorded as responsible owner, not as an interactive audit actor.
begin;
do $import$
declare owner_id uuid; src record; d jsonb;
begin
 select user_id into strict owner_id from hag_private.hag_staff where active and role='admin';
 for src in select * from jsonb_to_recordset($seed$[{"id":"8b110000-0000-4000-8000-000000000001","kind":"event","draft":{"title":"Gus Macker - Quincy","body":"Quincy's Gus Macker 3-on-3 basketball tournament returns on Memorial Day weekend. Brought to you by Heartland Athletics Group. The dates are confirmed; the tournament venue and additional details will be announced when finalized.","url":"https://heartlandathleticsgroup.com/gus-macker/","date":"2027-05-29","end_date":"2027-05-30","location":"Quincy, Illinois"}},{"id":"8b110000-0000-4000-8000-000000000002","kind":"sponsor","draft":{"title":"Dot Foods","body":"Explore careers at Dot Foods","url":"https://careers.dotfoods.com/","image":"/assets/assets/dot-foods.webp","permission":true,"scope":"gus-macker-featured","logo_size":"premier"}},{"id":"8b110000-0000-4000-8000-000000000003","kind":"sponsor","draft":{"title":"Be Dry Roofing","body":"","url":"https://bedryroofing.com/","image":"/assets/assets/be-dry-roofing.avif","permission":true,"scope":"gus-macker-featured","logo_size":"large"}}]$seed$::jsonb) as x(id uuid,kind text,draft jsonb) loop
  if exists(select 1 from hag_private.hag_cms_items where id=src.id or (kind=src.kind and lower(draft->>'title')=lower(src.draft->>'title'))) then raise exception 'Existing item collision; import aborted'; end if;
  d:=hag_private.hag_cms_validate(src.kind,src.draft);
  insert into hag_private.hag_cms_items(id,kind,draft,revision,updated_by) values(src.id,src.kind,d,1,owner_id);
  insert into public.hag_cms_publications(id,kind,content,published_revision) values(src.id,src.kind,d-'permission',1);
 end loop;
end $import$;
commit;
