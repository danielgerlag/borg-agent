# Field catalog

The catalog plugin records each sighting and files a voucher only for the last in-range sighting. The scripted model observes Thunder Bay, then Point Pelee, then files that sighting.

After `pnpm build`, run `node examples/field-catalog/dist/main.js`.

It prints:

```
Field catalog: voucher FC-1042 for cicindela sexguttata at point pelee
```
