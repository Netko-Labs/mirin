//! Contains [TaffyTree](crate::tree::TaffyTree): the default implementation of [LayoutTree](crate::tree::LayoutTree), and the error type for Taffy.
#[cfg(not(feature = "std"))]
use slotmap::SecondaryMap;
#[cfg(feature = "std")]
use slotmap::SparseSecondaryMap as SecondaryMap;
use slotmap::{DefaultKey, SlotMap};

use crate::geometry::Size;
use crate::style::{AvailableSpace, Display, Style};
use crate::sys::DefaultCheapStr;
use crate::tree::{
    Cache, ClearState, Layout, LayoutInput, LayoutOutput, LayoutPartialTree, LayoutPartialTreeExt, NodeId, PrintTree,
    RoundTree, RunMode,
    TraversePartialTree, TraverseTree,
};
use crate::util::debug::{debug_log, debug_log_node};
use crate::util::sys::{new_vec_with_capacity, ChildrenVec, Vec};

use crate::compute::{
    compute_cached_layout, compute_hidden_layout, compute_leaf_layout, compute_root_layout,
};
use crate::CacheTree;
#[cfg(feature = "block_layout")]
use crate::{compute::compute_block_layout, LayoutBlockContainer};
#[cfg(feature = "flexbox")]
use crate::{compute::compute_flexbox_layout, LayoutFlexboxContainer};
#[cfg(feature = "grid")]
use crate::{compute::compute_grid_layout, LayoutGridContainer};

#[cfg(all(feature = "detailed_layout_info", feature = "grid"))]
use crate::compute::grid::DetailedGridInfo;
#[cfg(feature = "detailed_layout_info")]
use crate::tree::layout::DetailedLayoutInfo;

/// The error Taffy generates on invalid operations
pub type TaffyResult<T> = Result<T, TaffyError>;

/// An error that occurs while trying to access or modify a node's children by index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaffyError {
    /// The parent node does not have a child at `child_index`. It only has `child_count` children
    ChildIndexOutOfBounds {
        /// The parent node whose child was being looked up
        parent: NodeId,
        /// The index that was looked up
        child_index: usize,
        /// The total number of children the parent has
        child_count: usize,
    },
    /// The parent node was not found in the [`TaffyTree`](crate::TaffyTree) instance.
    InvalidParentNode(NodeId),
    /// The child node was not found in the [`TaffyTree`](crate::TaffyTree) instance.
    InvalidChildNode(NodeId),
    /// The supplied node was not found in the [`TaffyTree`](crate::TaffyTree) instance.
    InvalidInputNode(NodeId),
}

impl core::fmt::Display for TaffyError {
    fn fmt(&self, f: &mut core::fmt::Formatter) -> core::fmt::Result {
        match self {
            TaffyError::ChildIndexOutOfBounds { parent, child_index, child_count } => {
                write!(f, "Index (is {child_index}) should be < child_count ({child_count}) for parent node {parent:?}")
            }
            TaffyError::InvalidParentNode(parent) => {
                write!(f, "Parent Node {parent:?} is not in the TaffyTree instance")
            }
            TaffyError::InvalidChildNode(child) => write!(f, "Child Node {child:?} is not in the TaffyTree instance"),
            TaffyError::InvalidInputNode(node) => write!(f, "Supplied Node {node:?} is not in the TaffyTree instance"),
        }
    }
}

#[cfg(feature = "std")]
impl std::error::Error for TaffyError {}

/// Global configuration values for a TaffyTree instance
#[derive(Debug, Clone, Copy)]
pub(crate) struct TaffyConfig {
    /// Whether to round layout values
    pub(crate) use_rounding: bool,
}

impl Default for TaffyConfig {
    fn default() -> Self {
        Self { use_rounding: true }
    }
}

/// Layout information for a given [`Node`](crate::node::Node)
///
/// Stored in a [`TaffyTree`].
#[derive(Debug, Clone, PartialEq)]
struct NodeData {
    /// The layout strategy used by this node
    pub(crate) style: Style,

    /// The always unrounded results of the layout computation. We must store this separately from the rounded
    /// layout to avoid errors from rounding already-rounded values. See <https://github.com/DioxusLabs/taffy/issues/501>.
    pub(crate) unrounded_layout: Layout,

    /// The final results of the layout computation.
    /// These may be rounded or unrounded depending on what the `use_rounding` config setting is set to.
    pub(crate) final_layout: Layout,

    /// Whether the node has context data associated with it or not
    pub(crate) has_context: bool,

    /// The cached results of the layout computation
    pub(crate) cache: Cache,

    /// The computation result from layout algorithm
    #[cfg(feature = "detailed_layout_info")]
    pub(crate) detailed_layout_info: DetailedLayoutInfo,

    // mirin: incremental rounding (`TaffyTree::round_changed`). A tree kept
    // across layouts rounds again only what a layout touched.
    /// Its unrounded layout was written since it was last rounded.
    pub(crate) written: bool,
    /// Its layout algorithm ran (a cache miss) since it was last rounded, so
    /// its children's unrounded layouts may have been written too.
    pub(crate) ran: bool,
    /// Its parent's cumulative unrounded position when it was last rounded.
    pub(crate) rounded_at: Option<(f32, f32)>,
    // mirin: the layout (`TaffyTree::layout_epoch`) that last changed
    // something inside it (`TaffyTree::inner_changed_since`).
    pub(crate) inner_changed_at: u32,
    // mirin: the layout that last changed the box or place of a node below
    // it (`TaffyTree::below_changed_since`).
    pub(crate) below_changed_at: u32,
    /// A measured leaf: the layout that last asked its function again, not
    /// counting the layout it was made in (`TaffyTree::asked_since`).
    pub(crate) asked_at: u32,
    /// One of its edges, or of a node below it, sat close to half a pixel
    /// when it was last rounded (`TaffyTree::round_changed`).
    pub(crate) near_half: bool,
}

impl NodeData {
    /// Create the data for a new node
    #[must_use]
    pub const fn new(style: Style) -> Self {
        Self {
            style,
            cache: Cache::new(),
            unrounded_layout: Layout::new(),
            final_layout: Layout::new(),
            has_context: false,
            written: true,
            ran: true,
            rounded_at: None,
            inner_changed_at: 0,
            below_changed_at: 0,
            asked_at: 0,
            near_half: true,
            #[cfg(feature = "detailed_layout_info")]
            detailed_layout_info: DetailedLayoutInfo::None,
        }
    }

    /// Marks a node and all of its ancestors as requiring relayout
    ///
    /// This clears any cached data and signals that the data must be recomputed.
    /// If the node was already marked as dirty, returns true
    #[inline]
    pub fn mark_dirty(&mut self) -> ClearState {
        self.cache.clear()
    }
}

/// An entire tree of UI nodes. The entry point to Taffy's high-level API.
///
/// Allows you to build a tree of UI nodes, run Taffy's layout algorithms over that tree, and then access the resultant layout.]
#[derive(Debug, Clone)]
pub struct TaffyTree<NodeContext = ()> {
    /// The [`NodeData`] for each node stored in this tree
    nodes: SlotMap<DefaultKey, NodeData>,

    /// Functions/closures that compute the intrinsic size of leaf nodes
    node_context_data: SecondaryMap<DefaultKey, NodeContext>,

    /// The children of each node
    ///
    /// The indexes in the outer vector correspond to the position of the parent [`NodeData`]
    children: SlotMap<DefaultKey, ChildrenVec<NodeId>>,

    /// The parents of each node
    ///
    /// The indexes in the outer vector correspond to the position of the child [`NodeData`]
    parents: SlotMap<DefaultKey, Option<NodeId>>,

    /// Layout mode configuration
    config: TaffyConfig,

    // mirin: how many layouts were computed (`layout_epoch`).
    epoch: u32,
    // mirin: what a measured leaf's function was last asked
    // (`last_measure_inputs`).
    last_measures: SecondaryMap<DefaultKey, (Size<Option<f32>>, Size<AvailableSpace>)>,
}

impl Default for TaffyTree {
    fn default() -> TaffyTree<()> {
        TaffyTree::new()
    }
}

// mirin: for `TaffyTree::round_changed`.

/// How close to half a pixel an edge may sit and still round the same way
/// wherever its subtree is moved by whole pixels: the sums that place a node
/// (one per level of the tree) each lose up to half an `f32` step, which
/// below `FAR` pixels and a few dozen levels stays well under this.
const HALF_PIXEL_MARGIN: f32 = 1.0 / 16.0;

/// Past this many pixels from the origin an `f32` is too coarse for
/// `HALF_PIXEL_MARGIN` to hold: nodes there are always rounded again.
const FAR: f32 = 16384.0;

/// Whether a parent that sat at `before` and now sits at `after` (one axis)
/// moved by a whole number of pixels, exactly.
fn whole_pixels(before: f32, after: f32) -> bool {
    let moved = after - before;
    moved == crate::util::sys::round(moved)
        && before + moved == after
        && crate::util::sys::abs(before) < FAR
        && crate::util::sys::abs(after) < FAR
}

/// Whether any edge `round_node` rounds for a node with this unrounded
/// layout at cumulative position (`x`, `y`) sits within `HALF_PIXEL_MARGIN`
/// of half a pixel (or too far out to tell).
fn near_half_pixel(layout: &Layout, x: f32, y: f32) -> bool {
    let near = |value: f32| {
        let fraction = value - crate::util::sys::floor(value);
        !(crate::util::sys::abs(value) < FAR) || crate::util::sys::abs(fraction - 0.5) < HALF_PIXEL_MARGIN
    };
    let (width, height) = (layout.size.width, layout.size.height);
    near(x)
        || near(y)
        || near(x + width)
        || near(y + height)
        || near(x + layout.border.left)
        || near(x + width - layout.border.right)
        || near(y + layout.border.top)
        || near(y + height - layout.border.bottom)
        || near(x + layout.padding.left)
        || near(x + width - layout.padding.right)
        || near(y + layout.padding.top)
        || near(y + height - layout.padding.bottom)
        || content_near_half_pixel(layout, x, y, near)
}

/// `near_half_pixel` for the content size, where it is kept.
#[cfg(feature = "content_size")]
fn content_near_half_pixel(layout: &Layout, x: f32, y: f32, near: impl Fn(f32) -> bool) -> bool {
    near(x + layout.content_size.width) || near(y + layout.content_size.height)
}

#[cfg(not(feature = "content_size"))]
fn content_near_half_pixel(_: &Layout, _: f32, _: f32, _: impl Fn(f32) -> bool) -> bool {
    false
}

/// Iterator that wraps a slice of nodes, lazily converting them to u64
pub struct TaffyTreeChildIter<'a>(core::slice::Iter<'a, NodeId>);
impl Iterator for TaffyTreeChildIter<'_> {
    type Item = NodeId;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        self.0.next().copied()
    }
}

// TraversePartialTree impl for TaffyTree
impl<NodeContext> TraversePartialTree for TaffyTree<NodeContext> {
    type ChildIter<'a>
        = TaffyTreeChildIter<'a>
    where
        Self: 'a;

    #[inline(always)]
    fn child_ids(&self, parent_node_id: NodeId) -> Self::ChildIter<'_> {
        TaffyTreeChildIter(self.children[parent_node_id.into()].iter())
    }

    #[inline(always)]
    fn child_count(&self, parent_node_id: NodeId) -> usize {
        self.children[parent_node_id.into()].len()
    }

    #[inline(always)]
    fn get_child_id(&self, parent_node_id: NodeId, id: usize) -> NodeId {
        self.children[parent_node_id.into()][id]
    }
}

// TraverseTree impl for TaffyTree
impl<NodeContext> TraverseTree for TaffyTree<NodeContext> {}

// CacheTree impl for TaffyTree
impl<NodeContext> CacheTree for TaffyTree<NodeContext> {
    fn cache_get(
        &self,
        node_id: NodeId,
        known_dimensions: Size<Option<f32>>,
        available_space: Size<AvailableSpace>,
        run_mode: RunMode,
    ) -> Option<LayoutOutput> {
        self.nodes[node_id.into()].cache.get(known_dimensions, available_space, run_mode)
    }

    fn cache_store(
        &mut self,
        node_id: NodeId,
        known_dimensions: Size<Option<f32>>,
        available_space: Size<AvailableSpace>,
        run_mode: RunMode,
        layout_output: LayoutOutput,
    ) {
        self.nodes[node_id.into()].cache.store(known_dimensions, available_space, run_mode, layout_output)
    }

    fn cache_clear(&mut self, node_id: NodeId) {
        self.nodes[node_id.into()].cache.clear();
    }
}

// PrintTree impl for TaffyTree
impl<NodeContext> PrintTree for TaffyTree<NodeContext> {
    #[inline(always)]
    fn get_debug_label(&self, node_id: NodeId) -> &'static str {
        let node = &self.nodes[node_id.into()];
        let display = node.style.display;
        let num_children = self.child_count(node_id);

        match (num_children, display) {
            (_, Display::None) => "NONE",
            (0, _) => "LEAF",
            #[cfg(feature = "block_layout")]
            (_, Display::Block) => "BLOCK",
            #[cfg(feature = "flexbox")]
            (_, Display::Flex) => {
                use crate::FlexDirection;
                match node.style.flex_direction {
                    FlexDirection::Row | FlexDirection::RowReverse => "FLEX ROW",
                    FlexDirection::Column | FlexDirection::ColumnReverse => "FLEX COL",
                }
            }
            #[cfg(feature = "grid")]
            (_, Display::Grid) => "GRID",
        }
    }

    #[inline(always)]
    fn get_final_layout(&self, node_id: NodeId) -> Layout {
        if self.config.use_rounding {
            self.nodes[node_id.into()].final_layout
        } else {
            self.nodes[node_id.into()].unrounded_layout
        }
    }
}

/// View over the Taffy tree that holds the tree itself along with a reference to the context
/// and implements LayoutTree. This allows the context to be stored outside of the TaffyTree struct
/// which makes the lifetimes of the context much more flexible.
pub(crate) struct TaffyView<'t, NodeContext, MeasureFunction>
where
    MeasureFunction:
        FnMut(Size<Option<f32>>, Size<AvailableSpace>, NodeId, Option<&mut NodeContext>, &Style) -> Size<f32>,
{
    /// A reference to the TaffyTree
    pub(crate) taffy: &'t mut TaffyTree<NodeContext>,
    /// The context provided for passing to measure functions if layout is run over this struct
    pub(crate) measure_function: MeasureFunction,
}

// TraversePartialTree impl for TaffyView
impl<NodeContext, MeasureFunction> TraversePartialTree for TaffyView<'_, NodeContext, MeasureFunction>
where
    MeasureFunction:
        FnMut(Size<Option<f32>>, Size<AvailableSpace>, NodeId, Option<&mut NodeContext>, &Style) -> Size<f32>,
{
    type ChildIter<'a>
        = TaffyTreeChildIter<'a>
    where
        Self: 'a;

    #[inline(always)]
    fn child_ids(&self, parent_node_id: NodeId) -> Self::ChildIter<'_> {
        self.taffy.child_ids(parent_node_id)
    }

    #[inline(always)]
    fn child_count(&self, parent_node_id: NodeId) -> usize {
        self.taffy.child_count(parent_node_id)
    }

    #[inline(always)]
    fn get_child_id(&self, parent_node_id: NodeId, child_index: usize) -> NodeId {
        self.taffy.get_child_id(parent_node_id, child_index)
    }
}

// TraverseTree impl for TaffyView
impl<NodeContext, MeasureFunction> TraverseTree for TaffyView<'_, NodeContext, MeasureFunction> where
    MeasureFunction:
        FnMut(Size<Option<f32>>, Size<AvailableSpace>, NodeId, Option<&mut NodeContext>, &Style) -> Size<f32>
{
}

// LayoutPartialTree impl for TaffyView
impl<NodeContext, MeasureFunction> LayoutPartialTree for TaffyView<'_, NodeContext, MeasureFunction>
where
    MeasureFunction:
        FnMut(Size<Option<f32>>, Size<AvailableSpace>, NodeId, Option<&mut NodeContext>, &Style) -> Size<f32>,
{
    type CoreContainerStyle<'a>
        = &'a Style
    where
        Self: 'a;

    type CustomIdent = DefaultCheapStr;

    #[inline(always)]
    fn get_core_container_style(&self, node_id: NodeId) -> Self::CoreContainerStyle<'_> {
        &self.taffy.nodes[node_id.into()].style
    }

    #[inline(always)]
    fn set_unrounded_layout(&mut self, node_id: NodeId, layout: &Layout) {
        let node = &mut self.taffy.nodes[node_id.into()];
        node.unrounded_layout = *layout;
        // mirin: round it again (`TaffyTree::round_changed`).
        node.written = true;
    }

    #[inline(always)]
    fn resolve_calc_value(&self, _val: *const (), _basis: f32) -> f32 {
        0.0
    }

    #[inline(always)]
    fn compute_child_layout(&mut self, node: NodeId, inputs: LayoutInput) -> LayoutOutput {
        // If RunMode is PerformHiddenLayout then this indicates that an ancestor node is `Display::None`
        // and thus that we should lay out this node using hidden layout regardless of it's own display style.
        if inputs.run_mode == RunMode::PerformHiddenLayout {
            debug_log!("HIDDEN");
            // mirin: its children are laid out again (`TaffyTree::round_changed`).
            self.taffy.nodes[node.into()].ran = true;
            return compute_hidden_layout(self, node);
        }

        // We run the following wrapped in "compute_cached_layout", which will check the cache for an entry matching the node and inputs and:
        //   - Return that entry if exists
        //   - Else call the passed closure (below) to compute the result
        //
        // If there was no cache match and a new result needs to be computed then that result will be added to the cache
        compute_cached_layout(self, node, inputs, |tree, node, inputs| {
            // mirin: its children may be laid out again (`TaffyTree::round_changed`).
            tree.taffy.nodes[node.into()].ran = true;
            let display_mode = tree.taffy.nodes[node.into()].style.display;
            let has_children = tree.child_count(node) > 0;

            debug_log!(display_mode);
            debug_log_node!(
                inputs.known_dimensions,
                inputs.parent_size,
                inputs.available_space,
                inputs.run_mode,
                inputs.sizing_mode
            );

            // Dispatch to a layout algorithm based on the node's display style and whether the node has children or not.
            match (display_mode, has_children) {
                (Display::None, _) => compute_hidden_layout(tree, node),
                #[cfg(feature = "block_layout")]
                (Display::Block, true) => compute_block_layout(tree, node, inputs),
                #[cfg(feature = "flexbox")]
                (Display::Flex, true) => compute_flexbox_layout(tree, node, inputs),
                #[cfg(feature = "grid")]
                (Display::Grid, true) => compute_grid_layout(tree, node, inputs),
                (_, false) => {
                    let node_key = node.into();
                    let style = &tree.taffy.nodes[node_key].style;
                    let has_context = tree.taffy.nodes[node_key].has_context;
                    let node_context = has_context.then(|| tree.taffy.node_context_data.get_mut(node_key)).flatten();
                    // mirin: what the measure function is asked is kept
                    // (`TaffyTree::last_measure_inputs`), and that it was
                    // asked again after the layout the node was made in
                    // (`TaffyTree::asked_since`).
                    let mut asked = None;
                    let measure_function = |known_dimensions, available_space| {
                        if has_context {
                            asked = Some((known_dimensions, available_space));
                        }
                        (tree.measure_function)(known_dimensions, available_space, node, node_context, style)
                    };
                    // TODO: implement calc() in high-level API
                    let output = compute_leaf_layout(inputs, style, |_, _| 0.0, measure_function);
                    if let Some(asked) = asked {
                        tree.taffy.last_measures.insert(node_key, asked);
                        let epoch = tree.taffy.epoch;
                        let data = &mut tree.taffy.nodes[node_key];
                        if data.rounded_at.is_some() {
                            data.asked_at = epoch;
                        }
                    }
                    output
                }
            }
        })
    }
}

impl<NodeContext, MeasureFunction> CacheTree for TaffyView<'_, NodeContext, MeasureFunction>
where
    MeasureFunction:
        FnMut(Size<Option<f32>>, Size<AvailableSpace>, NodeId, Option<&mut NodeContext>, &Style) -> Size<f32>,
{
    fn cache_get(
        &self,
        node_id: NodeId,
        known_dimensions: Size<Option<f32>>,
        available_space: Size<AvailableSpace>,
        run_mode: RunMode,
    ) -> Option<LayoutOutput> {
        self.taffy.nodes[node_id.into()].cache.get(known_dimensions, available_space, run_mode)
    }

    fn cache_store(
        &mut self,
        node_id: NodeId,
        known_dimensions: Size<Option<f32>>,
        available_space: Size<AvailableSpace>,
        run_mode: RunMode,
        layout_output: LayoutOutput,
    ) {
        self.taffy.nodes[node_id.into()].cache.store(known_dimensions, available_space, run_mode, layout_output)
    }

    fn cache_clear(&mut self, node_id: NodeId) {
        self.taffy.nodes[node_id.into()].cache.clear();
    }
}

#[cfg(feature = "block_layout")]
impl<NodeContext, MeasureFunction> LayoutBlockContainer for TaffyView<'_, NodeContext, MeasureFunction>
where
    MeasureFunction:
        FnMut(Size<Option<f32>>, Size<AvailableSpace>, NodeId, Option<&mut NodeContext>, &Style) -> Size<f32>,
{
    type BlockContainerStyle<'a>
        = &'a Style
    where
        Self: 'a;
    type BlockItemStyle<'a>
        = &'a Style
    where
        Self: 'a;

    #[inline(always)]
    fn get_block_container_style(&self, node_id: NodeId) -> Self::BlockContainerStyle<'_> {
        self.get_core_container_style(node_id)
    }

    #[inline(always)]
    fn get_block_child_style(&self, child_node_id: NodeId) -> Self::BlockItemStyle<'_> {
        self.get_core_container_style(child_node_id)
    }
}

#[cfg(feature = "flexbox")]
impl<NodeContext, MeasureFunction> LayoutFlexboxContainer for TaffyView<'_, NodeContext, MeasureFunction>
where
    MeasureFunction:
        FnMut(Size<Option<f32>>, Size<AvailableSpace>, NodeId, Option<&mut NodeContext>, &Style) -> Size<f32>,
{
    type FlexboxContainerStyle<'a>
        = &'a Style
    where
        Self: 'a;
    type FlexboxItemStyle<'a>
        = &'a Style
    where
        Self: 'a;

    #[inline(always)]
    fn get_flexbox_container_style(&self, node_id: NodeId) -> Self::FlexboxContainerStyle<'_> {
        &self.taffy.nodes[node_id.into()].style
    }

    #[inline(always)]
    fn get_flexbox_child_style(&self, child_node_id: NodeId) -> Self::FlexboxItemStyle<'_> {
        &self.taffy.nodes[child_node_id.into()].style
    }
}

#[cfg(feature = "grid")]
impl<NodeContext, MeasureFunction> LayoutGridContainer for TaffyView<'_, NodeContext, MeasureFunction>
where
    MeasureFunction:
        FnMut(Size<Option<f32>>, Size<AvailableSpace>, NodeId, Option<&mut NodeContext>, &Style) -> Size<f32>,
{
    type GridContainerStyle<'a>
        = &'a Style
    where
        Self: 'a;
    type GridItemStyle<'a>
        = &'a Style
    where
        Self: 'a;

    #[inline(always)]
    fn get_grid_container_style(&self, node_id: NodeId) -> Self::GridContainerStyle<'_> {
        &self.taffy.nodes[node_id.into()].style
    }

    #[inline(always)]
    fn get_grid_child_style(&self, child_node_id: NodeId) -> Self::GridItemStyle<'_> {
        &self.taffy.nodes[child_node_id.into()].style
    }

    #[inline(always)]
    #[cfg(feature = "detailed_layout_info")]
    fn set_detailed_grid_info(&mut self, node_id: NodeId, detailed_grid_info: DetailedGridInfo) {
        self.taffy.nodes[node_id.into()].detailed_layout_info = DetailedLayoutInfo::Grid(Box::new(detailed_grid_info));
    }
}

// RoundTree impl for TaffyView
impl<NodeContext, MeasureFunction> RoundTree for TaffyView<'_, NodeContext, MeasureFunction>
where
    MeasureFunction:
        FnMut(Size<Option<f32>>, Size<AvailableSpace>, NodeId, Option<&mut NodeContext>, &Style) -> Size<f32>,
{
    #[inline(always)]
    fn get_unrounded_layout(&self, node: NodeId) -> Layout {
        self.taffy.nodes[node.into()].unrounded_layout
    }

    #[inline(always)]
    fn set_final_layout(&mut self, node_id: NodeId, layout: &Layout) {
        self.taffy.nodes[node_id.into()].final_layout = *layout;
    }
}

#[allow(clippy::iter_cloned_collect)] // due to no-std support, we need to use `iter_cloned` instead of `collect`
impl<NodeContext> TaffyTree<NodeContext> {
    /// Creates a new [`TaffyTree`]
    ///
    /// The default capacity of a [`TaffyTree`] is 16 nodes.
    #[must_use]
    pub fn new() -> Self {
        Self::with_capacity(16)
    }

    /// Creates a new [`TaffyTree`] that can store `capacity` nodes before reallocation
    #[must_use]
    pub fn with_capacity(capacity: usize) -> Self {
        TaffyTree {
            // TODO: make this method const upstream,
            // so constructors here can be const
            nodes: SlotMap::with_capacity(capacity),
            children: SlotMap::with_capacity(capacity),
            parents: SlotMap::with_capacity(capacity),
            node_context_data: SecondaryMap::with_capacity(capacity),
            config: TaffyConfig::default(),
            epoch: 0,
            last_measures: SecondaryMap::new(),
        }
    }

    /// Enable rounding of layout values. Rounding is enabled by default.
    pub fn enable_rounding(&mut self) {
        self.config.use_rounding = true;
    }

    /// Disable rounding of layout values. Rounding is enabled by default.
    pub fn disable_rounding(&mut self) {
        self.config.use_rounding = false;
    }

    /// Creates and adds a new unattached leaf node to the tree, and returns the node of the new node
    pub fn new_leaf(&mut self, layout: Style) -> TaffyResult<NodeId> {
        let id = self.nodes.insert(NodeData::new(layout));
        let _ = self.children.insert(new_vec_with_capacity(0));
        let _ = self.parents.insert(None);

        Ok(id.into())
    }

    /// Creates and adds a new unattached leaf node to the tree, and returns the [`NodeId`] of the new node
    ///
    /// Creates and adds a new leaf node with a supplied context
    pub fn new_leaf_with_context(&mut self, layout: Style, context: NodeContext) -> TaffyResult<NodeId> {
        let mut data = NodeData::new(layout);
        data.has_context = true;

        let id = self.nodes.insert(data);
        self.node_context_data.insert(id, context);

        let _ = self.children.insert(new_vec_with_capacity(0));
        let _ = self.parents.insert(None);

        Ok(id.into())
    }

    /// Creates and adds a new node, which may have any number of `children`
    pub fn new_with_children(&mut self, layout: Style, children: &[NodeId]) -> TaffyResult<NodeId> {
        let id = NodeId::from(self.nodes.insert(NodeData::new(layout)));

        for child in children {
            self.parents[(*child).into()] = Some(id);
        }

        let _ = self.children.insert(children.iter().copied().collect::<_>());
        let _ = self.parents.insert(None);

        Ok(id)
    }

    /// Drops all nodes in the tree
    pub fn clear(&mut self) {
        self.nodes.clear();
        self.children.clear();
        self.parents.clear();
        // mirin: what was kept per measured leaf goes with the nodes.
        self.last_measures.clear();
    }

    /// Remove a specific node from the tree and drop it
    ///
    /// Returns the id of the node removed.
    pub fn remove(&mut self, node: NodeId) -> TaffyResult<NodeId> {
        let key = node.into();
        if let Some(parent) = self.parents[key] {
            if let Some(children) = self.children.get_mut(parent.into()) {
                children.retain(|f| *f != node);
            }
        }

        // Remove "parent" references to a node when removing that node
        if let Some(children) = self.children.get(key) {
            for child in children.iter().copied() {
                // mirin: only where it is still the parent. A tree kept across
                // layouts (GPUI's retained subtrees) gives a child a new parent
                // before the old one is removed.
                if let Some(parent) = self.parents.get_mut(child.into()) {
                    if *parent == Some(node) {
                        *parent = None;
                    }
                }
            }
        }

        let _ = self.children.remove(key);
        let _ = self.parents.remove(key);
        let _ = self.nodes.remove(key);
        // mirin: drop its context (a measure function and what it holds) now,
        // not when the slot is reused.
        let _ = self.node_context_data.remove(key);
        let _ = self.last_measures.remove(key);

        Ok(node)
    }

    /// Sets the context data associated with the node
    #[inline]
    pub fn set_node_context(&mut self, node: NodeId, measure: Option<NodeContext>) -> TaffyResult<()> {
        let key = node.into();
        if let Some(measure) = measure {
            self.nodes[key].has_context = true;
            self.node_context_data.insert(key, measure);
        } else {
            self.nodes[key].has_context = false;
            self.node_context_data.remove(key);
        }

        self.mark_dirty(node)?;

        Ok(())
    }

    /// Gets a reference to the the context data associated with the node
    #[inline]
    pub fn get_node_context(&self, node: NodeId) -> Option<&NodeContext> {
        self.node_context_data.get(node.into())
    }

    /// Gets a mutable reference to the the context data associated with the node
    #[inline]
    pub fn get_node_context_mut(&mut self, node: NodeId) -> Option<&mut NodeContext> {
        self.node_context_data.get_mut(node.into())
    }

    /// Gets mutable references to the the context data associated with the nodes. All keys must be valid and disjoint, otherwise None is returned.
    pub fn get_disjoint_node_context_mut<const N: usize>(
        &mut self,
        keys: [NodeId; N],
    ) -> Option<[&mut NodeContext; N]> {
        self.node_context_data.get_disjoint_mut(keys.map(|k| k.into()))
    }

    /// Adds a `child` node under the supplied `parent`
    pub fn add_child(&mut self, parent: NodeId, child: NodeId) -> TaffyResult<()> {
        let parent_key = parent.into();
        let child_key = child.into();
        self.parents[child_key] = Some(parent);
        self.children[parent_key].push(child);
        self.mark_dirty(parent)?;

        Ok(())
    }

    /// Inserts a `child` node at the given `child_index` under the supplied `parent`, shifting all children after it to the right.
    pub fn insert_child_at_index(&mut self, parent: NodeId, child_index: usize, child: NodeId) -> TaffyResult<()> {
        let parent_key = parent.into();

        let child_count = self.children[parent_key].len();
        if child_index > child_count {
            return Err(TaffyError::ChildIndexOutOfBounds { parent, child_index, child_count });
        }

        self.parents[child.into()] = Some(parent);
        self.children[parent_key].insert(child_index, child);
        self.mark_dirty(parent)?;

        Ok(())
    }

    /// Directly sets the `children` of the supplied `parent`
    pub fn set_children(&mut self, parent: NodeId, children: &[NodeId]) -> TaffyResult<()> {
        let parent_key = parent.into();

        // Remove node as parent from all its current children.
        for child in &self.children[parent_key] {
            self.parents[(*child).into()] = None;
        }

        // Build up relation node <-> child
        for &child in children {
            // Remove child from previous parent
            if let Some(previous_parent) = self.parents[child.into()] {
                self.remove_child(previous_parent, child).unwrap();
            }
            self.parents[child.into()] = Some(parent);
        }

        let parent_children = &mut self.children[parent_key];
        parent_children.clear();
        children.iter().for_each(|child| parent_children.push(*child));

        self.mark_dirty(parent)?;

        Ok(())
    }

    /// Removes the `child` of the parent `node`
    ///
    /// The child is not removed from the tree entirely, it is simply no longer attached to its previous parent.
    pub fn remove_child(&mut self, parent: NodeId, child: NodeId) -> TaffyResult<NodeId> {
        let index = self.children[parent.into()].iter().position(|n| *n == child).unwrap();
        self.remove_child_at_index(parent, index)
    }

    /// Removes the child at the given `index` from the `parent`
    ///
    /// The child is not removed from the tree entirely, it is simply no longer attached to its previous parent.
    pub fn remove_child_at_index(&mut self, parent: NodeId, child_index: usize) -> TaffyResult<NodeId> {
        let parent_key = parent.into();
        let child_count = self.children[parent_key].len();
        if child_index >= child_count {
            return Err(TaffyError::ChildIndexOutOfBounds { parent, child_index, child_count });
        }

        let child = self.children[parent_key].remove(child_index);
        self.parents[child.into()] = None;

        self.mark_dirty(parent)?;

        Ok(child)
    }

    /// Removes children at the given range from the `parent`
    ///
    /// Children are not removed from the tree entirely, they are simply no longer attached to their previous parent.
    ///
    /// Function will panic if given range is invalid. See [`core::slice::range`]
    pub fn remove_children_range<R>(&mut self, parent: NodeId, range: R) -> TaffyResult<()>
    where
        R: core::ops::RangeBounds<usize>,
    {
        let parent_key = parent.into();
        for child in self.children[parent_key].drain(range) {
            self.parents[child.into()] = None;
        }

        self.mark_dirty(parent)?;
        Ok(())
    }

    /// Replaces the child at the given `child_index` from the `parent` node with the new `child` node
    ///
    /// The child is not removed from the tree entirely, it is simply no longer attached to its previous parent.
    pub fn replace_child_at_index(
        &mut self,
        parent: NodeId,
        child_index: usize,
        new_child: NodeId,
    ) -> TaffyResult<NodeId> {
        let parent_key = parent.into();

        let child_count = self.children[parent_key].len();
        if child_index >= child_count {
            return Err(TaffyError::ChildIndexOutOfBounds { parent, child_index, child_count });
        }

        self.parents[new_child.into()] = Some(parent);
        let old_child = core::mem::replace(&mut self.children[parent_key][child_index], new_child);
        self.parents[old_child.into()] = None;

        self.mark_dirty(parent)?;

        Ok(old_child)
    }

    /// Returns the child node of the parent `node` at the provided `child_index`
    #[inline]
    pub fn child_at_index(&self, parent: NodeId, child_index: usize) -> TaffyResult<NodeId> {
        let parent_key = parent.into();
        let child_count = self.children[parent_key].len();
        if child_index >= child_count {
            return Err(TaffyError::ChildIndexOutOfBounds { parent, child_index, child_count });
        }

        Ok(self.children[parent_key][child_index])
    }

    /// mirin: whether `node` is (still) in the tree. A kept node id can
    /// outlive its node; GPUI checks before reusing one.
    pub fn contains(&self, node: NodeId) -> bool {
        self.nodes.contains_key(node.into())
    }

    /// Returns the total number of nodes in the tree
    #[inline]
    pub fn total_node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Returns the `NodeId` of the parent node of the specified node (if it exists)
    ///
    /// - Return None if the specified node has no parent
    /// - Panics if the specified node does not exist
    #[inline]
    pub fn parent(&self, child_id: NodeId) -> Option<NodeId> {
        self.parents[child_id.into()]
    }

    /// Returns a list of children that belong to the parent node
    pub fn children(&self, parent: NodeId) -> TaffyResult<Vec<NodeId>> {
        Ok(self.children[parent.into()].clone())
    }

    /// Sets the [`Style`] of the provided `node`
    #[inline]
    pub fn set_style(&mut self, node: NodeId, style: Style) -> TaffyResult<()> {
        self.nodes[node.into()].style = style;
        self.mark_dirty(node)?;
        Ok(())
    }

    /// Gets the [`Style`] of the provided `node`
    #[inline]
    pub fn style(&self, node: NodeId) -> TaffyResult<&Style> {
        Ok(&self.nodes[node.into()].style)
    }

    /// Return this node layout relative to its parent
    #[inline]
    pub fn layout(&self, node: NodeId) -> TaffyResult<&Layout> {
        if self.config.use_rounding {
            Ok(&self.nodes[node.into()].final_layout)
        } else {
            Ok(&self.nodes[node.into()].unrounded_layout)
        }
    }

    /// Returns this node layout with unrounded values relative to its parent.
    #[inline]
    pub fn unrounded_layout(&self, node: NodeId) -> &Layout {
        &self.nodes[node.into()].unrounded_layout
    }

    /// Get the "detailed layout info" for a node.
    ///
    /// Currently this is only implemented for CSS Grid containers where it contains
    /// the computed size of each grid track and the computed placement of each grid item
    #[cfg(feature = "detailed_layout_info")]
    #[inline]
    pub fn detailed_layout_info(&self, node_id: NodeId) -> &DetailedLayoutInfo {
        &self.nodes[node_id.into()].detailed_layout_info
    }

    /// Marks the layout of this node and its ancestors as outdated
    pub fn mark_dirty(&mut self, node: NodeId) -> TaffyResult<()> {
        fn mark_dirty_recursive(
            nodes: &mut SlotMap<DefaultKey, NodeData>,
            parents: &SlotMap<DefaultKey, Option<NodeId>>,
            node_key: DefaultKey,
        ) {
            match nodes[node_key].mark_dirty() {
                ClearState::AlreadyEmpty => {
                    // Node was already marked as dirty.
                    // No need to visit ancestors
                    // as they should be marked as dirty already.
                }
                ClearState::Cleared => {
                    if let Some(Some(node)) = parents.get(node_key) {
                        mark_dirty_recursive(nodes, parents, (*node).into());
                    }
                }
            }
        }

        mark_dirty_recursive(&mut self.nodes, &self.parents, node.into());

        Ok(())
    }

    /// Indicates whether the layout of this node needs to be recomputed
    #[inline]
    pub fn dirty(&self, node: NodeId) -> TaffyResult<bool> {
        Ok(self.nodes[node.into()].cache.is_empty())
    }

    /// Updates the stored layout of the provided `node` and its children
    pub fn compute_layout_with_measure<MeasureFunction>(
        &mut self,
        node_id: NodeId,
        available_space: Size<AvailableSpace>,
        measure_function: MeasureFunction,
    ) -> Result<(), TaffyError>
    where
        MeasureFunction:
            FnMut(Size<Option<f32>>, Size<AvailableSpace>, NodeId, Option<&mut NodeContext>, &Style) -> Size<f32>,
    {
        let use_rounding = self.config.use_rounding;
        // mirin: a new layout (`layout_epoch`).
        self.epoch += 1;
        let mut taffy_view = TaffyView { taffy: self, measure_function };
        compute_root_layout(&mut taffy_view, node_id, available_space);
        if use_rounding {
            // mirin: round only what this layout touched (`round_changed`).
            self.round_changed(node_id, 0.0, 0.0, true);
        }
        Ok(())
    }

    // mirin: incremental rounding. Produces exactly what `round_layout` does,
    // but skips a subtree whose root's unrounded layout was not written, whose
    // layout algorithm did not run, and whose parent sits where it sat when it
    // was last rounded: a node's children are laid out (written) only when
    // it runs, so nothing below such a node changed either. A tree kept
    // across layouts (GPUI's retained subtrees, where taffy's cache skips
    // clean subtrees) then rounds in time proportional to what changed.
    //
    // A subtree whose parent moved by whole pixels is skipped too: every
    // edge in it rounds as it did, that many pixels away, unless it sits so
    // close to half a pixel that the sums' rounding could tip it (`near_half`;
    // such a node, and the ones around it, are rounded again). So what moved
    // because something above it grew costs what changed, not what moved.
    //
    // Returns whether an edge of `node`, or of a node below it, is close to
    // half a pixel.
    fn round_changed(&mut self, node: NodeId, parent_x: f32, parent_y: f32, force: bool) -> bool {
        let data = &mut self.nodes[node.into()];
        if !force && !data.written && !data.ran {
            if data.rounded_at == Some((parent_x, parent_y)) {
                return data.near_half;
            }
            let moved_whole = data
                .rounded_at
                .is_some_and(|(x, y)| whole_pixels(x, parent_x) && whole_pixels(y, parent_y));
            if moved_whole && !data.near_half {
                return false;
            }
        }
        let unrounded = data.unrounded_layout;
        let x = parent_x + unrounded.location.x;
        let y = parent_y + unrounded.location.y;
        let before = data.final_layout;
        data.final_layout = crate::compute::round_node(&unrounded, x, y);
        data.written = false;
        data.ran = false;
        data.rounded_at = Some((parent_x, parent_y));
        // mirin: what changed inside whom (`inner_changed_since`). Its own
        // box changed: inside it. It only moved: inside its parent. An
        // algorithm that ran again and placed everything as it was changed
        // nothing.
        let after = data.final_layout;
        if (Layout { location: before.location, ..after }) != before {
            self.mark_inner_changed(Some(node));
        } else if after.location != before.location {
            self.mark_inner_changed(self.parents[node.into()]);
        }
        // mirin: and below whom (`below_changed_since`): every node around
        // one whose box or place changed.
        if after != before {
            self.mark_below_changed(self.parents[node.into()]);
        }
        let mut near_half = near_half_pixel(&unrounded, x, y);
        for index in 0..self.children[node.into()].len() {
            let child = self.children[node.into()][index];
            near_half |= self.round_changed(child, x, y, false);
        }
        self.nodes[node.into()].near_half = near_half;
        near_half
    }

    // mirin: this layout changed something inside `node` and so inside
    // every node around it.
    fn mark_inner_changed(&mut self, mut node: Option<NodeId>) {
        while let Some(id) = node {
            let data = &mut self.nodes[id.into()];
            if data.inner_changed_at == self.epoch {
                break;
            }
            data.inner_changed_at = self.epoch;
            node = self.parents[id.into()];
        }
    }

    // mirin: this layout changed the box or place of a node below `node`,
    // and so below every node around it.
    fn mark_below_changed(&mut self, mut node: Option<NodeId>) {
        while let Some(id) = node {
            let data = &mut self.nodes[id.into()];
            if data.below_changed_at == self.epoch {
                break;
            }
            data.below_changed_at = self.epoch;
            node = self.parents[id.into()];
        }
    }

    /// mirin: how many layouts this tree has computed. With
    /// [`Self::inner_changed_since`], what a kept subtree's drawing checks
    /// before it is reused.
    pub fn layout_epoch(&self) -> u32 {
        self.epoch
    }

    /// mirin: whether a layout after `epoch` changed anything inside `node`:
    /// its own size, border or padding, or the rounded layout of any node
    /// below it. Where `node` itself sits in its parent is not inside it,
    /// and a layout that ran again inside it and came out the same changed
    /// nothing.
    pub fn inner_changed_since(&self, node: NodeId, epoch: u32) -> bool {
        !matches!(self.nodes.get(node.into()), Some(data) if data.inner_changed_at <= epoch)
    }

    /// mirin: whether a layout after `epoch` changed the rounded layout of a
    /// node below `node` (its box or where it sits). Unlike
    /// [`Self::inner_changed_since`], `node`'s own box does not count: a
    /// node that was only resized, everything in it laid out as it was,
    /// changed nothing below it.
    pub fn below_changed_since(&self, node: NodeId, epoch: u32) -> bool {
        !matches!(self.nodes.get(node.into()), Some(data) if data.below_changed_at <= epoch)
    }

    /// mirin: whether a layout after `epoch` asked the measured leaf `node`
    /// again (the layout it was made in does not count). Until then it holds
    /// what a layout from nothing leaves it with; after, what it holds
    /// depends on which of its answers the cache still had.
    pub fn asked_since(&self, node: NodeId, epoch: u32) -> bool {
        !matches!(self.nodes.get(node.into()), Some(data) if data.asked_at <= epoch)
    }

    /// mirin: the known dimensions and available space a measured leaf's
    /// function was last asked: what to ask a new function for the same
    /// node so it holds what the old one did.
    pub fn last_measure_inputs(&self, node: NodeId) -> Option<(Size<Option<f32>>, Size<AvailableSpace>)> {
        self.last_measures.get(node.into()).copied()
    }

    /// mirin: lay `node` out as `twin` is laid out where it sits: the same
    /// size, inside the same parent, its location the same, and rounded at
    /// the same position. `node` is a detached copy of `twin`'s subtree built
    /// from the same content (GPUI's retained subtree drawn again where its
    /// layout is kept but its last frame's drawing could not be reused), so
    /// its layout comes out as `twin`'s did without laying the tree around
    /// `twin` out again.
    pub fn compute_detached_layout_with_measure<MeasureFunction>(
        &mut self,
        node: NodeId,
        twin: NodeId,
        measure_function: MeasureFunction,
    ) -> Result<(), TaffyError>
    where
        MeasureFunction:
            FnMut(Size<Option<f32>>, Size<AvailableSpace>, NodeId, Option<&mut NodeContext>, &Style) -> Size<f32>,
    {
        let twin_layout = self.nodes.get(twin.into()).ok_or(TaffyError::InvalidInputNode(twin))?.unrounded_layout;
        let mut parent_size = Size::NONE;
        let (mut parent_x, mut parent_y) = (0.0, 0.0);
        let mut ancestor = self.parents.get(twin.into()).copied().flatten();
        if let Some(parent) = ancestor {
            let parent = &self.nodes[parent.into()].unrounded_layout;
            let edges = parent.padding + parent.border;
            parent_size = Size {
                width: Some(parent.size.width - edges.left - edges.right),
                height: Some(parent.size.height - edges.top - edges.bottom),
            };
        }
        while let Some(id) = ancestor {
            let location = self.nodes[id.into()].unrounded_layout.location;
            parent_x += location.x;
            parent_y += location.y;
            ancestor = self.parents[id.into()];
        }
        let available_space = Size {
            width: parent_size.width.map_or(AvailableSpace::MaxContent, AvailableSpace::Definite),
            height: parent_size.height.map_or(AvailableSpace::MaxContent, AvailableSpace::Definite),
        };
        let use_rounding = self.config.use_rounding;
        self.epoch += 1;
        let mut taffy_view = TaffyView { taffy: self, measure_function };
        let output = taffy_view.perform_child_layout(
            node,
            Size { width: Some(twin_layout.size.width), height: Some(twin_layout.size.height) },
            parent_size,
            available_space,
            crate::tree::SizingMode::ContentSize,
            crate::geometry::Line::FALSE,
        );
        let mut layout = twin_layout;
        layout.content_size = output.content_size;
        let data = &mut self.nodes[node.into()];
        data.unrounded_layout = layout;
        data.written = true;
        if use_rounding {
            self.round_changed(node, parent_x, parent_y, true);
        }
        Ok(())
    }

    /// Updates the stored layout of the provided `node` and its children
    pub fn compute_layout(&mut self, node: NodeId, available_space: Size<AvailableSpace>) -> Result<(), TaffyError> {
        self.compute_layout_with_measure(node, available_space, |_, _, _, _, _| Size::ZERO)
    }

    /// Prints a debug representation of the tree's layout
    #[cfg(feature = "std")]
    pub fn print_tree(&mut self, root: NodeId) {
        crate::util::print_tree(self, root)
    }

    /// Returns an instance of LayoutTree representing the TaffyTree
    #[cfg(test)]
    pub(crate) fn as_layout_tree(&mut self) -> impl LayoutPartialTree + CacheTree + '_ {
        TaffyView { taffy: self, measure_function: |_, _, _, _, _| Size::ZERO }
    }
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::style::{Dimension, Display, FlexDirection};
    use crate::style_helpers::*;
    use crate::util::sys;

    fn size_measure_function(
        known_dimensions: Size<Option<f32>>,
        _available_space: Size<AvailableSpace>,
        _node_id: NodeId,
        node_context: Option<&mut Size<f32>>,
        _style: &Style,
    ) -> Size<f32> {
        known_dimensions.unwrap_or(node_context.cloned().unwrap_or(Size::ZERO))
    }

    #[test]
    fn new_should_allocate_default_capacity() {
        const DEFAULT_CAPACITY: usize = 16; // This is the capacity defined in the `impl Default`
        let taffy: TaffyTree<()> = TaffyTree::new();

        assert!(taffy.children.capacity() >= DEFAULT_CAPACITY);
        assert!(taffy.parents.capacity() >= DEFAULT_CAPACITY);
        assert!(taffy.nodes.capacity() >= DEFAULT_CAPACITY);
    }

    #[test]
    fn test_with_capacity() {
        const CAPACITY: usize = 8;
        let taffy: TaffyTree<()> = TaffyTree::with_capacity(CAPACITY);

        assert!(taffy.children.capacity() >= CAPACITY);
        assert!(taffy.parents.capacity() >= CAPACITY);
        assert!(taffy.nodes.capacity() >= CAPACITY);
    }

    #[test]
    fn test_new_leaf() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();

        let res = taffy.new_leaf(Style::default());
        assert!(res.is_ok());
        let node = res.unwrap();

        // node should be in the taffy tree and have no children
        assert!(taffy.child_count(node) == 0);
    }

    #[test]
    fn new_leaf_with_context() {
        let mut taffy: TaffyTree<Size<f32>> = TaffyTree::new();

        let res = taffy.new_leaf_with_context(Style::default(), Size::ZERO);
        assert!(res.is_ok());
        let node = res.unwrap();

        // node should be in the taffy tree and have no children
        assert!(taffy.child_count(node) == 0);
    }

    /// Test that new_with_children works as expected
    #[test]
    fn test_new_with_children() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let child0 = taffy.new_leaf(Style::default()).unwrap();
        let child1 = taffy.new_leaf(Style::default()).unwrap();
        let node = taffy.new_with_children(Style::default(), &[child0, child1]).unwrap();

        // node should have two children
        assert_eq!(taffy.child_count(node), 2);
        assert_eq!(taffy.children(node).unwrap()[0], child0);
        assert_eq!(taffy.children(node).unwrap()[1], child1);
    }

    #[test]
    fn remove_node_should_remove() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();

        let node = taffy.new_leaf(Style::default()).unwrap();

        let _ = taffy.remove(node).unwrap();
    }

    #[test]
    fn remove_node_should_detach_hierarchy() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();

        // Build a linear tree layout: <0> <- <1> <- <2>
        let node2 = taffy.new_leaf(Style::default()).unwrap();
        let node1 = taffy.new_with_children(Style::default(), &[node2]).unwrap();
        let node0 = taffy.new_with_children(Style::default(), &[node1]).unwrap();

        // Both node0 and node1 should have 1 child nodes
        assert_eq!(taffy.children(node0).unwrap().as_slice(), &[node1]);
        assert_eq!(taffy.children(node1).unwrap().as_slice(), &[node2]);

        // Disconnect the tree: <0> <2>
        let _ = taffy.remove(node1).unwrap();

        // Both remaining nodes should have no child nodes
        assert!(taffy.children(node0).unwrap().is_empty());
        assert!(taffy.children(node2).unwrap().is_empty());
    }

    #[test]
    fn remove_last_node() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();

        let parent = taffy.new_leaf(Style::default()).unwrap();
        let child = taffy.new_leaf(Style::default()).unwrap();
        taffy.add_child(parent, child).unwrap();

        taffy.remove(child).unwrap();
        taffy.remove(parent).unwrap();
    }

    #[test]
    fn set_measure() {
        let mut taffy: TaffyTree<Size<f32>> = TaffyTree::new();
        let node = taffy.new_leaf_with_context(Style::default(), Size { width: 200.0, height: 200.0 }).unwrap();
        taffy.compute_layout_with_measure(node, Size::MAX_CONTENT, size_measure_function).unwrap();
        assert_eq!(taffy.layout(node).unwrap().size.width, 200.0);

        taffy.set_node_context(node, Some(Size { width: 100.0, height: 100.0 })).unwrap();
        taffy.compute_layout_with_measure(node, Size::MAX_CONTENT, size_measure_function).unwrap();
        assert_eq!(taffy.layout(node).unwrap().size.width, 100.0);
    }

    #[test]
    fn set_measure_of_previously_unmeasured_node() {
        let mut taffy: TaffyTree<Size<f32>> = TaffyTree::new();
        let node = taffy.new_leaf(Style::default()).unwrap();
        taffy.compute_layout_with_measure(node, Size::MAX_CONTENT, size_measure_function).unwrap();
        assert_eq!(taffy.layout(node).unwrap().size.width, 0.0);

        taffy.set_node_context(node, Some(Size { width: 100.0, height: 100.0 })).unwrap();
        taffy.compute_layout_with_measure(node, Size::MAX_CONTENT, size_measure_function).unwrap();
        assert_eq!(taffy.layout(node).unwrap().size.width, 100.0);
    }

    /// Test that adding `add_child()` works
    #[test]
    fn add_child() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let node = taffy.new_leaf(Style::default()).unwrap();
        assert_eq!(taffy.child_count(node), 0);

        let child0 = taffy.new_leaf(Style::default()).unwrap();
        taffy.add_child(node, child0).unwrap();
        assert_eq!(taffy.child_count(node), 1);

        let child1 = taffy.new_leaf(Style::default()).unwrap();
        taffy.add_child(node, child1).unwrap();
        assert_eq!(taffy.child_count(node), 2);
    }

    #[test]
    fn insert_child_at_index() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();

        let child0 = taffy.new_leaf(Style::default()).unwrap();
        let child1 = taffy.new_leaf(Style::default()).unwrap();
        let child2 = taffy.new_leaf(Style::default()).unwrap();

        let node = taffy.new_leaf(Style::default()).unwrap();
        assert_eq!(taffy.child_count(node), 0);

        taffy.insert_child_at_index(node, 0, child0).unwrap();
        assert_eq!(taffy.child_count(node), 1);
        assert_eq!(taffy.children(node).unwrap()[0], child0);

        taffy.insert_child_at_index(node, 0, child1).unwrap();
        assert_eq!(taffy.child_count(node), 2);
        assert_eq!(taffy.children(node).unwrap()[0], child1);
        assert_eq!(taffy.children(node).unwrap()[1], child0);

        taffy.insert_child_at_index(node, 1, child2).unwrap();
        assert_eq!(taffy.child_count(node), 3);
        assert_eq!(taffy.children(node).unwrap()[0], child1);
        assert_eq!(taffy.children(node).unwrap()[1], child2);
        assert_eq!(taffy.children(node).unwrap()[2], child0);
    }

    #[test]
    fn set_children() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();

        let child0 = taffy.new_leaf(Style::default()).unwrap();
        let child1 = taffy.new_leaf(Style::default()).unwrap();
        let node = taffy.new_with_children(Style::default(), &[child0, child1]).unwrap();

        assert_eq!(taffy.child_count(node), 2);
        assert_eq!(taffy.children(node).unwrap()[0], child0);
        assert_eq!(taffy.children(node).unwrap()[1], child1);

        let child2 = taffy.new_leaf(Style::default()).unwrap();
        let child3 = taffy.new_leaf(Style::default()).unwrap();
        taffy.set_children(node, &[child2, child3]).unwrap();

        assert_eq!(taffy.child_count(node), 2);
        assert_eq!(taffy.children(node).unwrap()[0], child2);
        assert_eq!(taffy.children(node).unwrap()[1], child3);
    }

    /// Test that removing a child works
    #[test]
    fn remove_child() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let child0 = taffy.new_leaf(Style::default()).unwrap();
        let child1 = taffy.new_leaf(Style::default()).unwrap();
        let node = taffy.new_with_children(Style::default(), &[child0, child1]).unwrap();

        assert_eq!(taffy.child_count(node), 2);

        taffy.remove_child(node, child0).unwrap();
        assert_eq!(taffy.child_count(node), 1);
        assert_eq!(taffy.children(node).unwrap()[0], child1);

        taffy.remove_child(node, child1).unwrap();
        assert_eq!(taffy.child_count(node), 0);
    }

    #[test]
    fn remove_child_at_index() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let child0 = taffy.new_leaf(Style::default()).unwrap();
        let child1 = taffy.new_leaf(Style::default()).unwrap();
        let node = taffy.new_with_children(Style::default(), &[child0, child1]).unwrap();

        assert_eq!(taffy.child_count(node), 2);

        taffy.remove_child_at_index(node, 0).unwrap();
        assert_eq!(taffy.child_count(node), 1);
        assert_eq!(taffy.children(node).unwrap()[0], child1);

        taffy.remove_child_at_index(node, 0).unwrap();
        assert_eq!(taffy.child_count(node), 0);
    }

    #[test]
    fn remove_children_range() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let child0 = taffy.new_leaf(Style::default()).unwrap();
        let child1 = taffy.new_leaf(Style::default()).unwrap();
        let child2 = taffy.new_leaf(Style::default()).unwrap();
        let child3 = taffy.new_leaf(Style::default()).unwrap();
        let node = taffy.new_with_children(Style::default(), &[child0, child1, child2, child3]).unwrap();

        assert_eq!(taffy.child_count(node), 4);

        taffy.remove_children_range(node, 1..=2).unwrap();
        assert_eq!(taffy.child_count(node), 2);
        assert_eq!(taffy.children(node).unwrap(), [child0, child3]);
        for child in [child0, child3] {
            assert_eq!(taffy.parent(child), Some(node));
        }
        for child in [child1, child2] {
            assert_eq!(taffy.parent(child), None);
        }
    }

    // Related to: https://github.com/DioxusLabs/taffy/issues/510
    #[test]
    fn remove_child_updates_parents() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();

        let parent = taffy.new_leaf(Style::default()).unwrap();
        let child = taffy.new_leaf(Style::default()).unwrap();

        taffy.add_child(parent, child).unwrap();

        taffy.remove(parent).unwrap();

        // Once the parent is removed this shouldn't panic.
        assert!(taffy.set_children(child, &[]).is_ok());
    }

    #[test]
    fn replace_child_at_index() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();

        let child0 = taffy.new_leaf(Style::default()).unwrap();
        let child1 = taffy.new_leaf(Style::default()).unwrap();

        let node = taffy.new_with_children(Style::default(), &[child0]).unwrap();
        assert_eq!(taffy.child_count(node), 1);
        assert_eq!(taffy.children(node).unwrap()[0], child0);

        taffy.replace_child_at_index(node, 0, child1).unwrap();
        assert_eq!(taffy.child_count(node), 1);
        assert_eq!(taffy.children(node).unwrap()[0], child1);
    }
    #[test]
    fn test_child_at_index() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let child0 = taffy.new_leaf(Style::default()).unwrap();
        let child1 = taffy.new_leaf(Style::default()).unwrap();
        let child2 = taffy.new_leaf(Style::default()).unwrap();
        let node = taffy.new_with_children(Style::default(), &[child0, child1, child2]).unwrap();

        assert!(if let Ok(result) = taffy.child_at_index(node, 0) { result == child0 } else { false });
        assert!(if let Ok(result) = taffy.child_at_index(node, 1) { result == child1 } else { false });
        assert!(if let Ok(result) = taffy.child_at_index(node, 2) { result == child2 } else { false });
    }
    #[test]
    fn test_child_count() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let child0 = taffy.new_leaf(Style::default()).unwrap();
        let child1 = taffy.new_leaf(Style::default()).unwrap();
        let node = taffy.new_with_children(Style::default(), &[child0, child1]).unwrap();

        assert!(taffy.child_count(node) == 2);
        assert!(taffy.child_count(child0) == 0);
        assert!(taffy.child_count(child1) == 0);
    }

    #[allow(clippy::vec_init_then_push)]
    #[test]
    fn test_children() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let child0 = taffy.new_leaf(Style::default()).unwrap();
        let child1 = taffy.new_leaf(Style::default()).unwrap();
        let node = taffy.new_with_children(Style::default(), &[child0, child1]).unwrap();

        let mut children = sys::Vec::new();
        children.push(child0);
        children.push(child1);

        let children_result = taffy.children(node).unwrap();
        assert_eq!(children_result, children);

        assert!(taffy.children(child0).unwrap().is_empty());
    }
    #[test]
    fn test_set_style() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();

        let node = taffy.new_leaf(Style::default()).unwrap();
        assert_eq!(taffy.style(node).unwrap().display, Display::Flex);

        taffy.set_style(node, Style { display: Display::None, ..Style::default() }).unwrap();
        assert_eq!(taffy.style(node).unwrap().display, Display::None);
    }
    #[test]
    fn test_style() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();

        let style = Style { display: Display::None, flex_direction: FlexDirection::RowReverse, ..Default::default() };

        let node = taffy.new_leaf(style.clone()).unwrap();

        let res = taffy.style(node);
        assert!(res.is_ok());
        assert!(res.unwrap() == &style);
    }
    #[test]
    fn test_layout() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let node = taffy.new_leaf(Style::default()).unwrap();

        // TODO: Improve this test?
        let res = taffy.layout(node);
        assert!(res.is_ok());
    }

    #[test]
    fn test_mark_dirty() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let child0 = taffy.new_leaf(Style::default()).unwrap();
        let child1 = taffy.new_leaf(Style::default()).unwrap();
        let node = taffy.new_with_children(Style::default(), &[child0, child1]).unwrap();

        taffy.compute_layout(node, Size::MAX_CONTENT).unwrap();

        assert_eq!(taffy.dirty(child0), Ok(false));
        assert_eq!(taffy.dirty(child1), Ok(false));
        assert_eq!(taffy.dirty(node), Ok(false));

        taffy.mark_dirty(node).unwrap();
        assert_eq!(taffy.dirty(child0), Ok(false));
        assert_eq!(taffy.dirty(child1), Ok(false));
        assert_eq!(taffy.dirty(node), Ok(true));

        taffy.compute_layout(node, Size::MAX_CONTENT).unwrap();
        taffy.mark_dirty(child0).unwrap();
        assert_eq!(taffy.dirty(child0), Ok(true));
        assert_eq!(taffy.dirty(child1), Ok(false));
        assert_eq!(taffy.dirty(node), Ok(true));
    }

    #[test]
    fn compute_layout_should_produce_valid_result() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let node_result = taffy.new_leaf(Style {
            size: Size { width: Dimension::from_length(10f32), height: Dimension::from_length(10f32) },
            ..Default::default()
        });
        assert!(node_result.is_ok());
        let node = node_result.unwrap();
        let layout_result = taffy.compute_layout(
            node,
            Size { width: AvailableSpace::Definite(100.), height: AvailableSpace::Definite(100.) },
        );
        assert!(layout_result.is_ok());
    }

    #[test]
    fn make_sure_layout_location_is_top_left() {
        use crate::prelude::*;

        let mut taffy: TaffyTree<()> = TaffyTree::new();

        let node = taffy
            .new_leaf(Style {
                size: Size { width: Dimension::from_percent(1f32), height: Dimension::from_percent(1f32) },
                ..Default::default()
            })
            .unwrap();

        let root = taffy
            .new_with_children(
                Style {
                    size: Size { width: Dimension::from_length(100f32), height: Dimension::from_length(100f32) },
                    padding: Rect {
                        left: length(10f32),
                        right: length(20f32),
                        top: length(30f32),
                        bottom: length(40f32),
                    },
                    ..Default::default()
                },
                &[node],
            )
            .unwrap();

        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();

        // If Layout::location represents top-left coord, 'node' location
        // must be (due applied 'root' padding): {x: 10, y: 30}.
        //
        // It's important, since result will be different for each other
        // coordinate space:
        // - bottom-left:  {x: 10, y: 40}
        // - top-right:    {x: 20, y: 30}
        // - bottom-right: {x: 20, y: 40}
        let layout = taffy.layout(node).unwrap();
        assert_eq!(layout.location.x, 10f32);
        assert_eq!(layout.location.y, 30f32);
    }

    #[test]
    fn set_children_reparents() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let child = taffy.new_leaf(Style::default()).unwrap();
        let old_parent = taffy.new_with_children(Style::default(), &[child]).unwrap();

        let new_parent = taffy.new_leaf(Style::default()).unwrap();
        taffy.set_children(new_parent, &[child]).unwrap();

        assert!(taffy.children(old_parent).unwrap().is_empty());
    }
}

// mirin: incremental rounding (`round_changed`), removal that keeps a moved
// child's new parent, and detached layout (`compute_detached_layout_with_measure`).
#[cfg(test)]
mod mirin_tests {
    use super::*;
    use crate::style::{AlignItems, FlexDirection};
    use crate::style_helpers::*;

    fn cell(taffy: &mut TaffyTree<()>, grow: f32) -> NodeId {
        let leaf =
            taffy.new_leaf(Style { size: Size { width: auto(), height: length(7.3) }, ..Default::default() }).unwrap();
        taffy
            .new_with_children(
                Style { flex_grow: grow, flex_basis: length(0.0), padding: length(1.25), ..Default::default() },
                &[leaf],
            )
            .unwrap()
    }

    fn row_style() -> Style {
        Style {
            flex_direction: FlexDirection::Row,
            size: Size { width: length(100.0), height: auto() },
            padding: length(0.4),
            ..Default::default()
        }
    }

    // Three thirds of 100 px: fractional positions, so rounding matters.
    fn fractional_row(taffy: &mut TaffyTree<()>) -> (NodeId, Vec<NodeId>) {
        let cells: Vec<NodeId> = (0..3).map(|_| cell(taffy, 1.0)).collect();
        let root = taffy.new_with_children(row_style(), &cells).unwrap();
        (root, cells)
    }

    fn layouts(taffy: &TaffyTree<()>, root: NodeId) -> Vec<Layout> {
        let mut out = vec![*taffy.layout(root).unwrap()];
        for child in taffy.children(root).unwrap() {
            out.extend(layouts(taffy, child));
        }
        out
    }

    #[test]
    fn rounding_only_what_changed_matches_rounding_everything() {
        let wider = Style { flex_grow: 2.0, flex_basis: length(0.0), padding: length(1.25), ..Default::default() };
        let mut kept: TaffyTree<()> = TaffyTree::new();
        let (root, cells) = fractional_row(&mut kept);
        kept.compute_layout(root, Size::MAX_CONTENT).unwrap();
        // Change one cell; the rest keep their cache and are not all rounded again.
        kept.set_style(cells[1], wider.clone()).unwrap();
        kept.compute_layout(root, Size::MAX_CONTENT).unwrap();

        let mut fresh: TaffyTree<()> = TaffyTree::new();
        let (fresh_root, fresh_cells) = fractional_row(&mut fresh);
        fresh.set_style(fresh_cells[1], wider).unwrap();
        fresh.compute_layout(fresh_root, Size::MAX_CONTENT).unwrap();
        assert_eq!(layouts(&kept, root), layouts(&fresh, fresh_root));
    }

    #[test]
    fn a_kept_subtree_under_a_new_parent_keeps_it_when_the_old_one_goes() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let (old_root, cells) = fractional_row(&mut taffy);
        taffy.compute_layout(old_root, Size::MAX_CONTENT).unwrap();
        // A new frame's parent adopts the cells, then last frame's goes.
        let new_root = taffy.new_with_children(row_style(), &cells).unwrap();
        taffy.remove(old_root).unwrap();
        assert!(!taffy.contains(old_root));
        assert_eq!(taffy.parent(cells[0]), Some(new_root));
        taffy.compute_layout(new_root, Size::MAX_CONTENT).unwrap();

        let mut fresh: TaffyTree<()> = TaffyTree::new();
        let (fresh_root, _) = fractional_row(&mut fresh);
        fresh.compute_layout(fresh_root, Size::MAX_CONTENT).unwrap();
        assert_eq!(layouts(&taffy, new_root), layouts(&fresh, fresh_root));
    }

    #[test]
    fn a_detached_copy_is_laid_out_as_its_twin() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let (root, cells) = fractional_row(&mut taffy);
        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();
        // A copy of the middle cell, built anew and not attached.
        let copy = cell(&mut taffy, 1.0);
        taffy.compute_detached_layout_with_measure(copy, cells[1], |_, _, _, _, _| Size::ZERO).unwrap();
        assert_eq!(layouts(&taffy, copy), layouts(&taffy, cells[1]));
    }

    // A column: a spacer `height` tall, then a row of three thirds.
    fn spaced_row(taffy: &mut TaffyTree<()>, height: f32) -> (NodeId, NodeId, NodeId) {
        let spacer =
            taffy.new_leaf(Style { size: Size { width: auto(), height: length(height) }, ..Default::default() }).unwrap();
        let (row, _) = fractional_row(taffy);
        let column = Style { flex_direction: FlexDirection::Column, ..Default::default() };
        let root = taffy.new_with_children(column, &[spacer, row]).unwrap();
        (root, spacer, row)
    }

    fn spacer(height: f32) -> Style {
        Style { size: Size { width: auto(), height: length(height) }, ..Default::default() }
    }

    // A column `width` wide with a row of three cells, 20 px wide or growing.
    fn resized_row(taffy: &mut TaffyTree<()>, grow: bool) -> (NodeId, NodeId) {
        let cells: Vec<NodeId> = (0..3)
            .map(|_| match grow {
                true => cell(taffy, 1.0),
                false => taffy
                    .new_leaf(Style { size: Size { width: length(20.0), height: length(10.0) }, ..Default::default() })
                    .unwrap(),
            })
            .collect();
        let row = taffy.new_with_children(Style::default(), &cells).unwrap();
        let root = taffy.new_with_children(column(100.0), &[row]).unwrap();
        (root, row)
    }

    fn column(width: f32) -> Style {
        Style {
            flex_direction: FlexDirection::Column,
            size: Size { width: length(width), height: auto() },
            ..Default::default()
        }
    }

    #[test]
    fn a_node_only_resized_changed_nothing_below_it() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let (root, row) = resized_row(&mut taffy, false);
        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();
        let drawn = taffy.layout_epoch();
        assert!(!taffy.below_changed_since(row, drawn));

        // The row stretches to the column's new width; its cells stay as they are.
        taffy.set_style(root, column(140.0)).unwrap();
        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();
        assert_eq!(taffy.layout(row).unwrap().size.width, 140.0);
        assert!(taffy.inner_changed_since(row, drawn), "its own box changed");
        assert!(!taffy.below_changed_since(row, drawn));
        assert!(taffy.below_changed_since(root, drawn), "the row changed below the root");

        // Cells that grow with it are laid out anew: that is below it.
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let (root, row) = resized_row(&mut taffy, true);
        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();
        let drawn = taffy.layout_epoch();
        taffy.set_style(root, column(140.0)).unwrap();
        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();
        assert!(taffy.below_changed_since(row, drawn));
    }

    #[test]
    fn a_subtree_that_only_moved_did_not_change_inside() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let (root, above, row) = spaced_row(&mut taffy, 10.0);
        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();
        let drawn = taffy.layout_epoch();
        assert!(!taffy.inner_changed_since(row, drawn));
        let before = layouts(&taffy, row);

        // What is above it grows by whole pixels: the row moves as it is.
        taffy.set_style(above, spacer(24.0)).unwrap();
        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();
        assert!(!taffy.inner_changed_since(row, drawn));
        assert!(taffy.inner_changed_since(root, drawn), "the row moved inside the root");
        let moved = layouts(&taffy, row);
        assert_eq!(moved[0].location.y, before[0].location.y + 14.0);
        assert_eq!(moved[1..], before[1..]);

        // By a fraction: what is inside the row rounds differently, so it changed.
        let drawn = taffy.layout_epoch();
        taffy.set_style(above, spacer(24.5)).unwrap();
        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();
        assert_ne!(layouts(&taffy, row)[1..], moved[1..]);
        assert!(taffy.inner_changed_since(row, drawn));
    }

    // A column: a spacer, then boxes of `heights`, each with a row of thirds in it.
    fn stack(taffy: &mut TaffyTree<()>, above: f32, heights: &[f32]) -> (NodeId, NodeId) {
        let above = taffy.new_leaf(spacer(above)).unwrap();
        let mut children = vec![above];
        for height in heights {
            let (row, _) = fractional_row(taffy);
            let boxed = Style {
                size: Size { width: auto(), height: length(*height) },
                padding: length(0.25),
                flex_shrink: 0.0,
                ..Default::default()
            };
            children.push(taffy.new_with_children(boxed, &[row]).unwrap());
        }
        let column = Style { flex_direction: FlexDirection::Column, ..Default::default() };
        (taffy.new_with_children(column, &children).unwrap(), above)
    }

    #[test]
    fn what_moved_by_whole_pixels_rounds_as_rounding_everything_does() {
        // Edges at thirds, at halves, just under a half, and whole.
        let heights = [7.3, 20.5, 10.49, 33.34, 12.0, 0.5, 19.999, 8.25];
        for (from, to) in [(10.0, 24.0), (24.0, 3.0), (3.0, 300.0), (300.0, 2.0), (2.0, 2.5), (2.5, 9.5)] {
            let mut kept: TaffyTree<()> = TaffyTree::new();
            let (root, above) = stack(&mut kept, from, &heights);
            kept.compute_layout(root, Size::MAX_CONTENT).unwrap();
            kept.set_style(above, spacer(to)).unwrap();
            kept.compute_layout(root, Size::MAX_CONTENT).unwrap();

            let mut fresh: TaffyTree<()> = TaffyTree::new();
            let (fresh_root, _) = stack(&mut fresh, to, &heights);
            fresh.compute_layout(fresh_root, Size::MAX_CONTENT).unwrap();
            assert_eq!(layouts(&kept, root), layouts(&fresh, fresh_root), "from {from} to {to}");
        }
    }

    #[test]
    fn a_subtree_laid_out_again_changed_inside() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let (root, _, row) = spaced_row(&mut taffy, 10.0);
        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();
        let drawn = taffy.layout_epoch();
        // A cell of the row changes: the row's algorithm runs again.
        let cell = taffy.children(row).unwrap()[0];
        taffy.set_style(cell, Style { flex_grow: 3.0, flex_basis: length(0.0), ..Default::default() }).unwrap();
        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();
        assert!(taffy.inner_changed_since(row, drawn));
        // A node no longer in the tree is not what was drawn.
        taffy.remove(cell).unwrap();
        assert!(taffy.inner_changed_since(cell, taffy.layout_epoch()));
    }

    #[test]
    fn a_subtree_laid_out_again_as_it_was_did_not_change_inside() {
        let mut taffy: TaffyTree<()> = TaffyTree::new();
        let (root, above, row) = spaced_row(&mut taffy, 10.0);
        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();
        let drawn = taffy.layout_epoch();
        // The row and what is in it are marked dirty and laid out again,
        // and come out as they were.
        let cell = taffy.children(row).unwrap()[0];
        taffy.mark_dirty(taffy.children(cell).unwrap()[0]).unwrap();
        taffy.set_style(above, spacer(12.0)).unwrap();
        taffy.compute_layout(root, Size::MAX_CONTENT).unwrap();
        assert!(!taffy.inner_changed_since(row, drawn));
    }

    #[test]
    fn a_measured_leaf_asked_again_is_known() {
        let mut taffy: TaffyTree<u8> = TaffyTree::new();
        let text = taffy.new_leaf_with_context(Style::default(), 0).unwrap();
        let other = taffy.new_leaf(Style::default()).unwrap();
        let wide = |width: f32| Style { size: Size { width: length(width), height: auto() }, ..Default::default() };
        let row = taffy.new_with_children(Style::default(), &[text]).unwrap();
        let root = taffy.new_with_children(wide(80.0), &[row, other]).unwrap();
        let mut asked = Vec::new();
        let mut layout = |taffy: &mut TaffyTree<u8>| {
            taffy
                .compute_layout_with_measure(root, Size::MAX_CONTENT, |known, available, _, context, _| {
                    if context.is_some() {
                        asked.push((known, available));
                    }
                    Size { width: 30.0, height: 12.0 }
                })
                .unwrap();
            asked.last().copied()
        };
        // The layout it is made in asks it (more than once): that is not again.
        let last = layout(&mut taffy);
        let made = taffy.layout_epoch();
        assert_eq!(taffy.last_measure_inputs(text), last);
        assert_eq!(taffy.last_measure_inputs(other), None);
        assert!(!taffy.asked_since(text, 0));
        // What is beside it changes: its answers are still in the cache.
        taffy.set_style(other, wide(10.0)).unwrap();
        layout(&mut taffy);
        assert!(!taffy.asked_since(text, made));
        // It is laid out again: asked again.
        taffy.mark_dirty(text).unwrap();
        let last = layout(&mut taffy);
        assert!(taffy.asked_since(text, made));
        assert!(!taffy.asked_since(other, made));
        assert_eq!(taffy.last_measure_inputs(text), last);
        assert!(!taffy.asked_since(text, taffy.layout_epoch()));
        taffy.remove(text).unwrap();
        assert_eq!(taffy.last_measure_inputs(text), None);
    }
}
