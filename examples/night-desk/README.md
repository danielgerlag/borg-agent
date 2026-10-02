# Night desk

Headless on-call night desk. The kernel is the host. The pager and the runbook own the rules. The model plugin only chooses the next tool from the tool results.

After `pnpm build`, run `node examples/night-desk/dist/main.js`.

It prints:

```
Night desk: pager-1 disk 98% full, mitigated by rotated the log and freed the volume
```
