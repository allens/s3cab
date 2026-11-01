// The default theme, plus the OS switcher's tabs (os-switch.mjs) and the
// terminal recording the home page opens with (`homeRecording` in config.mjs
// puts it there).

import DefaultTheme from "vitepress/theme";
import { defineAsyncComponent } from "vue";
import { osSwitch } from "./os-switch.mjs";
import "./os-switch.css";

/** @import { Theme } from "vitepress" */

/** @type {Theme} */
export default {
  extends: DefaultTheme,
  setup: osSwitch,
  enhanceApp({ app }) {
    app.component(
      "HomeRecording",
      defineAsyncComponent(() => import("./HomeRecording.vue")),
    );
  },
};
