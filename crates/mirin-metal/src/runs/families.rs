//! A run's font family (`InputRun::mono`): code in a note drawn monospace
//! inside a field set in the body font, or the reverse. GPUI's highlights
//! carry no family, so the stretches go to the text as family overrides
//! (`StyledText::with_font_family_overrides`), which cut its runs at their
//! edges.

use std::ops::Range;

use sumi::SharedString;

use crate::render::{mono_family, sans_family};

/// In the host binary while its fields draw runs in their own family (a
/// driver's check: an older host refuses a tree whose runs carry `mono`).
pub(crate) const RUN_FONT_MARKER: &str = "MIRIN_METAL_RUN_FONT";

/// Overlapping family runs as sorted stretches that don't overlap, the
/// later run winning where two cover the same text.
pub(crate) fn flatten(layers: &[(Range<usize>, bool)]) -> Vec<(Range<usize>, bool)> {
    let mut edges: Vec<usize> = layers
        .iter()
        .flat_map(|(range, _)| [range.start, range.end])
        .collect();
    edges.sort_unstable();
    edges.dedup();
    let mut out: Vec<(Range<usize>, bool)> = Vec::new();
    for pair in edges.windows(2) {
        let piece = pair[0]..pair[1];
        let Some(mono) = layers
            .iter()
            .rev()
            .find(|(range, _)| range.start <= piece.start && piece.end <= range.end)
            .map(|(_, mono)| *mono)
        else {
            continue;
        };
        match out.last_mut() {
            Some((last, was)) if last.end == piece.start && *was == mono => last.end = piece.end,
            _ => out.push((piece, mono)),
        }
    }
    out
}

/// The stretches as the text takes them: each with its family's name.
pub(crate) fn overrides(families: &[(Range<usize>, bool)]) -> Vec<(Range<usize>, SharedString)> {
    thread_local!(static TRACED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
    if !TRACED.with(|traced| traced.replace(true)) {
        crate::trace::log(format_args!(
            "{RUN_FONT_MARKER}: a field drew runs in their own family"
        ));
    }
    families
        .iter()
        .map(|(range, mono)| {
            let family = if *mono { mono_family() } else { sans_family() };
            (range.clone(), family)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::flatten;

    #[test]
    fn a_later_run_wins_and_neighbours_join() {
        // Code 4..10 with a body-font word 6..8 inside, and 10..12 code again.
        let out = flatten(&[(4..10, true), (6..8, false), (10..12, true)]);
        assert_eq!(out, vec![(4..6, true), (6..8, false), (8..12, true)]);
    }

    #[test]
    fn nothing_without_family_runs() {
        assert!(flatten(&[]).is_empty());
    }
}
