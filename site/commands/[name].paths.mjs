// One page per command at /commands/<name>, and the reference's index at
// /commands/, generated from the command registry (command-pages.mjs). A page
// links its guide by the guide's title, read from guide/, hence the watch.

import { commands } from "../../src/commands.mjs";
import { commandIndex, commandPage } from "../.vitepress/command-pages.mjs";

export default {
  watch: ["../../guide/*.md"],
  paths() {
    return [
      { params: { name: "index" }, content: commandIndex() },
      ...Object.entries(commands).map(([name, command]) => ({
        params: { name },
        content: commandPage(name, command),
      })),
    ];
  },
};
