import { defineUiPlugin } from "@borg-agent/plugin-sdk";
import { Button, Panel, TextField } from "@borg/ui-kit";
import { For, Show, createResource, createSignal, type Component } from "solid-js";
import { auctionBid, auctionHammer, auctionSnapshot } from "./contract";

export const auctionClerkUiMetadata = {
  id: "example.auction.ui",
  permissions: ["ui.workspace"],
  contributes: { kinds: ["workspaceView"] },
} as const;

function wholeNumber(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

export default defineUiPlugin<Component>({
  id: auctionClerkUiMetadata.id,
  activate(context) {
    const AuctionClerk: Component = () => {
      const [snapshot, { refetch }] = createResource(() =>
        context.bus.invoke(auctionSnapshot, {}),
      );
      const [paddle, setPaddle] = createSignal("");
      const [amount, setAmount] = createSignal("");
      const [tape, setTape] = createSignal<readonly string[]>([]);
      const [failure, setFailure] = createSignal<string | undefined>();
      const [busy, setBusy] = createSignal(false);

      const bid = async (): Promise<void> => {
        const paddleNumber = wholeNumber(paddle());
        const amountNumber = wholeNumber(amount());
        if (paddleNumber === undefined || amountNumber === undefined) {
          setFailure("Paddle and amount need whole numbers");
          return;
        }
        setBusy(true);
        setFailure(undefined);
        try {
          const result = await context.bus.invoke(auctionBid, {
            lot: 7,
            paddle: paddleNumber,
            amount: amountNumber,
          });
          setTape((lines) => [
            result.accepted
              ? `Paddle ${result.paddle} bids ${result.standing}`
              : result.reason,
            ...lines,
          ]);
          await refetch();
        } catch (error) {
          setFailure(error instanceof Error ? error.message : "Bid failed");
        } finally {
          setBusy(false);
        }
      };

      const hammer = async (): Promise<void> => {
        setBusy(true);
        setFailure(undefined);
        try {
          await context.bus.invoke(auctionHammer, {});
          await refetch();
        } catch (error) {
          setFailure(error instanceof Error ? error.message : "Hammer failed");
        } finally {
          setBusy(false);
        }
      };

      return (
        <main
          class="min-h-screen bg-[var(--background)] px-8 py-10 text-[var(--text)]"
          data-testid="auction-clerk"
        >
          <p class="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--accent)]">
            Lot 7
          </p>
          <h1 class="mt-2 text-3xl font-semibold">Auction clerk</h1>
          <Panel class="mt-8 max-w-xl">
            <Show when={snapshot()} fallback={<p>Opening the book.</p>}>
              {(book) => (
                <div>
                  <p class="text-sm uppercase tracking-wider text-[var(--text-muted)]">
                    Standing
                  </p>
                  <p class="mt-2 text-4xl font-semibold" data-testid="auction-standing">
                    {book().standing ?? "no bid"}
                  </p>
                  <Show when={book().paddle !== null}>
                    <p class="mt-2 text-sm text-[var(--text-muted)]" data-testid="auction-paddle-standing">
                      Paddle {book().paddle}
                    </p>
                  </Show>
                  <Show when={book().status === "hammered"}>
                    <p class="mt-4 text-sm text-[var(--success)]" data-testid="auction-hammered">
                      Hammered at {book().standing} to paddle {book().paddle}
                    </p>
                  </Show>
                </div>
              )}
            </Show>
            <div class="mt-6 grid gap-4 sm:grid-cols-2">
              <TextField
                label="Paddle"
                value={paddle()}
                onChange={setPaddle}
                data-testid="auction-paddle"
              />
              <TextField
                label="Amount"
                value={amount()}
                onChange={setAmount}
                data-testid="auction-amount"
              />
            </div>
            <div class="mt-4 flex gap-3">
              <Button
                data-testid="auction-bid"
                disabled={busy() || snapshot()?.status === "hammered"}
                onClick={() => {
                  void bid();
                }}
              >
                Place bid
              </Button>
              <Button
                variant="secondary"
                data-testid="auction-hammer"
                disabled={
                  busy() ||
                  snapshot()?.status === "hammered" ||
                  snapshot()?.standing === null ||
                  snapshot()?.standing === undefined
                }
                onClick={() => {
                  void hammer();
                }}
              >
                Hammer
              </Button>
            </div>
            <Show when={failure()}>
              {(message) => (
                <p class="mt-4 text-sm text-[var(--danger)]" data-testid="auction-failure">
                  {message()}
                </p>
              )}
            </Show>
            <ul class="mt-6 grid gap-2" data-testid="auction-tape">
              <For each={tape()}>
                {(line) => <li class="text-sm text-[var(--text-muted)]">{line}</li>}
              </For>
            </ul>
          </Panel>
        </main>
      );
    };

    context.ui.registerWorkspaceView({
      id: "auction.book",
      label: "Auction clerk",
      component: AuctionClerk,
    });
  },
});
