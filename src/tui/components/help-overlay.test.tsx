import React from "react";
import { assertEquals } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import {
  buildStatusBar,
  HelpOverlay,
  KEY_BINDINGS,
  STATUS_BAR_ITEMS,
} from "./help-overlay.tsx";

describe("HelpOverlay", () => {
  test("lists every binding from KEY_BINDINGS", () => {
    const { lastFrame, unmount } = render(<HelpOverlay />);
    const f = lastFrame() ?? "";
    for (const { keys } of KEY_BINDINGS) {
      expect(f).toContain(keys);
    }
    unmount();
  });
});

Deno.test("STATUS_BAR_ITEMS: all entries are bracketed keys only", () => {
  for (const item of STATUS_BAR_ITEMS) {
    assertEquals(
      /^\[.+\]$/.test(item),
      true,
      `expected "${item}" to be bracketed`,
    );
  }
});

Deno.test("STATUS_BAR_ITEMS: includes the new L land binding", () => {
  assertEquals(STATUS_BAR_ITEMS.includes("[L]"), true);
});

Deno.test("buildStatusBar: joins items with single space", () => {
  const bar = buildStatusBar(1000);
  assertEquals(bar, STATUS_BAR_ITEMS.join(" "));
});

Deno.test("buildStatusBar: greedy fit truncates to width", () => {
  // Width 10 should fit "[?] [q]" (7 chars) but not the next item
  const bar = buildStatusBar(10);
  assertEquals(bar.startsWith("[?] [q]"), true);
  assertEquals(bar.length <= 10, true);
});

Deno.test("buildStatusBar: always renders at least the first item", () => {
  const bar = buildStatusBar(1);
  assertEquals(bar, STATUS_BAR_ITEMS[0]);
});
