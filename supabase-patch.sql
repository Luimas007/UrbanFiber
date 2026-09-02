-- ============================================================================
--  UrbanFiber — corrective patch  (run AFTER supabase-setup.sql)
--  Supabase Dashboard -> SQL Editor -> New query -> Run. Idempotent.
-- ============================================================================
--  WHY: supabase-setup.sql replaced create_guest_order with a version I
--  reconstructed without having seen your original. Comparing against the real
--  source, my version dropped the following. This restores every one of them
--  while keeping the new sale-price / sold-out / free-delivery behaviour.
--
--    restored | explicit length checks with readable messages
--             |   (your CHECK constraints still caught these, but customers saw
--             |    raw "violates check constraint orders_address_check" errors)
--    restored | payment_method must be exactly 'cod'  (mine silently accepted anything)
--    restored | colour lower/trim + size upper/trim normalisation
--             |   (mine rejected "Black" or "m"; only worked because the
--             |    storefront happens to send the exact case)
--    restored | SELECT ... FOR SHARE row lock while reading the product
--    restored | item cap of 30 (mine had raised it to 50)
--    restored | UUID shape check before the cast
--    restored | numeric(12,2) money types
--    kept     | sale price, sold-out blocking, free-delivery threshold
--    improved | phone accepts +88 / 88 prefixes and spaces or dashes
--               (your original stripped non-digits, which turned "+8801712..."
--                into "8801712..." and then rejected it)
-- ============================================================================

begin;

create or replace function public.create_guest_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id   uuid := gen_random_uuid();
  v_order_number text;
  v_customer   jsonb := coalesce(p_order->'customer','{}'::jsonb);
  v_items      jsonb := coalesce(p_order->'items','[]'::jsonb);
  v_district   text  := lower(trim(coalesce(v_customer->>'district','')));
  v_phone      text  := regexp_replace(trim(coalesce(v_customer->>'phone','')),'[^0-9]','','g');
  v_delivery   numeric(12,2);
  v_subtotal   numeric(12,2) := 0;
  v_total      numeric(12,2);
  v_free_over  numeric(12,2);
  v_item       jsonb;
  v_product    public.products%rowtype;
  v_qty        integer;
  v_color      text;
  v_size       text;
  v_unit       numeric(12,2);
  v_line       numeric(12,2);
  v_count      integer := 0;
begin
  -- ---- shape ----
  if jsonb_typeof(v_items) <> 'array'
     or jsonb_array_length(v_items) < 1
     or jsonb_array_length(v_items) > 30 then
    raise exception 'Invalid order items';
  end if;

  -- ---- customer ----
  if length(trim(coalesce(v_customer->>'name',''))) not between 2 and 120 then
    raise exception 'Invalid customer name';
  end if;

  -- Accept 01XXXXXXXXX, 8801XXXXXXXXX and +8801XXXXXXXXX (spaces/dashes ok).
  v_phone := regexp_replace(v_phone, '^88', '');
  if v_phone !~ '^01[3-9][0-9]{8}$' then
    raise exception 'Invalid Bangladesh phone number';
  end if;

  if length(trim(coalesce(v_customer->>'district',''))) not between 2 and 80 then
    raise exception 'Invalid district';
  end if;
  if length(trim(coalesce(v_customer->>'area',''))) not between 2 and 120 then
    raise exception 'Invalid area';
  end if;
  if length(trim(coalesce(v_customer->>'address',''))) not between 5 and 500 then
    raise exception 'Invalid address';
  end if;
  if coalesce(v_customer->>'postcode','') <> ''
     and v_customer->>'postcode' !~ '^[0-9]{4}$' then
    raise exception 'Invalid postcode';
  end if;
  if coalesce(p_order->>'payment_method','cod') <> 'cod' then
    raise exception 'Unsupported payment method';
  end if;

  v_delivery := case when v_district = 'dhaka' then 60.00 else 100.00 end;
  v_order_number := 'UF-' || to_char(now() at time zone 'Asia/Dhaka','YYYYMMDD')
                    || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));

  insert into public.orders(
    id, order_number, customer_name, phone, district, area, postcode, address,
    payment_method, delivery_charge_bdt, subtotal_bdt, total_bdt
  ) values (
    v_order_id, v_order_number, trim(v_customer->>'name'), v_phone,
    trim(v_customer->>'district'), trim(v_customer->>'area'),
    nullif(trim(v_customer->>'postcode'),''), trim(v_customer->>'address'),
    'cod', v_delivery, 0, v_delivery
  );

  -- ---- items ----
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_count := v_count + 1;

    if v_item->>'product_id' is null
       or v_item->>'product_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'Invalid product';
    end if;
    if (v_item->>'quantity') is null or (v_item->>'quantity') !~ '^[0-9]+$' then
      raise exception 'Invalid quantity';
    end if;
    v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 or v_qty > 20 then raise exception 'Invalid quantity'; end if;

    v_color := lower(trim(coalesce(v_item->>'color','')));
    v_size  := upper(trim(coalesce(v_item->>'size','')));

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and active = true
      for share;
    if not found then raise exception 'Product is unavailable'; end if;

    if v_product.stock_status = 'sold_out' then
      raise exception 'Sold out: %', v_product.name;
    end if;
    if v_color = '' or not (v_product.variants ? v_color) then
      raise exception 'Invalid product color';
    end if;
    if v_size = '' or not (v_product.sizes ? v_size) then
      raise exception 'Invalid product size';
    end if;

    -- Sale price wins when set. Never read from the request body.
    v_unit := coalesce(v_product.sale_price_bdt, v_product.price_bdt);
    v_line := v_unit * v_qty;
    v_subtotal := v_subtotal + v_line;

    insert into public.order_items(
      order_id, product_id, product_name, color, size,
      quantity, unit_price_bdt, line_total_bdt
    ) values (
      v_order_id, v_product.id, v_product.name, v_color, v_size,
      v_qty, v_unit, v_line
    );
  end loop;

  if v_count = 0 then raise exception 'Empty order'; end if;

  -- Free delivery above the configured threshold, if one is set.
  select free_delivery_over_bdt into v_free_over from public.site_settings where id = true;
  if v_free_over is not null and v_subtotal >= v_free_over then
    v_delivery := 0;
  end if;

  v_total := v_subtotal + v_delivery;
  update public.orders
     set subtotal_bdt = v_subtotal,
         delivery_charge_bdt = v_delivery,
         total_bdt = v_total
   where id = v_order_id;

  return jsonb_build_object(
    'order_id', v_order_id, 'order_number', v_order_number,
    'subtotal_bdt', v_subtotal, 'delivery_charge_bdt', v_delivery,
    'total_bdt', v_total, 'currency', 'BDT'
  );
end;
$$;

revoke all on function public.create_guest_order(jsonb) from public;
grant execute on function public.create_guest_order(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
--  Storage: block anonymous bucket LISTING without breaking public images.
--
--  The bucket is public, so image <img> requests go through
--  /storage/v1/object/public/... which does not consult RLS. Only the
--  /storage/v1/object/list/... endpoint does. Removing anon SELECT therefore
--  stops strangers enumerating your files while every product photo keeps
--  loading normally.
-- ---------------------------------------------------------------------------
drop policy if exists "product images are publicly readable" on storage.objects;

create policy "admins read product images"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

commit;

-- ============================================================================
--  Verify (expect: clean messages, not constraint violations)
--
--    select public.create_guest_order('{"customer":{"name":"X","phone":"01712345678",
--      "district":"Dhaka","area":"Area","address":"Some valid address"},
--      "payment_method":"cod","items":[]}'::jsonb);
--      -> ERROR: Invalid order items
--
--  Then open the storefront and confirm product photos still load.
--  If any image 404s, run this to undo just the storage change:
--
--    drop policy if exists "admins read product images" on storage.objects;
--    create policy "product images are publicly readable"
--      on storage.objects for select to anon, authenticated
--      using (bucket_id = 'product-images');
-- ============================================================================
