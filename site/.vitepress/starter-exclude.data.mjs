// The exclude playground's starting patterns: the starter `exclude.txt` a new
// set is born with, read at build time (a VitePress data loader).

import { sep } from "node:path";
import { starterExclude } from "../../src/lib/sets.mjs";

// sets.mjs writes the starter with the building machine's separator. Built on
// Windows, that would hand a macOS or Linux reader `\`, a filename character
// there; `/` reads the same on all three.
export default {
  load: () => starterExclude.replaceAll(sep, "/"),
};
