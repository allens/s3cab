// One page per guide/*.md, served at /guide/<topic> — the URL every shipped
// binary already prints (CLAUDE.md, "Every URL we print"). The pages are
// rendered from guide/ where they live, not copied: guide/ ships in the npm
// tarball and reads as plain markdown there and on GitHub, so it stays the one
// source. guide/README.md is the guide's own index, so it becomes /guide/.

import { readdirSync, readFileSync } from "node:fs";

const guide = new URL("../../guide/", import.meta.url);

export default {
  watch: ["../../guide/*.md"],
  paths() {
    return readdirSync(guide)
      .filter((file) => file.endsWith(".md"))
      .map((file) => ({
        params: { topic: file === "README.md" ? "index" : file.slice(0, -3) },
        content: readFileSync(new URL(file, guide), "utf8"),
      }));
  },
};
