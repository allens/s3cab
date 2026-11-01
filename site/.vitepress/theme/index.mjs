// The default theme, plus the terminal recording the home page opens with
// (`homeRecording` in config.mjs puts it there).

import DefaultTheme from "vitepress/theme";
import { defineAsyncComponent } from "vue";

/** @import { Theme } from "vitepress" */

/** @type {Theme} */
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component(
      "HomeRecording",
      defineAsyncComponent(() => import("./HomeRecording.vue")),
    );
  },
};
