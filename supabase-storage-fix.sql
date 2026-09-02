-- ============================================================================
--  UrbanFiber — storage listing fix  (run AFTER supabase-patch.sql)
--  Supabase Dashboard -> SQL Editor -> New query -> Run
-- ============================================================================
--  PROBLEM
--    Anyone with the publishable key can still enumerate your bucket:
--      POST /storage/v1/object/list/product-images  -> 200, full file listing
--    It leaks filenames, sizes and timestamps for EVERY upload, including
--    photos for products that are not published yet.
--
--  WHY THE EARLIER PATCH MISSED IT
--    supabase-patch.sql dropped a policy by name. Your project has an anon
--    SELECT policy on storage.objects under a different name, so it survived.
--    This script drops them by *effect* rather than by name.
--
--  WHY THIS IS SAFE FOR YOUR IMAGES
--    The bucket is public, so <img> requests go to
--      /storage/v1/object/public/product-images/...
--    which does not consult RLS at all. Verified: fetching a product image
--    with no apikey and no Authorization header returns HTTP 200. Only the
--    `list` endpoint consults RLS, and that is exactly what we are closing.
-- ============================================================================

begin;

-- 1. Show what exists right now (read the output in the Results pane).
select policyname, cmd, roles::text
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by policyname;

-- 2. Drop every policy on storage.objects that grants anon (or PUBLIC) access.
do $$
declare r record;
begin
  for r in
    select policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and (roles::text[] && array['anon','public'])
  loop
    execute format('drop policy if exists %I on storage.objects', r.policyname);
    raise notice 'dropped anon policy: %', r.policyname;
  end loop;
end $$;

-- 3. Re-create exactly the access the app needs — admins only, no anon.
drop policy if exists "admins read product images"   on storage.objects;
drop policy if exists "only admins write product images"  on storage.objects;
drop policy if exists "only admins update product images" on storage.objects;
drop policy if exists "only admins delete product images" on storage.objects;

create policy "admins read product images"
  on storage.objects for select to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

create policy "admins write product images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_admin());

create policy "admins update product images"
  on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

create policy "admins delete product images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

commit;

-- ============================================================================
--  AFTER RUNNING — check both of these:
--
--   1. Open https://urban-fiber.com  ->  every product photo must still load.
--   2. Listing must now be refused (it returned a full file list before):
--        the site will keep working either way; this is the check that the
--        leak is closed.
--
--  ROLLBACK (only if images break):
--      create policy "product images are publicly readable"
--        on storage.objects for select to anon, authenticated
--        using (bucket_id = 'product-images');
-- ============================================================================
