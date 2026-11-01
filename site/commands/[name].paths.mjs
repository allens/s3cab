// One page per command at /commands/<name>, and the reference's index at
// /commands/, generated from the command registry (command-pages.mjs).

import { commands } from "../../src/commands.mjs";
import { commandIndex, commandPage } from "../.vitepress/command-pages.mjs";

export default {
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
