// One page per command at /commands/<name>, and the reference's index at
// /commands/, generated from the command registry (command-pages.mjs). Under
// `docs:dev`, an edit to the registry shows only after a restart; a guide's
// title, which a page links by, refreshes on its own.

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
