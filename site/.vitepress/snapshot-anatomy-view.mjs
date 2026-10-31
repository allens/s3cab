// The snapshot-anatomy page's components. Render functions rather than a .vue
// template: inside a <pre> every character of a template is content, and here
// the type checker reads the components too.

import { computed, defineComponent, h, nextTick, onMounted, ref } from "vue";
import {
  COLUMN_TITLES,
  COLUMNS,
  ROWS,
  cellsOf,
  kindOf,
  specHref,
} from "./snapshot-anatomy.mjs";

/** @import { Ref, VNodeChild } from "vue" */
/** @import { Columns } from "./snapshot-anatomy.mjs" */

/**
 * Text with its `code` spans marked up.
 * @param {string} text
 * @returns {VNodeChild[]}
 */
const rich = (text) =>
  text.split("`").map((part, at) => (at % 2 ? h("code", part) : part));

/** @param {string} section */
const spec = (section) =>
  h("span", { class: "anatomy-spec" }, [
    "Spec: ",
    h("a", { href: specHref(section) }, section),
  ]);

/** The sample, which explains whichever part of it is pointed at, tapped or reached by keyboard. */
export const SnapshotSample = defineComponent({
  props: { text: { type: String, required: true } },
  setup(props) {
    const lines = computed(() =>
      props.text
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => ({ kind: kindOf(line), cells: cellsOf(line) })),
    );
    /** @type {Ref<{ line: number, col: number } | undefined>} */
    const at = ref();
    /** @type {Ref<{ querySelector(selector: string): { scrollIntoView(options: object): void } | null } | null>} */
    const pre = ref(null);
    // Until the page is interactive, the panel points at the list instead.
    const live = ref(false);
    onMounted(() => {
      live.value = true;
    });

    /** @param {number} line @param {number} col */
    const select = (line, col) => {
      at.value = { line, col };
    };

    /** @param {{ key: string, preventDefault(): void }} event */
    const onKeydown = (event) => {
      let { line, col } = at.value ?? { line: 0, col: 0 };
      if (event.key === "ArrowDown") {
        line = Math.min(line + 1, lines.value.length - 1);
      } else if (event.key === "ArrowUp") {
        line = Math.max(line - 1, 0);
      } else if (event.key === "ArrowRight") {
        col++;
      } else if (event.key === "ArrowLeft") {
        col--;
      } else if (event.key === "Home") {
        col = 0;
      } else if (event.key === "End") {
        col = Infinity;
      } else {
        return;
      }
      event.preventDefault();
      const cells = lines.value[line]?.cells.length ?? 1;
      select(line, Math.max(0, Math.min(col, cells - 1)));
      void nextTick(() =>
        pre.value
          ?.querySelector(".selected")
          ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
      );
    };

    const explanation = () => {
      const line = at.value && lines.value[at.value.line];
      if (!at.value || !line) {
        return h(
          "p",
          live.value
            ? "Point at any part of the sample or tap it, or tab to it and use the arrow keys, to see what it is."
            : "What each kind of row and column means is listed below the sample.",
        );
      }
      const row = ROWS[line.kind];
      if (!row) {
        return h("p", [
          "A row this page has no note for: ",
          h("code", line.kind),
        ]);
      }
      const column = row.columns && COLUMNS[row.columns][at.value.col];
      return [
        h("p", [
          h("strong", rich(row.title)),
          " — ",
          ...rich(row.text),
          " ",
          spec(row.section),
        ]),
        column &&
          h("p", [
            h("strong", `Column ${at.value.col + 1} of 5, ${column.label}:`),
            " ",
            ...rich(column.text),
            " ",
            spec(column.section),
          ]),
      ];
    };

    return () =>
      h("div", { class: "anatomy" }, [
        h("label", { class: "anatomy-toggle" }, [
          h("input", { type: "checkbox" }),
          " Show tabs and padding",
        ]),
        h(
          "pre",
          {
            ref: pre,
            class: "anatomy-sample",
            tabindex: 0,
            "aria-label":
              "Sample snapshot. Arrow keys move between rows and columns.",
            "aria-describedby": "anatomy-panel",
            onKeydown,
            onFocus: () => at.value ?? select(0, 0),
          },
          h(
            "code",
            lines.value.flatMap(({ cells }, l) => [
              h(
                "span",
                { class: { line: true, current: at.value?.line === l } },
                cells.map(({ value, pad, padFirst }, c) =>
                  h(
                    "span",
                    {
                      class: {
                        cell: true,
                        selected: at.value?.line === l && at.value.col === c,
                      },
                      onMouseenter: () => select(l, c),
                      onClick: () => select(l, c),
                    },
                    [
                      padFirst && h("span", { class: "pad" }, pad),
                      value,
                      !padFirst && pad && h("span", { class: "pad" }, pad),
                      c < cells.length - 1 && h("span", { class: "tab" }, "\t"),
                    ],
                  ),
                ),
              ),
              "\n",
            ]),
          ),
        ),
        h(
          "div",
          {
            id: "anatomy-panel",
            class: "anatomy-panel",
            "aria-live": "polite",
          },
          explanation(),
        ),
      ]);
  },
});

/** What every kind of row means, as a plain list. */
export const RowReference = defineComponent(
  () => () =>
    h(
      "dl",
      Object.values(ROWS).flatMap((row) => [
        h("dt", rich(row.title)),
        h("dd", [...rich(row.text), " ", spec(row.section)]),
      ]),
    ),
);

/** What each column holds, for each kind of row, as a plain list. */
export const ColumnReference = defineComponent(
  () => () =>
    h(
      "dl",
      /** @type {[Columns, string][]} */ (
        Object.entries(COLUMN_TITLES)
      ).flatMap(([columns, title]) => [
        h("dt", rich(title)),
        h(
          "dd",
          h(
            "ol",
            COLUMNS[columns].map((column) =>
              h("li", [
                h("strong", `${column.label}:`),
                " ",
                ...rich(column.text),
                " ",
                spec(column.section),
              ]),
            ),
          ),
        ),
      ]),
    ),
);
