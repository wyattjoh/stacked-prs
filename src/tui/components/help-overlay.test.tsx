import React from "react";
import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render } from "ink-testing-library";
import { HelpOverlay, KEY_BINDINGS } from "./help-overlay.tsx";

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
