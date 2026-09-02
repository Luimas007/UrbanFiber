-- ============================================================================
--  UrbanFiber — patch 2  (run AFTER supabase-setup.sql, supabase-patch.sql,
--  supabase-storage-fix.sql)
--  Supabase Dashboard -> SQL Editor -> New query -> Run
-- ============================================================================
--  Adds, purely additively — nothing below removes or narrows anything:
--    1. products.fabric_type          (new optional text field)
--    2. site_settings.hero_images     (array of hero photo URLs, crossfading)
--    3. site_settings.model_images    (array of "Worn in the City" rail photos)
--    4. widens the orders.status check constraint to allow 'shipped'
--       (does NOT touch admin_set_order_status itself — see the note at the
--       bottom; that function's source is still needed to fix "Mark shipped")
--
--  admin_save_settings and admin_save_product are both re-created here in
--  full (CREATE OR REPLACE requires the whole body) — every line from the
--  versions in supabase-setup.sql is kept, only the new fields are added.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Products: fabric type
-- ---------------------------------------------------------------------------
alter table public.products add column if not exists fabric_type text;
comment on column public.products.fabric_type is
  'Free-text fabric description, e.g. "220 GSM heavyweight cotton". Optional — shown on the product page when set.';

-- ---------------------------------------------------------------------------
-- 2. Site settings: multiple hero images + manageable model rail
-- ---------------------------------------------------------------------------
alter table public.site_settings add column if not exists hero_images  jsonb not null default '[]'::jsonb;
alter table public.site_settings add column if not exists model_images jsonb not null default '[]'::jsonb;
comment on column public.site_settings.hero_images is
  'Array of image URLs shown as a crossfading hero. Empty = the bundled default image is used.';
comment on column public.site_settings.model_images is
  'Array of image URLs for the "Worn in the City" rail. Empty = the bundled default photos are used.';

-- ---------------------------------------------------------------------------
-- 3. admin_save_settings — extended for hero_images / model_images
-- ---------------------------------------------------------------------------
create or replace function public.admin_save_settings(p_settings jsonb)
returns public.site_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.site_settings;
begin
  if not public.is_admin() then
    raise exception 'Unauthorized' using errcode = 'P0001';
  end if;

  update public.site_settings set
    hero_image_url = nullif(trim(coalesce(p_settings->>'hero_image_url', hero_image_url)), ''),
    hero_headline  = nullif(trim(coalesce(p_settings->>'hero_headline',  hero_headline)),  ''),
    hero_subcopy   = nullif(trim(coalesce(p_settings->>'hero_subcopy',   hero_subcopy)),   ''),
    hero_cta_label = coalesce(nullif(trim(coalesce(p_settings->>'hero_cta_label','')),''), hero_cta_label),
    hero_images    = case when jsonb_typeof(p_settings->'hero_images')  = 'array'
                          then p_settings->'hero_images'  else hero_images  end,
    model_images   = case when jsonb_typeof(p_settings->'model_images') = 'array'
                          then p_settings->'model_images' else model_images end,
    ribbon_enabled = coalesce((p_settings->>'ribbon_enabled')::boolean, ribbon_enabled),
    ribbon_label   = nullif(trim(coalesce(p_settings->>'ribbon_label',   ribbon_label)),   ''),
    ribbon_message = nullif(trim(coalesce(p_settings->>'ribbon_message', ribbon_message)), ''),
    ribbon_href    = nullif(trim(coalesce(p_settings->>'ribbon_href',    ribbon_href)),    ''),
    free_delivery_over_bdt = nullif(p_settings->>'free_delivery_over_bdt','')::numeric,
    updated_at     = now()
  where id = true
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_save_settings(jsonb) from public, anon;
grant execute on function public.admin_save_settings(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. admin_save_product — extended for fabric_type
-- ---------------------------------------------------------------------------
create or replace function public.admin_save_product(p_product jsonb)
returns public.products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   public.products;
  v_id    uuid   := nullif(p_product->>'id','')::uuid;
  v_name  text   := nullif(trim(p_product->>'name'),'');
  v_slug  text   := nullif(trim(p_product->>'slug'),'');
  v_price numeric:= (p_product->>'price_bdt')::numeric;
  v_sale  numeric:= nullif(p_product->>'sale_price_bdt','')::numeric;
  v_stock text   := coalesce(nullif(p_product->>'stock_status',''),'in_stock');
begin
  if not public.is_admin() then
    raise exception 'Unauthorized' using errcode = 'P0001';
  end if;
  if v_name is null or v_slug is null then
    raise exception 'Name and slug are required' using errcode = 'P0001';
  end if;
  if v_price is null or v_price < 0 then
    raise exception 'Invalid price' using errcode = 'P0001';
  end if;
  if v_sale is not null and v_sale >= v_price then
    raise exception 'Sale price must be lower than the normal price' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_product->'variants') <> 'object'
     or p_product->'variants' = '{}'::jsonb then
    raise exception 'At least one colour is required' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_product->'sizes') <> 'array'
     or jsonb_array_length(p_product->'sizes') = 0 then
    raise exception 'At least one size is required' using errcode = 'P0001';
  end if;

  insert into public.products as t (
    id, name, slug, category, price_bdt, sale_price_bdt, stock_status,
    description, fabric_type, size_chart_url, image_url, variants, sizes,
    active, is_featured, updated_at
  ) values (
    coalesce(v_id, gen_random_uuid()), v_name, v_slug,
    coalesce(nullif(trim(p_product->>'category'),''),'Oversized'),
    v_price, v_sale, v_stock,
    nullif(trim(p_product->>'description'),''),
    nullif(trim(p_product->>'fabric_type'),''),
    nullif(trim(p_product->>'size_chart_url'),''),
    p_product->>'image_url', p_product->'variants', p_product->'sizes',
    coalesce((p_product->>'active')::boolean, true),
    coalesce((p_product->>'is_featured')::boolean, false),
    now()
  )
  on conflict (id) do update set
    name = excluded.name, slug = excluded.slug, category = excluded.category,
    price_bdt = excluded.price_bdt, sale_price_bdt = excluded.sale_price_bdt,
    stock_status = excluded.stock_status, description = excluded.description,
    fabric_type = excluded.fabric_type,
    size_chart_url = excluded.size_chart_url, image_url = excluded.image_url,
    variants = excluded.variants, sizes = excluded.sizes,
    active = excluded.active, is_featured = excluded.is_featured, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_save_product(jsonb) from public, anon;
grant execute on function public.admin_save_product(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Widen the status constraint so 'shipped' is a legal value.
-- ---------------------------------------------------------------------------
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('pending','accepted','shipped','completed','cancelled'));

-- ---------------------------------------------------------------------------
-- 6. admin_set_order_status — adds the 'shipped' stage between accepted and
--    completed. Rebuilt from the live prosrc you pasted; every existing
--    branch (auth gate, row lock, immutability of completed/cancelled,
--    exception text) is kept verbatim, only the transition rules gain a
--    'shipped' step. Signature/security wrapper inferred from the identical
--    pattern used by every other RPC in this project — if it doesn't match
--    the live signature, CREATE OR REPLACE will fail with a clear error.
-- ---------------------------------------------------------------------------
alter table public.orders add column if not exists shipped_at timestamptz;

create or replace function public.admin_set_order_status(p_order_id uuid, p_status text)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare v_order public.orders%rowtype;
begin
  if not public.is_admin() then raise exception 'Unauthorized'; end if;
  if p_status not in ('pending','accepted','shipped','completed','cancelled') then raise exception 'Invalid status'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if v_order.status='completed' and p_status<>'completed' then raise exception 'Completed orders are immutable'; end if;
  if v_order.status='cancelled' and p_status<>'cancelled' then raise exception 'Cancelled orders are immutable'; end if;
  if p_status='shipped' and v_order.status<>'accepted' then raise exception 'Order must be accepted before shipping'; end if;
  if p_status='completed' and v_order.status<>'shipped' then raise exception 'Order must be shipped before completion'; end if;
  if p_status='accepted' and v_order.status<>'pending' then raise exception 'Only pending orders can be accepted'; end if;
  if p_status='cancelled' and v_order.status not in ('pending','accepted','shipped') then raise exception 'Invalid cancellation'; end if;
  update public.orders set
    status=p_status,
    accepted_at=case when p_status='accepted' then coalesce(accepted_at,now()) else accepted_at end,
    shipped_at=case when p_status='shipped' then coalesce(shipped_at,now()) else shipped_at end,
    completed_at=case when p_status='completed' then now() else completed_at end,
    cancelled_at=case when p_status='cancelled' then now() else cancelled_at end
  where id=p_order_id returning * into v_order;
  return v_order;
end;
$$;

revoke all on function public.admin_set_order_status(uuid, text) from public, anon;
grant execute on function public.admin_set_order_status(uuid, text) to authenticated;

commit;

-- ============================================================================
--  AFTER RUNNING — verify:
--    select fabric_type from public.products limit 1;
--    select hero_images, model_images from public.site_settings;
--    select shipped_at from public.orders limit 1;
-- ============================================================================
