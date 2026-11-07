//! Styled runs in an `input` (`InputProps::runs`): the driver says how parts
//! of the text are drawn (a color, a weight, italic, a wash behind them, an
//! underline, a strikethrough) and which paragraphs are drawn at another
//! size, and a run can take presses (`press`). The text stays the driver's
//! value; runs only change how it is drawn, so the caret, the selection and
//! every edit work as they do in plain text. An app that formats Markdown as
//! it is typed (a note's `**bold**` drawn bold, its markers faded) is the use.
//!
//! Runs are UTF-16 offsets into the value, as the selection is. Where runs
//! overlap the later one wins, attribute by attribute; a composition's
//! underline is drawn over them all.

use std::ops::Range;

use gpui::{
    px, rgba, FontStyle, FontWeight, HighlightStyle, Pixels, StrikethroughStyle, UnderlineStyle,
};

use crate::tree::{parse_color, InputRun, Weight};

/// Runs past this many are not drawn (the driver is a trust boundary).
pub(crate) const MAX_RUNS: usize = 8192;
/// A run's `size` is kept inside this range.
const SIZE_RANGE: (f32, f32) = (4.0, 200.0);

/// In the host binary while its fields draw styled runs (a driver's check).
pub(crate) const RUNS_MARKER: &str = "MIRIN_METAL_RUNS";

/// The char index of each UTF-16 offset of a buffer: where each char starts
/// in UTF-16 units, and one past the end.
pub(crate) struct Units(Vec<usize>);

impl Units {
    pub(crate) fn new(buffer: &str) -> Self {
        let mut units = Vec::with_capacity(buffer.len() + 1);
        let mut at = 0;
        for ch in buffer.chars() {
            units.push(at);
            at += ch.len_utf16();
        }
        units.push(at);
        Self(units)
    }

    /// The char at UTF-16 `offset` (clamped; inside a char, that char).
    pub(crate) fn char_at(&self, offset: usize) -> usize {
        self.0
            .partition_point(|&unit| unit <= offset)
            .saturating_sub(1)
    }

    /// Where char `index` starts, in UTF-16 units (clamped).
    pub(crate) fn offset_of(&self, index: usize) -> usize {
        self.0[index.min(self.0.len() - 1)]
    }

    /// A run's chars.
    fn chars(&self, run: &InputRun) -> Range<usize> {
        let start = self.char_at(run.start);
        start..self.char_at(run.end.max(run.start)).max(start)
    }
}

/// How a field's text is drawn: its highlights (sorted, apart) and each
/// paragraph's size (`None`: the field's own; empty: none is sized).
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Styled {
    pub(crate) highlights: Vec<(Range<usize>, HighlightStyle)>,
    pub(crate) sizes: Vec<Option<Pixels>>,
}

/// The runs of a field holding `buffer`, drawn as `text` whose buffer chars
/// start at `bytes` (`Display::buffer_bytes`), with `over` (a composition's
/// underline) drawn on top.
pub(crate) fn style(
    runs: &[InputRun],
    buffer: &str,
    text: &str,
    bytes: &[usize],
    over: Option<(Range<usize>, HighlightStyle)>,
) -> Styled {
    let units = Units::new(buffer);
    let byte = |index: usize| bytes[index.min(bytes.len() - 1)];
    let mut layers = Vec::new();
    let mut sized = Vec::new();
    for run in runs.iter().take(MAX_RUNS) {
        let chars = units.chars(run);
        let range = byte(chars.start)..byte(chars.end);
        if let Some(size) = run.size.filter(|size| size.is_finite()) {
            sized.push((range.clone(), size.clamp(SIZE_RANGE.0, SIZE_RANGE.1)));
        }
        let look = highlight(run);
        if !range.is_empty() && look != HighlightStyle::default() {
            layers.push((range, look));
        }
    }
    layers.extend(over);
    trace_once();
    Styled {
        highlights: flatten(&layers),
        sizes: paragraph_sizes(text, &sized),
    }
}

/// Say once, in the trace, that this host draws runs.
pub(crate) fn trace_once() {
    thread_local!(static TRACED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
    if !TRACED.with(|traced| traced.replace(true)) {
        crate::trace::log(format_args!("{RUNS_MARKER}: a field drew styled runs"));
    }
}

/// The run (its index) that takes a press on buffer char `index`: the last
/// pressable run holding it.
pub(crate) fn pressed(runs: &[InputRun], buffer: &str, index: usize) -> Option<usize> {
    let units = Units::new(buffer);
    runs.iter()
        .take(MAX_RUNS)
        .enumerate()
        .rev()
        .find(|(_, run)| run.press && units.chars(run).contains(&index))
        .map(|(at, _)| at)
}

fn highlight(run: &InputRun) -> HighlightStyle {
    let color = |value: &Option<String>| {
        value
            .as_deref()
            .and_then(parse_color)
            .map(|color| rgba(color).into())
    };
    HighlightStyle {
        color: color(&run.color),
        background_color: color(&run.background),
        font_weight: run.weight.map(|weight| match weight {
            Weight::Normal => FontWeight::NORMAL,
            Weight::Medium => FontWeight::MEDIUM,
            Weight::Semibold => FontWeight::SEMIBOLD,
            Weight::Bold => FontWeight::BOLD,
        }),
        font_style: run.italic.then_some(FontStyle::Italic),
        underline: run.underline.then_some(UnderlineStyle {
            thickness: px(1.0),
            color: None,
            wavy: false,
        }),
        strikethrough: run.strikethrough.then_some(StrikethroughStyle {
            thickness: px(1.0),
            color: None,
        }),
        fade_out: None,
    }
}

/// `top` over `base`, attribute by attribute.
fn merge(base: HighlightStyle, top: HighlightStyle) -> HighlightStyle {
    HighlightStyle {
        color: top.color.or(base.color),
        font_weight: top.font_weight.or(base.font_weight),
        font_style: top.font_style.or(base.font_style),
        background_color: top.background_color.or(base.background_color),
        underline: top.underline.or(base.underline),
        strikethrough: top.strikethrough.or(base.strikethrough),
        fade_out: top.fade_out.or(base.fade_out),
    }
}

/// Overlapping layers as GPUI takes highlights: sorted ranges that don't
/// overlap, each the layers over it merged in order (a later one on top).
pub(crate) fn flatten(
    layers: &[(Range<usize>, HighlightStyle)],
) -> Vec<(Range<usize>, HighlightStyle)> {
    let mut edges: Vec<usize> = layers
        .iter()
        .flat_map(|(range, _)| [range.start, range.end])
        .collect();
    edges.sort_unstable();
    edges.dedup();
    let mut out: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    for pair in edges.windows(2) {
        let piece = pair[0]..pair[1];
        let mut look = None;
        for (range, style) in layers {
            if range.start <= piece.start && piece.end <= range.end {
                look = Some(merge(look.unwrap_or_default(), *style));
            }
        }
        let Some(look) = look else {
            continue;
        };
        match out.last_mut() {
            Some((last, style)) if last.end == piece.start && *style == look => {
                last.end = piece.end;
            }
            _ => out.push((piece, look)),
        }
    }
    out
}

/// Each paragraph of `text` (between newlines) at the largest size of the
/// sized runs over it (or starting in it, when it is empty); `[]` when no
/// run is sized.
fn paragraph_sizes(text: &str, sized: &[(Range<usize>, f32)]) -> Vec<Option<Pixels>> {
    if sized.is_empty() {
        return Vec::new();
    }
    let mut sizes = Vec::new();
    let mut start = 0;
    for paragraph in text.split('\n') {
        let end = start + paragraph.len();
        let size = sized
            .iter()
            .filter(|(range, _)| {
                (range.start < end && range.end > start)
                    || (start <= range.start && range.start <= end)
            })
            .map(|(_, size)| *size)
            .fold(None, |most: Option<f32>, size| {
                Some(most.map_or(size, |most| most.max(size)))
            });
        sizes.push(size.map(px));
        start = end + 1;
    }
    sizes
}

#[cfg(test)]
mod tests;
