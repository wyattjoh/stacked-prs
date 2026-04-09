import React from "react";
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import {
  buildStatusBar,
  HelpOverlay,
  KEY_BINDINGS_BY_SECTION,
  STATUS_BAR_ITEMS,
} from "./help-overlay.tsx";

describe("HelpOverlay", () => {
  test("lists every binding from KEY_BINDINGS_BY_SECTION", () => {
    const { lastFrame, unmount } = render(<HelpOverlay />);
    const f = lastFrame() ?? "";
    for (const section of KEY_BINDINGS_BY_SECTION) {
      for (const { keys } of section.bindings) {
        expect(f).toContain(keys);
      }
    }
    unmount();
  });
});

describe("status bar", () => {
  test("STATUS_BAR_ITEMS: all entries are bracketed keys only", () => {
    for (const item of STATUS_BAR_ITEMS) {
      expect(/^\[.+\]$/.test(item)).toBe(true);
    }
  });

  test("STATUS_BAR_ITEMS: includes the new L land binding", () => {
    expect(STATUS_BAR_ITEMS.includes("[L]")).toBe(true);
  });

  test("buildStatusBar: joins items with single space", () => {
    const bar = buildStatusBar(1000);
    expect(bar).toBe(STATUS_BAR_ITEMS.join(" "));
  });

  test("buildStatusBar: greedy fit truncates to width", () => {
    // Width 10 should fit "[?] [q]" (7 chars) but not the next item
    const bar = buildStatusBar(10);
    expect(bar.startsWith("[?] [q]")).toBe(true);
    expect(bar.length <= 10).toBe(true);
  });

  test("buildStatusBar: always renders at least the first item", () => {
    const bar = buildStatusBar(1);
    expect(bar).toBe(STATUS_BAR_ITEMS[0]);
  });
});

describe("KEY_BINDINGS_BY_SECTION", () => {
  test("has Navigation, Actions, View sections", () => {
    const names = KEY_BINDINGS_BY_SECTION.map((s) => s.title);
    expect(names).toEqual(["Navigation", "Actions", "View"]);
  });

  test("includes L for land in Actions", () => {
    const actions = KEY_BINDINGS_BY_SECTION.find((s) => s.title === "Actions")!;
    const landEntry = actions.bindings.find((b) => b.keys === "L");
    expect(landEntry).toBeDefined();
    expect(landEntry?.action).toBe("land stack (merged root or all merged)");
  });
});
