use crate::{
    AbsoluteLength, App, Bounds, DefiniteLength, Edges, Length, Pixels, Point, Size, Style, Window,
    point, size,
};
use collections::{FxHashMap, FxHashSet};
use smallvec::SmallVec;
use stacksafe::{StackSafe, stacksafe};
use std::{cell::RefCell, fmt::Debug, ops::Range, rc::Rc};
use taffy::{
    TaffyTree, TraversePartialTree as _,
    geometry::{Point as TaffyPoint, Rect as TaffyRect, Size as TaffySize},
    style::AvailableSpace as TaffyAvailableSpace,
    tree::NodeId,
};

type NodeMeasureFn = StackSafe<
    Box<
        dyn FnMut(
            Size<Option<Pixels>>,
            Size<AvailableSpace>,
            &mut Window,
            &mut App,
        ) -> Size<Pixels>,
    >,
>;

struct NodeContext {
    measure: NodeMeasureFn,
    // mirin: what the element that made the node keeps on it for the one
    // built for the same node later (`request_measured_layout`): a text's
    // shaped lines.
    kept: Option<Rc<dyn std::any::Any>>,
}

/// The measure function taffy calls for a measured leaf (text): device
/// pixels in and out, logical pixels for the element's own function.
fn measure_with<'a>(
    scale_factor: f32,
    window: &'a mut Window,
    cx: &'a mut App,
) -> impl FnMut(
    TaffySize<Option<f32>>,
    TaffySize<TaffyAvailableSpace>,
    NodeId,
    Option<&mut NodeContext>,
    &taffy::style::Style,
) -> TaffySize<f32>
+ 'a {
    move |known_dimensions, available_space, _id, node_context, _style| {
        let Some(node_context) = node_context else {
            return taffy::geometry::Size::default();
        };

        let known_dimensions = Size {
            width: known_dimensions.width.map(|e| Pixels(e / scale_factor)),
            height: known_dimensions.height.map(|e| Pixels(e / scale_factor)),
        };

        let available_space: Size<AvailableSpace> = available_space.into();
        let untransform = |ev: AvailableSpace| match ev {
            AvailableSpace::Definite(pixels) => {
                AvailableSpace::Definite(Pixels(pixels.0 / scale_factor))
            }
            AvailableSpace::MinContent => AvailableSpace::MinContent,
            AvailableSpace::MaxContent => AvailableSpace::MaxContent,
        };
        let available_space = size(
            untransform(available_space.width),
            untransform(available_space.height),
        );

        let a: Size<Pixels> = (node_context.measure)(known_dimensions, available_space, window, cx);
        size(a.width.0 * scale_factor, a.height.0 * scale_factor).into()
    }
}
pub struct TaffyLayoutEngine {
    taffy: TaffyTree<NodeContext>,
    // mirin: in device pixels (`layout_bounds_device`).
    absolute_layout_bounds: FxHashMap<LayoutId, Bounds<f32>>,
    computed_layouts: FxHashSet<LayoutId>,
    // mirin: the tree is kept across frames so a retained subtree
    // (`elements::retained`) keeps its nodes, and taffy's cache, from one frame
    // to the next. Nodes made outside any retained subtree live one frame.
    /// Nodes made this frame outside a retained subtree; removed at `clear`.
    loose: Vec<LayoutId>,
    /// The retained subtrees being built, innermost last: what each made.
    owners: Vec<Vec<LayoutId>>,
    /// Nodes of retained subtrees no longer drawn; removed at `clear`.
    released: Rc<RefCell<Vec<LayoutId>>>,
    /// mirin: the retained subtree being built again onto the nodes it kept
    /// (`begin_bind`).
    bind: Option<Bind>,
}

/// mirin: a retained subtree's elements built again for the layout it
/// kept: each node its elements ask for is the one it made last time, in
/// the same order, so nothing is laid out again.
struct Bind {
    nodes: Vec<LayoutId>,
    next: usize,
    /// What was asked for is not what it made: it is built apart instead.
    failed: bool,
    /// Measured leaves (text) given a new function, which is asked what the
    /// old one was for the layout it has.
    measured: Vec<LayoutId>,
}

const EXPECT_MESSAGE: &str = "we should avoid taffy layout errors by construction if possible";

impl TaffyLayoutEngine {
    pub fn new() -> Self {
        let mut taffy = TaffyTree::new();
        taffy.enable_rounding();
        TaffyLayoutEngine {
            taffy,
            absolute_layout_bounds: FxHashMap::default(),
            computed_layouts: FxHashSet::default(),
            loose: Vec::new(),
            owners: Vec::new(),
            released: Rc::default(),
            bind: None,
        }
    }

    pub fn clear(&mut self) {
        // mirin: keep retained subtrees; remove this frame's other nodes and
        // the subtrees no longer drawn. Parents were made after their
        // children, so removing newest first never edits a parent's child
        // list that is about to go too.
        if self.loose.len() == self.taffy.total_node_count() {
            // Nothing retained: drop the tree at once, as upstream does.
            self.taffy.clear();
            self.loose.clear();
        }
        for id in self.loose.drain(..).rev() {
            self.taffy.remove(id.into()).expect(EXPECT_MESSAGE);
        }
        let released = std::mem::take(&mut *self.released.borrow_mut());
        self.remove_nodes(released);
        self.absolute_layout_bounds.clear();
        self.computed_layouts.clear();
    }

    // mirin: track a new node: owned by the retained subtree being built, if
    // any, or this frame's.
    fn track(&mut self, id: LayoutId) -> LayoutId {
        match self.owners.last_mut() {
            Some(owned) => owned.push(id),
            None => self.loose.push(id),
        }
        id
    }

    /// mirin: start building a retained subtree: the nodes made until
    /// `end_owned` are its own (not this frame's).
    pub fn begin_owned(&mut self) {
        self.owners.push(Vec::new());
    }

    /// mirin: the nodes made since the matching `begin_owned`.
    pub fn end_owned(&mut self) -> Vec<LayoutId> {
        self.owners.pop().unwrap_or_default()
    }

    /// mirin: remove a retained subtree's nodes (made in this order) now.
    pub fn remove_nodes(&mut self, nodes: Vec<LayoutId>) {
        for id in nodes.into_iter().rev() {
            if self.taffy.contains(id.into()) {
                self.taffy.remove(id.into()).expect(EXPECT_MESSAGE);
            }
        }
    }

    /// mirin: where a retained subtree's state puts its nodes when it is
    /// dropped (no longer drawn); they are removed at the next `clear`.
    pub fn released(&self) -> Rc<RefCell<Vec<LayoutId>>> {
        self.released.clone()
    }

    /// mirin: whether a kept node is still in the tree.
    pub fn contains(&self, id: LayoutId) -> bool {
        self.taffy.contains(id.into())
    }

    /// mirin: how many layouts were computed; with `inner_changed_since`,
    /// what a retained subtree checks before reusing what it drew.
    pub fn epoch(&self) -> u32 {
        self.taffy.layout_epoch()
    }

    /// mirin: whether a layout after `epoch` changed anything inside `id`
    /// (taffy's `inner_changed_since`): its size, or where or how large
    /// anything below it is. Where `id` itself sits does not count.
    pub fn inner_changed_since(&self, id: LayoutId, epoch: u32) -> bool {
        self.taffy.inner_changed_since(id.into(), epoch)
    }

    /// mirin: whether a layout after `epoch` changed the box or place of a
    /// node below `id` (taffy's `below_changed_since`): unlike
    /// `inner_changed_since`, `id`'s own box does not count.
    pub fn below_changed_since(&self, id: LayoutId, epoch: u32) -> bool {
        self.taffy.below_changed_since(id.into(), epoch)
    }

    /// mirin: whether a layout after `epoch` measured one of `nodes` again
    /// (taffy's `asked_since`: texts of a retained subtree, since the layout
    /// they were made in). What a text holds then depends on which of its
    /// answers taffy's cache still had, not on what a layout from nothing
    /// asks last: the subtree is not built again onto these nodes but laid
    /// out anew.
    pub fn any_asked_since(&self, nodes: &[LayoutId], epoch: u32) -> bool {
        nodes
            .iter()
            .any(|id| self.taffy.asked_since((*id).into(), epoch))
    }

    /// mirin: build a retained subtree's elements again onto `nodes`, the
    /// ones it made (in that order) and kept: until `end_bind`, each layout
    /// requested is answered with the next of them instead of a new node.
    pub fn begin_bind(&mut self, nodes: Vec<LayoutId>) {
        self.bind = Some(Bind {
            nodes,
            next: 0,
            failed: false,
            measured: Vec::new(),
        });
    }

    /// mirin: give up on the subtree being bound, if one is (it asked for
    /// something its kept layout can't answer); returns whether one was.
    pub fn fail_bind(&mut self) -> bool {
        match &mut self.bind {
            Some(bind) => {
                bind.failed = true;
                true
            }
            None => false,
        }
    }

    /// mirin: the kept nodes of the subtree bound since `begin_bind`, when
    /// its elements asked for exactly them. Each measured leaf's new
    /// function is asked what the old one was last asked, so its element
    /// holds what the old one did (a subtree is bound only while that is
    /// what a layout from nothing leaves it with, `any_asked_since`).
    pub fn end_bind(&mut self, window: &mut Window, cx: &mut App) -> Option<Vec<LayoutId>> {
        let bind = self.bind.take()?;
        if bind.failed || bind.next != bind.nodes.len() {
            return None;
        }
        let scale_factor = window.scale_factor();
        let mut measure = measure_with(scale_factor, window, cx);
        for id in bind.measured {
            let (known_dimensions, available_space) = self.taffy.last_measure_inputs(id.into())?;
            let context = self.taffy.get_node_context_mut(id.into());
            measure(
                known_dimensions,
                available_space,
                id.into(),
                context,
                &taffy::style::Style::DEFAULT,
            );
        }
        Some(bind.nodes)
    }

    /// mirin: the kept node that answers a layout request while a subtree is
    /// bound (`begin_bind`): the next it made, if it has these `children`
    /// (`None`: a measured leaf).
    fn bound(&mut self, children: Option<&[LayoutId]>) -> Option<LayoutId> {
        let bind = self.bind.as_mut().filter(|bind| !bind.failed)?;
        let id = bind.nodes.get(bind.next).copied();
        let matches = id.is_some_and(|id| {
            self.taffy.contains(id.into())
                && match children {
                    Some(children) => self
                        .taffy
                        .child_ids(id.into())
                        .eq(children.iter().map(|child| child.0)),
                    None => {
                        self.taffy.child_count(id.into()) == 0
                            && self.taffy.get_node_context(id.into()).is_some()
                    }
                }
        });
        if !matches {
            bind.failed = true;
            return None;
        }
        bind.next += 1;
        id
    }

    pub fn request_layout(
        &mut self,
        style: Style,
        rem_size: Pixels,
        scale_factor: f32,
        children: &[LayoutId],
    ) -> LayoutId {
        // mirin: a retained subtree built onto its kept layout.
        if let Some(id) = self.bound(Some(children)) {
            return id;
        }
        let taffy_style = style.to_taffy(rem_size, scale_factor);

        let id = if children.is_empty() {
            self.taffy
                .new_leaf(taffy_style)
                .expect(EXPECT_MESSAGE)
                .into()
        } else {
            self.taffy
                // This is safe because LayoutId is repr(transparent) to taffy::tree::NodeId.
                .new_with_children(taffy_style, LayoutId::to_taffy_slice(children))
                .expect(EXPECT_MESSAGE)
                .into()
        };
        self.track(id)
    }

    // mirin: `kept` stays on the node; when the node is one a retained
    // subtree kept and its elements are built again for (`begin_bind`), what
    // the element before this one left there comes back.
    pub fn request_measured_layout(
        &mut self,
        style: Style,
        rem_size: Pixels,
        scale_factor: f32,
        kept: Option<Rc<dyn std::any::Any>>,
        measure: impl FnMut(
            Size<Option<Pixels>>,
            Size<AvailableSpace>,
            &mut Window,
            &mut App,
        ) -> Size<Pixels>
        + 'static,
    ) -> (LayoutId, Option<Rc<dyn std::any::Any>>) {
        // mirin: a retained subtree built onto its kept layout: the node
        // takes the new element's function (asked at `end_bind`).
        if let Some(id) = self.bound(None) {
            let mut before = None;
            if let Some(context) = self.taffy.get_node_context_mut(id.into()) {
                context.measure = StackSafe::new(Box::new(measure));
                before = std::mem::replace(&mut context.kept, kept);
            }
            if let Some(bind) = &mut self.bind {
                bind.measured.push(id);
            }
            return (id, before);
        }
        let taffy_style = style.to_taffy(rem_size, scale_factor);

        let id = self
            .taffy
            .new_leaf_with_context(
                taffy_style,
                NodeContext {
                    measure: StackSafe::new(Box::new(measure)),
                    kept,
                },
            )
            .expect(EXPECT_MESSAGE)
            .into();
        (self.track(id), None)
    }

    /// mirin: how far under its top a measured node's first baseline is (a
    /// text's first line). A row that aligns its items by baseline
    /// (`items_baseline`) lines them up by it; without one taffy takes the
    /// node's bottom edge, which is not where a text's letters sit.
    pub fn set_first_baseline(&mut self, id: LayoutId, baseline: Pixels, scale_factor: f32) {
        self.taffy
            .set_first_baseline(id.into(), Some(baseline.0 * scale_factor))
            .expect(EXPECT_MESSAGE);
    }

    // Used to understand performance
    #[allow(dead_code)]
    fn count_all_children(&self, parent: LayoutId) -> anyhow::Result<u32> {
        let mut count = 0;

        for child in self.taffy.children(parent.0)? {
            // Count this child.
            count += 1;

            // Count all of this child's children.
            count += self.count_all_children(LayoutId(child))?
        }

        Ok(count)
    }

    // Used to understand performance
    #[allow(dead_code)]
    fn max_depth(&self, depth: u32, parent: LayoutId) -> anyhow::Result<u32> {
        println!(
            "{parent:?} at depth {depth} has {} children",
            self.taffy.child_count(parent.0)
        );

        let mut max_child_depth = 0;

        for child in self.taffy.children(parent.0)? {
            max_child_depth = std::cmp::max(max_child_depth, self.max_depth(0, LayoutId(child))?);
        }

        Ok(depth + 1 + max_child_depth)
    }

    // Used to understand performance
    #[allow(dead_code)]
    fn get_edges(&self, parent: LayoutId) -> anyhow::Result<Vec<(LayoutId, LayoutId)>> {
        let mut edges = Vec::new();

        for child in self.taffy.children(parent.0)? {
            edges.push((parent, LayoutId(child)));

            edges.extend(self.get_edges(LayoutId(child))?);
        }

        Ok(edges)
    }

    #[stacksafe]
    pub fn compute_layout(
        &mut self,
        id: LayoutId,
        available_space: Size<AvailableSpace>,
        window: &mut Window,
        cx: &mut App,
    ) {
        // Leaving this here until we have a better instrumentation approach.
        // println!("Laying out {} children", self.count_all_children(id)?);
        // println!("Max layout depth: {}", self.max_depth(0, id)?);

        // Output the edges (branches) of the tree in Mermaid format for visualization.
        // println!("Edges:");
        // for (a, b) in self.get_edges(id)? {
        //     println!("N{} --> N{}", u64::from(a), u64::from(b));
        // }
        //

        if !self.computed_layouts.insert(id) {
            let mut stack = SmallVec::<[LayoutId; 64]>::new();
            stack.push(id);
            while let Some(id) = stack.pop() {
                self.absolute_layout_bounds.remove(&id);
                stack.extend(
                    self.taffy
                        .children(id.into())
                        .expect(EXPECT_MESSAGE)
                        .into_iter()
                        .map(Into::into),
                );
            }
        }

        let scale_factor = window.scale_factor();

        let transform = |v: AvailableSpace| match v {
            AvailableSpace::Definite(pixels) => {
                AvailableSpace::Definite(Pixels(pixels.0 * scale_factor))
            }
            AvailableSpace::MinContent => AvailableSpace::MinContent,
            AvailableSpace::MaxContent => AvailableSpace::MaxContent,
        };
        let available_space = size(
            transform(available_space.width),
            transform(available_space.height),
        );

        self.taffy
            .compute_layout_with_measure(
                id.into(),
                available_space.into(),
                measure_with(scale_factor, window, cx),
            )
            .expect(EXPECT_MESSAGE);
    }

    /// mirin: lay `id` out as `twin` is laid out where it sits (taffy's
    /// `compute_detached_layout_with_measure`): a retained subtree built again
    /// from the same content, detached, to be drawn where its kept layout is.
    #[stacksafe]
    pub fn compute_detached_layout(
        &mut self,
        id: LayoutId,
        twin: LayoutId,
        window: &mut Window,
        cx: &mut App,
    ) {
        let scale_factor = window.scale_factor();
        self.taffy
            .compute_detached_layout_with_measure(
                id.into(),
                twin.into(),
                measure_with(scale_factor, window, cx),
            )
            .expect(EXPECT_MESSAGE);
    }

    /// mirin: how far a node's content reaches from its top left, its end
    /// border included: its scrollable overflow (children's margin boxes and
    /// what overflows them visibly, then its end padding), as taffy measured
    /// it. A scroll view scrolls by this less its size.
    pub fn layout_scroll_extent(&self, id: LayoutId, scale_factor: f32) -> Size<Pixels> {
        let layout = self.taffy.layout(id.into()).expect(EXPECT_MESSAGE);
        size(
            Pixels((layout.content_size.width + layout.border.right) / scale_factor),
            Pixels((layout.content_size.height + layout.border.bottom) / scale_factor),
        )
    }

    /// mirin: a node's bounds in device pixels from the root of its
    /// layout, as taffy has them (whole ones). Upstream's `layout_bounds`
    /// divided each node's position by the scale factor and added those up;
    /// at a scale factor that is not a power of two each division loses a
    /// little, so where a node landed depended on how deep it is.
    /// `Window::layout_bounds` divides once, with the element offset
    /// (`elements::retained::Grid::place`).
    pub(crate) fn layout_bounds_device(&mut self, id: LayoutId) -> Bounds<f32> {
        if let Some(layout) = self.absolute_layout_bounds.get(&id).cloned() {
            return layout;
        }

        let layout = self.taffy.layout(id.into()).expect(EXPECT_MESSAGE);
        let mut bounds = Bounds {
            origin: point(layout.location.x, layout.location.y),
            size: size(layout.size.width, layout.size.height),
        };

        if let Some(parent_id) = self.taffy.parent(id.0) {
            let parent_bounds = self.layout_bounds_device(parent_id.into());
            bounds.origin.x += parent_bounds.origin.x;
            bounds.origin.y += parent_bounds.origin.y;
        }
        self.absolute_layout_bounds.insert(id, bounds);

        bounds
    }
}

/// A unique identifier for a layout node, generated when requesting a layout from Taffy
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
#[repr(transparent)]
pub struct LayoutId(NodeId);

impl LayoutId {
    fn to_taffy_slice(node_ids: &[Self]) -> &[taffy::NodeId] {
        // SAFETY: LayoutId is repr(transparent) to taffy::tree::NodeId.
        unsafe { std::mem::transmute::<&[LayoutId], &[taffy::NodeId]>(node_ids) }
    }
}

impl std::hash::Hash for LayoutId {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        u64::from(self.0).hash(state);
    }
}

impl From<NodeId> for LayoutId {
    fn from(node_id: NodeId) -> Self {
        Self(node_id)
    }
}

impl From<LayoutId> for NodeId {
    fn from(layout_id: LayoutId) -> NodeId {
        layout_id.0
    }
}

trait ToTaffy<Output> {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> Output;
}

impl ToTaffy<taffy::style::Style> for Style {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> taffy::style::Style {
        use taffy::style_helpers::{fr, length, minmax, repeat};

        fn to_grid_line(
            placement: &Range<crate::GridPlacement>,
        ) -> taffy::Line<taffy::GridPlacement> {
            taffy::Line {
                start: placement.start.into(),
                end: placement.end.into(),
            }
        }

        fn to_grid_repeat<T: taffy::style::CheapCloneStr>(
            unit: &Option<u16>,
        ) -> Vec<taffy::GridTemplateComponent<T>> {
            // grid-template-columns: repeat(<number>, minmax(0, 1fr));
            // mirin: typed literals (float fallback is being phased out of rustc).
            unit.map(|count| vec![repeat(count, vec![minmax(length(0.0_f32), fr(1.0_f32))])])
                .unwrap_or_default()
        }

        taffy::style::Style {
            display: self.display.into(),
            overflow: self.overflow.into(),
            scrollbar_width: self.scrollbar_width.to_taffy(rem_size, scale_factor),
            position: self.position.into(),
            inset: self.inset.to_taffy(rem_size, scale_factor),
            size: self.size.to_taffy(rem_size, scale_factor),
            min_size: self.min_size.to_taffy(rem_size, scale_factor),
            max_size: self.max_size.to_taffy(rem_size, scale_factor),
            aspect_ratio: self.aspect_ratio,
            margin: self.margin.to_taffy(rem_size, scale_factor),
            padding: self.padding.to_taffy(rem_size, scale_factor),
            border: self.border_widths.to_taffy(rem_size, scale_factor),
            align_items: self.align_items.map(|x| x.into()),
            align_self: self.align_self.map(|x| x.into()),
            align_content: self.align_content.map(|x| x.into()),
            justify_content: self.justify_content.map(|x| x.into()),
            gap: self.gap.to_taffy(rem_size, scale_factor),
            flex_direction: self.flex_direction.into(),
            flex_wrap: self.flex_wrap.into(),
            flex_basis: self.flex_basis.to_taffy(rem_size, scale_factor),
            flex_grow: self.flex_grow,
            flex_shrink: self.flex_shrink,
            // mirin: explicit track lists win over `repeat(N, minmax(0, 1fr))`.
            grid_template_rows: self
                .grid_template_rows
                .as_deref()
                .map(|tracks| to_grid_tracks(tracks, scale_factor))
                .unwrap_or_else(|| to_grid_repeat(&self.grid_rows)),
            grid_template_columns: self
                .grid_template_columns
                .as_deref()
                .map(|tracks| to_grid_tracks(tracks, scale_factor))
                .unwrap_or_else(|| to_grid_repeat(&self.grid_cols)),
            justify_items: self.justify_items.map(|x| x.into()),
            justify_self: self.justify_self.map(|x| x.into()),
            grid_row: self
                .grid_location
                .as_ref()
                .map(|location| to_grid_line(&location.row))
                .unwrap_or_default(),
            grid_column: self
                .grid_location
                .as_ref()
                .map(|location| to_grid_line(&location.column))
                .unwrap_or_default(),
            ..Default::default()
        }
    }
}

// mirin: explicit grid tracks.
fn to_grid_tracks<T: taffy::style::CheapCloneStr>(
    tracks: &[crate::GridTrack],
    scale_factor: f32,
) -> Vec<taffy::GridTemplateComponent<T>> {
    use crate::TrackBreadth;
    use taffy::style::{MaxTrackSizingFunction as Max, MinTrackSizingFunction as Min};
    tracks
        .iter()
        .map(|track| {
            let min = match track.min {
                TrackBreadth::Pixels(px) => Min::length(px * scale_factor),
                TrackBreadth::Percent(fraction) => Min::percent(fraction),
                TrackBreadth::MinContent => Min::min_content(),
                TrackBreadth::MaxContent => Min::max_content(),
                TrackBreadth::Auto | TrackBreadth::Fr(_) => Min::auto(),
            };
            let max = match track.max {
                TrackBreadth::Pixels(px) => Max::length(px * scale_factor),
                TrackBreadth::Percent(fraction) => Max::percent(fraction),
                TrackBreadth::Fr(fr) => Max::fr(fr),
                TrackBreadth::MinContent => Max::min_content(),
                TrackBreadth::MaxContent => Max::max_content(),
                TrackBreadth::Auto => Max::auto(),
            };
            taffy::GridTemplateComponent::Single(taffy::geometry::MinMax { min, max })
        })
        .collect()
}

impl ToTaffy<f32> for AbsoluteLength {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> f32 {
        match self {
            AbsoluteLength::Pixels(pixels) => {
                let pixels: f32 = pixels.into();
                pixels * scale_factor
            }
            AbsoluteLength::Rems(rems) => {
                let pixels: f32 = (*rems * rem_size).into();
                pixels * scale_factor
            }
        }
    }
}

impl ToTaffy<taffy::style::LengthPercentageAuto> for Length {
    fn to_taffy(
        &self,
        rem_size: Pixels,
        scale_factor: f32,
    ) -> taffy::prelude::LengthPercentageAuto {
        match self {
            Length::Definite(length) => length.to_taffy(rem_size, scale_factor),
            Length::Auto => taffy::prelude::LengthPercentageAuto::auto(),
        }
    }
}

impl ToTaffy<taffy::style::Dimension> for Length {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> taffy::prelude::Dimension {
        match self {
            Length::Definite(length) => length.to_taffy(rem_size, scale_factor),
            Length::Auto => taffy::prelude::Dimension::auto(),
        }
    }
}

impl ToTaffy<taffy::style::LengthPercentage> for DefiniteLength {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> taffy::style::LengthPercentage {
        match self {
            DefiniteLength::Absolute(length) => match length {
                AbsoluteLength::Pixels(pixels) => {
                    let pixels: f32 = pixels.into();
                    taffy::style::LengthPercentage::length(pixels * scale_factor)
                }
                AbsoluteLength::Rems(rems) => {
                    let pixels: f32 = (*rems * rem_size).into();
                    taffy::style::LengthPercentage::length(pixels * scale_factor)
                }
            },
            DefiniteLength::Fraction(fraction) => {
                taffy::style::LengthPercentage::percent(*fraction)
            }
        }
    }
}

impl ToTaffy<taffy::style::LengthPercentageAuto> for DefiniteLength {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> taffy::style::LengthPercentageAuto {
        match self {
            DefiniteLength::Absolute(length) => match length {
                AbsoluteLength::Pixels(pixels) => {
                    let pixels: f32 = pixels.into();
                    taffy::style::LengthPercentageAuto::length(pixels * scale_factor)
                }
                AbsoluteLength::Rems(rems) => {
                    let pixels: f32 = (*rems * rem_size).into();
                    taffy::style::LengthPercentageAuto::length(pixels * scale_factor)
                }
            },
            DefiniteLength::Fraction(fraction) => {
                taffy::style::LengthPercentageAuto::percent(*fraction)
            }
        }
    }
}

impl ToTaffy<taffy::style::Dimension> for DefiniteLength {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> taffy::style::Dimension {
        match self {
            DefiniteLength::Absolute(length) => match length {
                AbsoluteLength::Pixels(pixels) => {
                    let pixels: f32 = pixels.into();
                    taffy::style::Dimension::length(pixels * scale_factor)
                }
                AbsoluteLength::Rems(rems) => {
                    taffy::style::Dimension::length((*rems * rem_size * scale_factor).into())
                }
            },
            DefiniteLength::Fraction(fraction) => taffy::style::Dimension::percent(*fraction),
        }
    }
}

impl ToTaffy<taffy::style::LengthPercentage> for AbsoluteLength {
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> taffy::style::LengthPercentage {
        match self {
            AbsoluteLength::Pixels(pixels) => {
                let pixels: f32 = pixels.into();
                taffy::style::LengthPercentage::length(pixels * scale_factor)
            }
            AbsoluteLength::Rems(rems) => {
                let pixels: f32 = (*rems * rem_size).into();
                taffy::style::LengthPercentage::length(pixels * scale_factor)
            }
        }
    }
}

impl<T, T2> From<TaffyPoint<T>> for Point<T2>
where
    T: Into<T2>,
    T2: Clone + Debug + Default + PartialEq,
{
    fn from(point: TaffyPoint<T>) -> Point<T2> {
        Point {
            x: point.x.into(),
            y: point.y.into(),
        }
    }
}

impl<T, T2> From<Point<T>> for TaffyPoint<T2>
where
    T: Into<T2> + Clone + Debug + Default + PartialEq,
{
    fn from(val: Point<T>) -> Self {
        TaffyPoint {
            x: val.x.into(),
            y: val.y.into(),
        }
    }
}

impl<T, U> ToTaffy<TaffySize<U>> for Size<T>
where
    T: ToTaffy<U> + Clone + Debug + Default + PartialEq,
{
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> TaffySize<U> {
        TaffySize {
            width: self.width.to_taffy(rem_size, scale_factor),
            height: self.height.to_taffy(rem_size, scale_factor),
        }
    }
}

impl<T, U> ToTaffy<TaffyRect<U>> for Edges<T>
where
    T: ToTaffy<U> + Clone + Debug + Default + PartialEq,
{
    fn to_taffy(&self, rem_size: Pixels, scale_factor: f32) -> TaffyRect<U> {
        TaffyRect {
            top: self.top.to_taffy(rem_size, scale_factor),
            right: self.right.to_taffy(rem_size, scale_factor),
            bottom: self.bottom.to_taffy(rem_size, scale_factor),
            left: self.left.to_taffy(rem_size, scale_factor),
        }
    }
}

impl<T, U> From<TaffySize<T>> for Size<U>
where
    T: Into<U>,
    U: Clone + Debug + Default + PartialEq,
{
    fn from(taffy_size: TaffySize<T>) -> Self {
        Size {
            width: taffy_size.width.into(),
            height: taffy_size.height.into(),
        }
    }
}

impl<T, U> From<Size<T>> for TaffySize<U>
where
    T: Into<U> + Clone + Debug + Default + PartialEq,
{
    fn from(size: Size<T>) -> Self {
        TaffySize {
            width: size.width.into(),
            height: size.height.into(),
        }
    }
}

/// The space available for an element to be laid out in
#[derive(Copy, Clone, Default, Debug, Eq, PartialEq)]
pub enum AvailableSpace {
    /// The amount of space available is the specified number of pixels
    Definite(Pixels),
    /// The amount of space available is indefinite and the node should be laid out under a min-content constraint
    #[default]
    MinContent,
    /// The amount of space available is indefinite and the node should be laid out under a max-content constraint
    MaxContent,
}

impl AvailableSpace {
    /// Returns a `Size` with both width and height set to `AvailableSpace::MinContent`.
    ///
    /// This function is useful when you want to create a `Size` with the minimum content constraints
    /// for both dimensions.
    ///
    /// # Examples
    ///
    /// ```
    /// use gpui::AvailableSpace;
    /// let min_content_size = AvailableSpace::min_size();
    /// assert_eq!(min_content_size.width, AvailableSpace::MinContent);
    /// assert_eq!(min_content_size.height, AvailableSpace::MinContent);
    /// ```
    pub const fn min_size() -> Size<Self> {
        Size {
            width: Self::MinContent,
            height: Self::MinContent,
        }
    }
}

impl From<AvailableSpace> for TaffyAvailableSpace {
    fn from(space: AvailableSpace) -> TaffyAvailableSpace {
        match space {
            AvailableSpace::Definite(Pixels(value)) => TaffyAvailableSpace::Definite(value),
            AvailableSpace::MinContent => TaffyAvailableSpace::MinContent,
            AvailableSpace::MaxContent => TaffyAvailableSpace::MaxContent,
        }
    }
}

impl From<TaffyAvailableSpace> for AvailableSpace {
    fn from(space: TaffyAvailableSpace) -> AvailableSpace {
        match space {
            TaffyAvailableSpace::Definite(value) => AvailableSpace::Definite(Pixels(value)),
            TaffyAvailableSpace::MinContent => AvailableSpace::MinContent,
            TaffyAvailableSpace::MaxContent => AvailableSpace::MaxContent,
        }
    }
}

impl From<Pixels> for AvailableSpace {
    fn from(pixels: Pixels) -> Self {
        AvailableSpace::Definite(pixels)
    }
}

impl From<Size<Pixels>> for Size<AvailableSpace> {
    fn from(size: Size<Pixels>) -> Self {
        Size {
            width: AvailableSpace::Definite(size.width),
            height: AvailableSpace::Definite(size.height),
        }
    }
}
