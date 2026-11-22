import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  formatHash,
  parseHash,
  type Route,
  resetRouterForTest,
  useHistoryOverlay,
  useRouter,
} from "./router";

describe("router hash parsing and formatting", () => {
  it("round-trips shelf and encoded book routes", () => {
    const cases: [Route, string][] = [
      [{ kind: "shelf" }, "#/"],
      [{ kind: "reader", bookId: "dune" }, "#/book/dune"],
      [{ kind: "reader", bookId: "my book/1" }, "#/book/my%20book%2F1"],
    ];

    for (const [route, expectedHash] of cases) {
      expect(formatHash(route)).toBe(expectedHash);
      expect(parseHash(expectedHash)).toEqual(route);
    }
  });

  it("falls back to shelf for empty or unknown hashes", () => {
    expect(parseHash("")).toEqual({ kind: "shelf" });
    expect(parseHash("#")).toEqual({ kind: "shelf" });
    expect(parseHash("#/unknown/path")).toEqual({ kind: "shelf" });
    expect(parseHash("#/book/")).toEqual({ kind: "shelf" });
  });
});

function RouterHarness({ busyOverlay = false }: { busyOverlay?: boolean }) {
  const { route, openBook, closeBook } = useRouter();
  const [overlayOpen, setOverlayOpen] = useState(false);
  useHistoryOverlay(overlayOpen, () => setOverlayOpen(false), !busyOverlay);

  return (
    <div>
      <output data-testid="route">{JSON.stringify(route)}</output>
      <output data-testid="overlay">{overlayOpen ? "open" : "closed"}</output>
      <button type="button" onClick={() => openBook("dune")}>
        open-dune
      </button>
      <button type="button" onClick={closeBook}>
        close-book
      </button>
      <button type="button" onClick={() => setOverlayOpen((v) => !v)}>
        toggle-overlay
      </button>
    </div>
  );
}

function ReopenHarness({ onDismiss }: { onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  useHistoryOverlay(open, () => {
    onDismiss();
    setOpen(false);
  });
  return (
    <button type="button" onClick={() => setOpen((v) => !v)}>
      {open ? "open" : "closed"}
    </button>
  );
}

describe("useRouter & useHistoryOverlay", () => {
  it("pushes routes and returns to previous pages on browser back", async () => {
    const user = userEvent.setup();
    render(<RouterHarness />);

    expect(screen.getByTestId("route")).toHaveTextContent('{"kind":"shelf"}');

    await user.click(screen.getByRole("button", { name: "open-dune" }));
    expect(window.location.hash).toBe("#/book/dune");
    expect(screen.getByTestId("route")).toHaveTextContent('{"kind":"reader","bookId":"dune"}');

    await user.click(screen.getByRole("button", { name: "toggle-overlay" }));
    expect(screen.getByTestId("overlay")).toHaveTextContent("open");

    // 1st Back dismisses overlay without leaving the book.
    act(() => {
      window.history.back();
    });
    await waitFor(() => expect(screen.getByTestId("overlay")).toHaveTextContent("closed"));
    expect(screen.getByTestId("route")).toHaveTextContent('{"kind":"reader","bookId":"dune"}');

    // 2nd Back returns from reader to shelf.
    act(() => {
      window.history.back();
    });
    await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent('{"kind":"shelf"}'));
  });

  it("closes a deep-linked reader route cleanly via replace", async () => {
    const user = userEvent.setup();
    resetRouterForTest("#/book/dune");
    render(<RouterHarness />);

    expect(screen.getByTestId("route")).toHaveTextContent('{"kind":"reader","bookId":"dune"}');

    await user.click(screen.getByRole("button", { name: "close-book" }));
    expect(screen.getByTestId("route")).toHaveTextContent('{"kind":"shelf"}');
    expect(window.location.hash).toBe("#/");
  });

  it("prevents browser back from dismissing a busy overlay", async () => {
    const user = userEvent.setup();
    render(<RouterHarness busyOverlay />);

    await user.click(screen.getByRole("button", { name: "toggle-overlay" }));
    expect(screen.getByTestId("overlay")).toHaveTextContent("open");

    act(() => {
      window.history.back();
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId("overlay")).toHaveTextContent("open");
  });

  it("reuses the history slot safely when an overlay closes and immediately reopens", async () => {
    const onDismiss = vi.fn();

    const user = userEvent.setup();
    render(<ReopenHarness onDismiss={onDismiss} />);
    const btn = screen.getByRole("button");

    await user.click(btn);
    expect(btn).toHaveTextContent("open");
    await user.click(btn);
    expect(btn).toHaveTextContent("closed");
    await user.click(btn);
    expect(btn).toHaveTextContent("open");

    // Give any queued microtask/popstate time to settle: the reopened overlay
    // must remain open and never be closed by a stale popstate.
    await new Promise((r) => setTimeout(r, 30));
    expect(btn).toHaveTextContent("open");
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
