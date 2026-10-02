# Auction clerk

The book plugin keeps the standing bid for lot 7 and rejects a bid that does not beat it. Hammer closes the lot.

After `pnpm build`, open the window with `pnpm --filter @borg/example-auction-clerk start`.

Bid 10, then 8, then 15. Hammer the lot and the clerk shows paddle 4 at 15.

The scripted loop is still there. `node examples/auction-clerk/dist/main.js` prints:

```
Auction clerk: lot 7 hammered at 15 to paddle 4
```
