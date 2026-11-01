import assert from "node:assert/strict";
import { it } from "node:test";
import { createMarkdownRenderer } from "vitepress";
import config from "./config.mjs";

it("keeps the space a wrapped line ends with between two links", async () => {
  const md = await createMarkdownRenderer("site", config.markdown);
  assert.match(
    md.render("[a](https://a.example)\n[b](https://b.example)"),
    /<\/a> <a /,
  );
});
