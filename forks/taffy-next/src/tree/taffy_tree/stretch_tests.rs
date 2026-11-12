//! mirin: a row laid out again at another width answers from what it
//! computed before when the width changes nothing but itself
//! (`Cache::get_stretched`). Trees kept across widths must lay out exactly
//! what the same trees laid out from nothing do. Port of `../taffy`'s
//! (0.9) tests, with what 0.15 added: right-to-left rows, sizing keywords,
//! statically positioned items (not containing blocks).

use super::*;
use crate::style::{AlignItems, Direction, FlexDirection, FlexWrap, JustifyContent, Position};
use crate::style_helpers::*;
use crate::tree::cache::STRETCHED;
use crate::{Dimension, LengthPercentage, LengthPercentageAuto, Rect};

/// A small deterministic generator (an LCG), so failures reproduce.
struct Random(u64);

impl Random {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }

    /// True one time in `n`.
    fn one_in(&mut self, n: u32) -> bool {
        self.next() % n == 0
    }

    fn range(&mut self, low: f32, high: f32) -> f32 {
        low + (self.next() % 10_000) as f32 / 10_000.0 * (high - low)
    }
}

/// A text-like leaf: `chars` glyphs 7 px wide in words of five, lines 10 px.
fn measure(known: Size<Option<f32>>, available: Size<AvailableSpace>, chars: Option<&mut usize>) -> Size<f32> {
    let Some(chars) = chars.map(|chars| *chars as f32) else {
        return Size::ZERO;
    };
    let full = chars * 7.0;
    let word = full.min(35.0);
    let width = known.width.unwrap_or(match available.width {
        AvailableSpace::MinContent => word,
        AvailableSpace::MaxContent => full,
        AvailableSpace::Definite(width) => full.min(width).max(word),
    });
    let lines = (full / width.max(1.0)).ceil().max(1.0);
    Size { width, height: known.height.unwrap_or(lines * 10.0) }
}

/// A length, now and then a percentage.
fn some_length(random: &mut Random, high: f32, percent_one_in: u32) -> LengthPercentage {
    if random.one_in(percent_one_in) {
        LengthPercentage::percent(random.range(0.0, 0.1))
    } else {
        LengthPercentage::length(random.range(0.0, high))
    }
}

/// Mostly relative (GPUI's default, a containing block), now and then static.
fn some_position(random: &mut Random) -> Position {
    if random.one_in(8) {
        Position::Static
    } else {
        Position::Relative
    }
}

/// An item of a row: a box of a set width (mostly), text, or a column of rows.
fn item(taffy: &mut TaffyTree<usize>, random: &mut Random, depth: u32) -> NodeId {
    let mut style = Style {
        position: some_position(random),
        flex_shrink: if random.one_in(3) { 0.0 } else { 1.0 },
        flex_grow: if random.one_in(12) { 1.0 } else { 0.0 },
        padding: Rect::length(random.range(0.0, 3.0)),
        border: Rect::length(if random.one_in(3) { 1.0 } else { 0.0 }),
        ..Default::default()
    };
    if random.one_in(10) {
        style.margin.left = if random.one_in(2) { auto() } else { LengthPercentageAuto::percent(0.02) };
    } else if random.one_in(3) {
        style.margin.left = length(random.range(0.0, 4.0));
    }
    if random.one_in(15) {
        style.position = Position::Absolute;
        style.inset.left = length(random.range(0.0, 30.0));
    }
    if random.one_in(20) {
        style.min_size.width = length(random.range(10.0, 60.0));
    }
    if random.one_in(20) {
        style.max_size.width = length(random.range(20.0, 80.0));
    }
    let kind = random.next() % 10;
    if kind < 5 {
        style.size.width = match random.next() % 24 {
            0 | 1 => Dimension::percent(random.range(0.05, 0.3)),
            2 => Dimension::stretch(),
            3 => Dimension::fit_content_px(random.range(16.0, 90.0)),
            4 => Dimension::fit_content(),
            _ => length(random.range(16.0, 90.0)),
        };
        let children: Vec<NodeId> = (0..random.next() % 3).map(|_| text(taffy, random)).collect();
        if random.one_in(10) {
            // An absolutely placed box inside: its containing block is the
            // item, or (a static item) the row or further out.
            let mark = taffy
                .new_leaf(Style {
                    position: Position::Absolute,
                    inset: Rect { left: auto(), right: length(2.0), top: length(1.0), bottom: auto() },
                    size: Size { width: length(4.0), height: length(4.0) },
                    ..Default::default()
                })
                .unwrap();
            let mut children = children;
            children.push(mark);
            if random.one_in(2) {
                style.position = Position::Static;
            }
            style.flex_direction = FlexDirection::Column;
            return taffy.new_with_children(style, &children).unwrap();
        }
        style.flex_direction = FlexDirection::Column;
        taffy.new_with_children(style, &children).unwrap()
    } else if kind < 8 || depth >= 3 {
        let chars = (random.next() % 40) as usize + 1;
        taffy.new_leaf_with_context(style, chars).unwrap()
    } else {
        style.flex_direction = FlexDirection::Column;
        style.gap.height = some_length(random, 4.0, 20);
        let rows: Vec<NodeId> = (0..random.next() % 3 + 1).map(|_| row(taffy, random, depth + 1)).collect();
        taffy.new_with_children(style, &rows).unwrap()
    }
}

fn text(taffy: &mut TaffyTree<usize>, random: &mut Random) -> NodeId {
    let chars = (random.next() % 12) as usize + 1;
    taffy.new_leaf_with_context(Style::default(), chars).unwrap()
}

/// A row, mostly one whose items keep their place from its start.
fn row(taffy: &mut TaffyTree<usize>, random: &mut Random, depth: u32) -> NodeId {
    let justify = match random.next() % 12 {
        0 => Some(JustifyContent::CENTER),
        1 => Some(JustifyContent::SPACE_BETWEEN),
        2 => Some(JustifyContent::FLEX_END),
        3 | 4 => Some(JustifyContent::START),
        _ => None,
    };
    let mut style = Style {
        position: some_position(random),
        direction: if random.one_in(15) { Direction::Rtl } else { Direction::Ltr },
        flex_direction: if random.one_in(15) { FlexDirection::RowReverse } else { FlexDirection::Row },
        flex_wrap: if random.one_in(10) { FlexWrap::Wrap } else { FlexWrap::NoWrap },
        align_items: match random.next() % 4 {
            0 => AlignItems::CENTER,
            1 => AlignItems::FLEX_START,
            _ => Style::<DefaultCheapStr>::DEFAULT.align_items,
        },
        gap: Size { width: some_length(random, 6.0, 15), height: length(0.0) },
        padding: Rect {
            left: some_length(random, 8.0, 20),
            right: length(random.range(0.0, 8.0)),
            top: length(random.range(0.0, 4.0)),
            bottom: length(0.0),
        },
        border: Rect::length(if random.one_in(4) { 1.0 } else { 0.0 }),
        ..Default::default()
    };
    if let Some(justify) = justify {
        style.justify_content = justify;
    }
    let count = random.next() % 12 + 1;
    let items: Vec<NodeId> = (0..count).map(|_| item(taffy, random, depth)).collect();
    taffy.new_with_children(style, &items).unwrap()
}

/// A page: a column of rows, built the same from the same seed.
fn page(seed: u64) -> (TaffyTree<usize>, NodeId) {
    let mut random = Random(seed);
    let mut taffy = TaffyTree::new();
    let rows: Vec<NodeId> = (0..random.next() % 8 + 1).map(|_| row(&mut taffy, &mut random, 0)).collect();
    let root = taffy
        .new_with_children(
            Style {
                position: Position::Relative,
                flex_direction: FlexDirection::Column,
                gap: length(2.0),
                padding: length(8.0),
                ..Default::default()
            },
            &rows,
        )
        .unwrap();
    (taffy, root)
}

/// Lay `root` out `width` wide (the root's own width: it stretches its
/// rows to it), as GPUI does a window's root. Counts the measure calls.
fn lay_out(taffy: &mut TaffyTree<usize>, root: NodeId, width: f32) -> usize {
    let mut style = taffy.style(root).unwrap().clone();
    style.size.width = length(width);
    taffy.set_style(root, style).unwrap();
    let space = Size { width: AvailableSpace::Definite(width), height: AvailableSpace::MaxContent };
    let mut measured = 0;
    taffy
        .compute_layout_with_measure(root, space, |input, _, chars, style| {
            compute_leaf_layout(input, style, |_, _| 0.0, |known, available| {
                measured += 1;
                measure(known, available, chars)
            })
        })
        .unwrap();
    measured
}

/// Every node's layout, rounded and not, in tree order.
fn layouts(taffy: &TaffyTree<usize>, node: NodeId, out: &mut Vec<(Layout, Layout)>) {
    out.push((*taffy.layout(node).unwrap(), *taffy.unrounded_layout(node)));
    for child in taffy.children(node).unwrap() {
        layouts(taffy, child, out);
    }
}

#[test]
fn trees_kept_across_widths_lay_out_what_fresh_trees_do() {
    let widths: Vec<f32> = {
        let mut random = Random(7);
        (0..14).map(|_| random.range(120.0, 1100.0).round()).chain([1100.0, 1099.5, 1100.0, 300.0, 1100.0]).collect()
    };
    STRETCHED.with(|count| count.set(0));
    for seed in 0..32 {
        let (mut kept, kept_root) = page(seed);
        for &width in &widths {
            lay_out(&mut kept, kept_root, width);
            let (mut fresh, fresh_root) = page(seed);
            lay_out(&mut fresh, fresh_root, width);
            let (mut a, mut b) = (Vec::new(), Vec::new());
            layouts(&kept, kept_root, &mut a);
            layouts(&fresh, fresh_root, &mut b);
            assert_eq!(a.len(), b.len());
            for (index, (a, b)) in a.iter().zip(&b).enumerate() {
                assert_eq!(a, b, "seed {seed}, width {width}, node {index}");
            }
        }
    }
    // The rows did answer from another width, many times.
    assert!(STRETCHED.with(|count| count.get()) > 300, "{}", STRETCHED.with(|count| count.get()));
}

/// A card of the stress bench (`packages/mirin-metal/bench/stress.tsx`): a
/// column 44 wide with a head row (a number, a dot) and a value.
fn card(taffy: &mut TaffyTree<usize>) -> NodeId {
    let relative = || Style { position: Position::Relative, ..Default::default() };
    let number = taffy.new_leaf_with_context(relative(), 3).unwrap();
    let dot =
        taffy.new_leaf(Style { size: Size { width: length(6.0), height: length(6.0) }, ..relative() }).unwrap();
    let head = taffy
        .new_with_children(Style { justify_content: JustifyContent::SPACE_BETWEEN, ..relative() }, &[number, dot])
        .unwrap();
    let value = taffy.new_leaf_with_context(relative(), 3).unwrap();
    let style = Style {
        flex_direction: FlexDirection::Column,
        size: Size { width: length(44.0), height: auto() },
        padding: Rect::length(4.0),
        border: Rect::length(1.0),
        gap: length(2.0),
        ..relative()
    };
    taffy.new_with_children(style, &[head, value]).unwrap()
}

/// `rows` rows of `cols` cards in a column (the stress bench's grid).
fn grid(taffy: &mut TaffyTree<usize>, rows: usize, cols: usize) -> NodeId {
    let relative = || Style { position: Position::Relative, ..Default::default() };
    let rows: Vec<NodeId> = (0..rows)
        .map(|_| {
            let cards: Vec<NodeId> = (0..cols).map(|_| card(taffy)).collect();
            taffy.new_with_children(Style { gap: length(2.0), ..relative() }, &cards).unwrap()
        })
        .collect();
    let column = taffy
        .new_with_children(Style { flex_direction: FlexDirection::Column, gap: length(2.0), ..relative() }, &rows)
        .unwrap();
    taffy
        .new_with_children(Style { flex_direction: FlexDirection::Column, padding: length(8.0), ..relative() }, &[column])
        .unwrap()
}

#[test]
fn a_grid_resized_measures_nothing_again() {
    let mut taffy = TaffyTree::new();
    let root = grid(&mut taffy, 20, 10);
    lay_out(&mut taffy, root, 1200.0);
    // Wider than its rows: every row answers from its last width; no card
    // (nor its text) is asked again.
    for width in [1100.0, 1000.0, 1150.5, 900.0] {
        STRETCHED.with(|count| count.set(0));
        assert_eq!(lay_out(&mut taffy, root, width), 0, "at {width}");
        assert!(STRETCHED.with(|count| count.get()) >= 20);
    }
    let mut fresh = TaffyTree::new();
    let fresh_root = grid(&mut fresh, 20, 10);
    lay_out(&mut fresh, fresh_root, 900.0);
    let (mut a, mut b) = (Vec::new(), Vec::new());
    layouts(&taffy, root, &mut a);
    layouts(&fresh, fresh_root, &mut b);
    assert_eq!(a, b);
}

#[test]
fn a_row_of_set_widths_answers_from_another_width_until_its_items_shrink() {
    let cards = |taffy: &mut TaffyTree<usize>| -> NodeId {
        let relative = || Style { position: Position::Relative, ..Default::default() };
        let cards: Vec<NodeId> = (0..5)
            .map(|_| {
                let style = Style {
                    flex_direction: FlexDirection::Column,
                    size: Size { width: length(44.0), height: auto() },
                    ..relative()
                };
                let text = taffy.new_leaf_with_context(Style::default(), 3).unwrap();
                taffy.new_with_children(style, &[text]).unwrap()
            })
            .collect();
        let row = taffy.new_with_children(Style { gap: length(2.0), ..relative() }, &cards).unwrap();
        taffy.new_with_children(Style { flex_direction: FlexDirection::Column, ..relative() }, &[row]).unwrap()
    };
    let mut taffy = TaffyTree::new();
    let root = cards(&mut taffy);
    lay_out(&mut taffy, root, 600.0);
    // 5 × 44 + 4 × 2 = 228: wider, the row is answered as it was.
    STRETCHED.with(|count| count.set(0));
    lay_out(&mut taffy, root, 500.0);
    lay_out(&mut taffy, root, 229.0);
    assert!(STRETCHED.with(|count| count.get()) >= 2);
    // Narrower, its cards shrink: laid out again, as from nothing.
    lay_out(&mut taffy, root, 200.0);
    let mut fresh = TaffyTree::new();
    let fresh_root = cards(&mut fresh);
    lay_out(&mut fresh, fresh_root, 200.0);
    let (mut a, mut b) = (Vec::new(), Vec::new());
    layouts(&taffy, root, &mut a);
    layouts(&fresh, fresh_root, &mut b);
    assert_eq!(a, b);
}

/// A row of 44-wide boxes, one of them `odd`, in a column, laid out wide,
/// then narrower: the same as laying it out there from nothing.
fn kept_and_fresh_agree(odd: impl Fn(&mut TaffyTree<usize>) -> NodeId) {
    let build = |taffy: &mut TaffyTree<usize>| -> NodeId {
        let relative = || Style { position: Position::Relative, ..Default::default() };
        let mut items: Vec<NodeId> = (0..3)
            .map(|_| {
                let style = Style { size: Size { width: length(44.0), height: length(10.0) }, ..relative() };
                taffy.new_leaf(style).unwrap()
            })
            .collect();
        items.push(odd(taffy));
        let row = taffy.new_with_children(Style { gap: length(2.0), ..relative() }, &items).unwrap();
        taffy.new_with_children(Style { flex_direction: FlexDirection::Column, ..relative() }, &[row]).unwrap()
    };
    let mut taffy = TaffyTree::new();
    let root = build(&mut taffy);
    lay_out(&mut taffy, root, 600.0);
    lay_out(&mut taffy, root, 500.0);
    let mut fresh = TaffyTree::new();
    let fresh_root = build(&mut fresh);
    lay_out(&mut fresh, fresh_root, 500.0);
    let (mut a, mut b) = (Vec::new(), Vec::new());
    layouts(&taffy, root, &mut a);
    layouts(&fresh, fresh_root, &mut b);
    assert_eq!(a, b);
}

#[test]
fn a_row_placing_a_box_from_its_end_is_laid_out_again() {
    // A static item is no containing block: its absolutely placed child is
    // the row's, placed from the row's right edge.
    kept_and_fresh_agree(|taffy| {
        let mark = taffy
            .new_leaf(Style {
                position: Position::Absolute,
                inset: Rect { left: auto(), right: length(2.0), top: length(1.0), bottom: auto() },
                size: Size { width: length(4.0), height: length(4.0) },
                ..Default::default()
            })
            .unwrap();
        let style = Style { size: Size { width: length(20.0), height: length(10.0) }, ..Default::default() };
        taffy.new_with_children(style, &[mark]).unwrap()
    });
}

#[test]
fn a_row_with_an_item_sized_from_the_space_is_laid_out_again() {
    for width in [Dimension::stretch(), Dimension::fit_content(), Dimension::percent(0.1)] {
        kept_and_fresh_agree(|taffy| {
            let text = taffy.new_leaf_with_context(Style::default(), 90).unwrap();
            let style = Style {
                position: Position::Relative,
                flex_shrink: 0.0,
                size: Size { width, height: auto() },
                ..Default::default()
            };
            taffy.new_with_children(style, &[text]).unwrap()
        });
    }
}
