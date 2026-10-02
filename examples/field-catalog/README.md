# Field catalog

The catalog plugin records each sighting and files a voucher only for the last in-range sighting.

After `pnpm build`, open the window with `pnpm --filter @borg/example-field-catalog start`.

Record Thunder Bay and the voucher stays out of range. Record Point Pelee for `cicindela sexguttata` and the catalog files `FC-1042`.

The scripted loop is still there. `node examples/field-catalog/dist/main.js` prints:

```
Field catalog: voucher FC-1042 for cicindela sexguttata at point pelee
```
