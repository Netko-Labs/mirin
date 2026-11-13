/**
 * The stress bench's app (`bench/stress.tsx`): a dashboard of `rows × cols`
 * cards (about six nodes each) under a field, a banner and a layout switch.
 * As written it is an app that memoizes nothing: typing a character or
 * growing the banner renders every card again. `memo` makes each card a
 * `memo` component with its styles hoisted, the floor for the same app: an
 * update then renders the dashboard and its row views, not the cards.
 */

import { memo, type ReactElement, useState } from "react";
import { ScrollView, Text, TextInput, View } from "../../src/index.ts";

export interface DashboardOptions {
  rows: number;
  cols: number;
  /** Every card's drop shadow (`--shadow`). */
  shadow?: "sm";
  /** Memoized cards with hoisted styles (`--memo`). */
  memo?: boolean;
}

function Card({ index, shadow }: { index: number; shadow?: "sm" }): ReactElement {
  const [selected, setSelected] = useState(false);
  return (
    <View
      testID={`card:${index}`}
      onPress={() => setSelected((value) => !value)}
      style={{
        width: 44,
        padding: 4,
        gap: 2,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: selected ? "#3b82f6" : "#27272a",
        backgroundColor: selected ? "#1e3a8a" : "#18181b",
        hoverBackgroundColor: "#27272a",
        shadow,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 9, color: "#a1a1aa" }}>#{index}</Text>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#22c55e" }} />
      </View>
      <Text style={{ fontSize: 11, color: "#f4f4f5" }}>{(index * 7919) % 1000}</Text>
    </View>
  );
}

const CARD = { width: 44, padding: 4, gap: 2, borderRadius: 6, borderWidth: 1 } as const;
const CARD_STYLES = {
  plain: { ...CARD, borderColor: "#27272a", backgroundColor: "#18181b" },
  selected: { ...CARD, borderColor: "#3b82f6", backgroundColor: "#1e3a8a" },
};
const HEAD = { flexDirection: "row", justifyContent: "space-between" } as const;
const NUMBER = { fontSize: 9, color: "#a1a1aa" } as const;
const DOT = { width: 6, height: 6, borderRadius: 3, backgroundColor: "#22c55e" } as const;
const VALUE = { fontSize: 11, color: "#f4f4f5" } as const;

/** `Card` as an app that memoizes would write it: the same nodes, the same props sent. */
const MemoCard = memo(function MemoCard({
  index,
  shadow,
}: {
  index: number;
  shadow?: "sm";
}): ReactElement {
  const [selected, setSelected] = useState(false);
  const look = selected ? CARD_STYLES.selected : CARD_STYLES.plain;
  return (
    <View
      testID={`card:${index}`}
      onPress={() => setSelected((value) => !value)}
      style={{ ...look, hoverBackgroundColor: "#27272a", shadow }}
    >
      <View style={HEAD}>
        <Text style={NUMBER}>#{index}</Text>
        <View style={DOT} />
      </View>
      <Text style={VALUE}>{(index * 7919) % 1000}</Text>
    </View>
  );
});

export function Dashboard({ rows, cols, shadow, memo: memoized }: DashboardOptions): ReactElement {
  const [query, setQuery] = useState("");
  const [tall, setTall] = useState(false);
  // How the cards are laid out: in the window, in a scroll view, or in
  // columns in a view that scrolls across.
  const [mode, setMode] = useState<"plain" | "scroll" | "wide">("plain");
  const Each = memoized ? MemoCard : Card;
  const banner = (
    <View
      testID="banner"
      onPress={() => setTall((value) => !value)}
      style={{ height: tall ? 40 : 12, borderRadius: 4, backgroundColor: "#3f3f46" }}
    />
  );
  const grid = Array.from({ length: rows }, (_, row) => (
    <View key={row} style={{ flexDirection: "row", gap: 2 }}>
      {Array.from({ length: cols }, (_, col) => (
        <Each key={col} index={row * cols + col} shadow={shadow} />
      ))}
    </View>
  ));
  const perColumn = 12;
  const columns = Array.from({ length: Math.ceil((rows * cols) / perColumn) }, (_, column) => (
    <View key={column} style={{ gap: 2 }}>
      {Array.from({ length: Math.min(perColumn, rows * cols - column * perColumn) }, (_, index) => (
        <Each key={index} index={column * perColumn + index} shadow={shadow} />
      ))}
    </View>
  ));
  const next = { plain: "scroll", scroll: "wide", wide: "plain" } as const;
  return (
    <View style={{ flex: 1, backgroundColor: "#09090b", padding: 8, gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Text style={{ color: "#f4f4f5", fontSize: 14 }}>
          stress {rows}×{cols}
        </Text>
        <TextInput
          testID="query"
          value={query}
          onChangeText={setQuery}
          style={{ width: 240, height: 24, color: "#f4f4f5", backgroundColor: "#18181b" }}
        />
        <Text style={{ color: "#a1a1aa", fontSize: 12 }}>{query.length} chars</Text>
        <View
          testID="layout"
          onPress={() => setMode((value) => next[value])}
          style={{ width: 12, height: 12, backgroundColor: "#52525b" }}
        />
      </View>
      {mode === "wide" ? (
        <View testID="hscroller" style={{ flex: 1, overflow: "scroll-x" }}>
          <View style={{ flexDirection: "row", gap: 2, alignItems: "flex-start" }}>{columns}</View>
        </View>
      ) : mode === "scroll" ? (
        <ScrollView testID="scroller" style={{ flex: 1, gap: 8 }}>
          {banner}
          <View style={{ gap: 2 }}>{grid}</View>
        </ScrollView>
      ) : (
        <>
          {banner}
          <View style={{ flex: 1, gap: 2, overflow: "hidden" }}>{grid}</View>
        </>
      )}
    </View>
  );
}
