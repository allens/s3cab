// The default theme, plus the OS switcher's tabs (os-switch.mjs).

/// <reference types="vite/client" />

import DefaultTheme from "vitepress/theme";
import { osSwitch } from "./os-switch.mjs";
import "./os-switch.css";

/** @import { Theme } from "vitepress" */

/** @type {Theme} */
export default {
  extends: DefaultTheme,
  setup: osSwitch,
};
