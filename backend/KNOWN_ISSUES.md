# Known issues that cannot be fixed from a migration

## `spatial_ref_sys` is writable by anyone holding the public anon key

PostGIS installs `spatial_ref_sys` into the `public` schema, so PostgREST exposes it like any other
table. It has **no row-level security** and full privileges granted to `anon`.

Verified with the anon key that ships in `safewalk-app/config.js`:

```
DELETE /rest/v1/spatial_ref_sys?srid=eq.999999   -> 204
PATCH  /rest/v1/spatial_ref_sys?srid=eq.999999   -> 204
```

Both are permitted. A filter matching real rows would delete or corrupt the coordinate-system
definitions the database depends on — a denial-of-service needing nothing but a key that is public
by design.

**Why it is not fixed here.** The table is owned by `supabase_admin`, and the grants were made by
`supabase_admin`:

```
spatial_ref_sys | supabase_admin | {...,anon=arwdDxtm/supabase_admin,...}
```

`REVOKE` only removes grants made by the revoking role. Migration attempts run as `postgres`, which
cannot revoke a grant issued by `supabase_admin` — and, importantly, **the revoke reports success
while changing nothing**. Do not assume a migration touching this table worked; re-check `relacl`.

**Mitigation and next steps.**

- Our own queries are probably unaffected in practice: `ST_DWithin` on `geography` does not look up
  `spatial_ref_sys` at runtime for SRID 4326. `ST_Transform` does, and would break.
- Supabase's own database linter reports this as `rls_disabled_in_public`. It is a platform default
  rather than something this project introduced.
- Fixing it needs either Supabase support, or moving PostGIS out of the `public` schema (the linter
  also suggests this via `extension_in_public`), which would require rewriting the migrations that
  reference PostGIS functions by bare name.

This was originally dismissed during a linter review as "not actionable and not sensitive". That
was wrong, and it was wrong because it was never tested. Test the claim before dismissing it.
