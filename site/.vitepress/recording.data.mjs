// VitePress runs this at build time and hands the page what `load` returns —
// a data loader, which the `.data.mjs` ending is what makes it.

import { cast } from "./cast.mjs";
import { recording } from "./recording.mjs";

const TITLE = "Back up, get a deleted file back, see what changed";

export default {
  async load() {
    return { title: TITLE, cast: cast(TITLE, await recording()) };
  },
};
