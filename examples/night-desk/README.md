# Night desk

Headless on-call night desk. The kernel is the host. The pager and the runbook own the rules. The desk UI is a plugin that calls those same rules.

After `pnpm build`, open the window with `pnpm --filter @borg/example-night-desk start`.

Page p-19 is `pager-1`, symptom `disk 98% full`. Run the mitigation and the desk shows `rotated the log and freed the volume`.

The scripted loop is still there. `node examples/night-desk/dist/main.js` prints:

```
Night desk: pager-1 disk 98% full, mitigated by rotated the log and freed the volume
```
