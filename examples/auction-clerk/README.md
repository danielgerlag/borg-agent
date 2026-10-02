# Auction clerk

The book plugin rejects a bid that does not beat the standing bid. The scripted model bids 10, then 8, then 15.

After `pnpm build`, run `node examples/auction-clerk/dist/main.js`.

It prints:

```
Auction clerk: lot 7 hammered at 15 to paddle 4
```
