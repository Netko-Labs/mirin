/**
 * `<table>`, `<tr>`, `<th>`, `<td>`: rows are flex rows, so columns only line
 * up if every row sizes its cells the same way. The table keeps a column
 * registry and measures its own width: a cell with an explicit width
 * (`w-[100px]`, `style.width`) pins its column, the other columns split what
 * is left equally, and every cell gets the px width of the columns it spans
 * (`colSpan`). Until the first layout, unpinned cells share the row equally.
 */

import type { Dimension } from "@mirinjs/metal";
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
import { useTheme } from "../theme.ts";
import { translate } from "../tw/index.ts";
import { Box, type BoxProps, collectAttrs } from "./box.tsx";
import { GroupContext } from "./context.ts";
import { cssToMetal } from "./css.ts";

interface TableApi {
  /** The table's measured width, once laid out. */
  width: number | undefined;
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
  const [width, setWidth] = useState<number | undefined>(undefined);
  const report = useCallback((column: number, span: number, width: Dimension | undefined) => {
    setColumns((current) => Math.max(current, column + span));
    if (width !== undefined && span === 1) {
      setPinned((current) =>
        current[column] === width ? current : { ...current, [column]: width },
      );
    }
  }, []);
  const api = useMemo(() => ({ width, pinned, columns, report }), [width, pinned, columns, report]);
  const { onLayout } = props;
  const measure = useCallback(
    (bounds: { x: number; y: number; width: number; height: number }) => {
      setWidth((current) =>
        current !== undefined && Math.abs(current - bounds.width) < 0.5 ? current : bounds.width,
      );
      onLayout?.(bounds);
    },
    [onLayout],
  );
  return (
    <TableContext.Provider value={api}>
      <Box {...props} tag="table" onLayout={measure} />
    </TableContext.Provider>
  );
}

export function HtmlRow(props: BoxProps): ReactNode {
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
  return (
    <Box {...props} tag="tr">
      {children}
    </Box>
  );
}

/** A pinned width in px against the table's width. */
function toPx(width: Dimension, tableWidth: number): number {
  return typeof width === "number" ? width : (tableWidth * Number.parseFloat(width)) / 100;
}

/** Px width of `span` columns from `column`: pinned ones as pinned, the rest share the remainder. */
function spannedWidth(table: TableApi, column: number, span: number): number {
  const total = table.width ?? 0;
  const count = Math.max(table.columns, column + span);
  let fixed = 0;
  let flexible = 0;
  for (let index = 0; index < count; index += 1) {
    const pin = table.pinned[index];
    if (pin === undefined) flexible += 1;
    else fixed += toPx(pin, total);
  }
  const share = flexible > 0 ? Math.max(0, total - fixed) / flexible : 0;
  let width = 0;
  for (let index = column; index < column + span; index += 1) {
    const pin = table.pinned[index];
    width += pin === undefined ? share : toPx(pin, total);
  }
  return Math.floor(width * 100) / 100;
}

export function HtmlCell(props: BoxProps & { __tag: string }): ReactNode {
  const table = useContext(TableContext);
  const position = useContext(ColumnContext);
  const theme = useTheme();
  const groups = useContext(GroupContext);
  const { className, style } = props;
  const attrs = collectAttrs(props);
  const attrsKey = JSON.stringify(attrs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attrsKey summarizes attrs
  const own = useMemo(() => {
    const tw = translate(className, theme.colors, theme.radius, {
      attrs,
      groups,
      dark: theme.mode === "dark",
      viewportWidth: theme.viewportWidth,
    });
    return cssToMetal(style).view.width ?? tw.view.width;
  }, [className, style, theme, groups, attrsKey]);
  const report = table?.report;
  const column = position?.column ?? 0;
  const span = position?.span ?? 1;
  useLayoutEffect(() => {
    if (position) report?.(column, span, own);
  }, [report, position, column, span, own]);

  if (!table || !position) return <Box {...props} tag={props.__tag} />;
  let width: Dimension | undefined;
  if (own !== undefined && span === 1) width = own;
  else if (table.width !== undefined) width = spannedWidth(table, column, span);
  else if (span === 1 && table.pinned[column] !== undefined) width = table.pinned[column];
  else if (Object.keys(table.pinned).length === 0 && table.columns > 0) {
    width = `${Math.round((10000 * span) / table.columns) / 100}%`;
  }
  return (
    <Box
      {...props}
      tag={props.__tag}
      viewStyle={{
        ...(props.viewStyle ?? {}),
        // Fixed columns don't grow; the rest share what the fixed ones leave.
        ...(width !== undefined ? { width, flex: 0, flexShrink: 0 } : { width: 0 }),
      }}
    />
  );
}
