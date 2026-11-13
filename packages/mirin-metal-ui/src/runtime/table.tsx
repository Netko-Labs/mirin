/**
 * `<table>`, `<tr>`, `<th>`, `<td>`: every row is a CSS grid with the same
 * column template, so columns line up without measuring anything. A cell
 * with an explicit width (`w-[100px]`, `style.width`) pins its column to that
 * width; the other columns share the rest equally (`minmax(0, 1fr)`), and
 * `colSpan` spans grid columns. In a table sized by its content (`w-fit`),
 * `1fr` columns size to their content, as the layout engine resolves them.
 */

import type { Dimension, GridTrack } from "@mirinjs/metal";
import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useStyleTheme } from "../theme.ts";
import { styleFor } from "../tw/index.ts";
import { Box, type BoxProps, collectAttrs } from "./box.tsx";
import { GroupContext } from "./context.ts";
import { cssToMetal } from "./css.ts";

interface TableApi {
  /** Pinned widths by column index. */
  pinned: Record<number, Dimension>;
  /** Columns seen so far (max column + span). */
  columns: number;
  report: (column: number, span: number, width: Dimension | undefined) => void;
}

const TableContext = createContext<TableApi | null>(null);

/** The cell's first column and how many columns it spans. */
const ColumnContext = createContext<{ column: number; span: number } | null>(null);

export function HtmlTable(props: BoxProps): ReactNode {
  const [pinned, setPinned] = useState<Record<number, Dimension>>({});
  const [columns, setColumns] = useState(0);
  const report = useCallback((column: number, span: number, width: Dimension | undefined) => {
    setColumns((current) => Math.max(current, column + span));
    if (width !== undefined && span === 1) {
      setPinned((current) =>
        current[column] === width ? current : { ...current, [column]: width },
      );
    }
  }, []);
  const api = useMemo(() => ({ pinned, columns, report }), [pinned, columns, report]);
  return (
    <TableContext.Provider value={api}>
      <Box {...props} tag="table" />
    </TableContext.Provider>
  );
}

/** The shared column template: pinned widths, the rest `minmax(0, 1fr)`. */
function columnTemplate(table: TableApi, count: number): GridTrack[] {
  return Array.from({ length: count }, (_, index): GridTrack => {
    const pin = table.pinned[index];
    if (typeof pin === "number") return pin;
    if (typeof pin === "string" && pin.endsWith("%")) return pin as `${number}%`;
    return { min: 0, max: "1fr" };
  });
}

export function HtmlRow(props: BoxProps): ReactNode {
  const table = useContext(TableContext);
  let column = 0;
  const children = Children.toArray(props.children).map((child) => {
    if (!isValidElement(child)) return child;
    const span = Math.max(1, Number((child.props as { colSpan?: unknown }).colSpan) || 1);
    const node = (
      <ColumnContext.Provider key={child.key} value={{ column, span }}>
        {child}
      </ColumnContext.Provider>
    );
    column += span;
    return node;
  });
  if (!table) {
    return (
      <Box {...props} tag="tr">
        {children}
      </Box>
    );
  }
  // This row's own column count covers the first frame, before cells report.
  const count = Math.max(table.columns, column);
  return (
    <Box
      {...props}
      tag="tr"
      viewStyle={{
        ...(props.viewStyle ?? {}),
        display: "grid",
        gridTemplateColumns: columnTemplate(table, count),
      }}
    >
      {children}
    </Box>
  );
}

export function HtmlCell(props: BoxProps & { __tag: string }): ReactNode {
  const table = useContext(TableContext);
  const position = useContext(ColumnContext);
  const theme = useStyleTheme();
  const groups = useContext(GroupContext);
  const { className, style } = props;
  const attrs = collectAttrs(props);
  const attrsKey = JSON.stringify(attrs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attrsKey summarizes attrs
  const own = useMemo(() => {
    const tw = styleFor(className, theme.colors, theme.radius, {
      attrs,
      groups,
      dark: theme.mode === "dark",
      viewportWidth: theme.viewportWidth,
    });
    const width = cssToMetal(style).view.width ?? tw.view.width;
    // `w-full` fills the cell's column; it does not pin the column's width.
    return width === "100%" ? undefined : width;
  }, [className, style, theme, groups, attrsKey]);
  const report = table?.report;
  const column = position?.column ?? 0;
  const span = position?.span ?? 1;
  useLayoutEffect(() => {
    if (position) report?.(column, span, own);
  }, [report, position, column, span, own]);

  if (!table || !position) return <Box {...props} tag={props.__tag} />;
  return (
    <Box
      {...props}
      tag={props.__tag}
      viewStyle={{
        ...(props.viewStyle ?? {}),
        ...(span > 1 ? { gridColumn: { span } } : {}),
      }}
    />
  );
}
