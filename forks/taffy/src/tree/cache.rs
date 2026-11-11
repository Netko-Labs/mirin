//! A cache for storing the results of layout computation
use crate::geometry::Size;
use crate::style::AvailableSpace;
use crate::tree::{LayoutOutput, RunMode};

#[cfg(test)]
std::thread_local! {
    /// mirin: how often `get_stretched` was asked, for tests.
    pub(crate) static STRETCHED: core::cell::Cell<usize> = const { core::cell::Cell::new(0) };
}

/// The number of cache entries for each node in the tree
// mirin: two more (slots 9 and 10), for one known dimension under a definite constraint on the other.
const CACHE_SIZE: usize = 11;

/// Cached intermediate layout results
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize))]
pub(crate) struct CacheEntry<T> {
    /// The initial cached size of the node itself
    known_dimensions: Size<Option<f32>>,
    /// The initial cached size of the parent's node
    available_space: Size<AvailableSpace>,
    /// The cached size and baselines of the item
    content: T,
    /// mirin: the result holds at another width above this
    /// (`Cache::get_stretched`).
    stretch: Option<f32>,
}

/// A cache for caching the results of a sizing a Grid Item or Flexbox Item
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize))]
pub struct Cache {
    /// The cache entry for the node's final layout
    final_layout_entry: Option<CacheEntry<LayoutOutput>>,
    /// The cache entries for the node's preliminary size measurements
    measure_entries: [Option<CacheEntry<Size<f32>>>; CACHE_SIZE],
    /// Tracks if all cache entries are empty
    is_empty: bool,
}

impl Default for Cache {
    fn default() -> Self {
        Self::new()
    }
}

impl Cache {
    /// Create a new empty cache
    pub const fn new() -> Self {
        Self { final_layout_entry: None, measure_entries: [None; CACHE_SIZE], is_empty: true }
    }

    /// Return the cache slot to cache the current computed result in
    ///
    /// ## Caching Strategy
    ///
    /// We need multiple cache slots, because a node's size is often queried by it's parent multiple times in the course of the layout
    /// process, and we don't want later results to clobber earlier ones.
    ///
    /// The two variables that we care about when determining cache slot are:
    ///
    ///   - How many "known_dimensions" are set. In the worst case, a node may be called first with neither dimension known, then with one
    ///     dimension known (either width of height - which doesn't matter for our purposes here), and then with both dimensions known.
    ///   - Whether unknown dimensions are being sized under a min-content or a max-content available space constraint (definite available space
    ///     shares a cache slot with max-content because a node will generally be sized under one or the other but not both).
    ///
    /// ## Cache slots:
    ///
    /// - Slot 0: Both known_dimensions were set
    /// - Slots 1-4: 1 of 2 known_dimensions were set and:
    ///   - Slot 1: width but not height known_dimension was set and the other dimension was either a MaxContent or Definite available space constraintraint
    ///   - Slot 2: width but not height known_dimension was set and the other dimension was a MinContent constraint
    ///   - Slot 3: height but not width known_dimension was set and the other dimension was either a MaxContent or Definite available space constraintable space constraint
    ///   - Slot 4: height but not width known_dimension was set and the other dimension was a MinContent constraint
    /// - Slots 5-8: Neither known_dimensions were set and:
    ///   - Slot 5: x-axis available space is MaxContent or Definite and y-axis available space is MaxContent or Definite
    ///   - Slot 6: x-axis available space is MaxContent or Definite and y-axis available space is MinContent
    ///   - Slot 7: x-axis available space is MinContent and y-axis available space is MaxContent or Definite
    ///   - Slot 8: x-axis available space is MinContent and y-axis available space is MinContent
    #[inline]
    fn compute_cache_slot(known_dimensions: Size<Option<f32>>, available_space: Size<AvailableSpace>) -> usize {
        use AvailableSpace::{Definite, MaxContent, MinContent};

        let has_known_width = known_dimensions.width.is_some();
        let has_known_height = known_dimensions.height.is_some();

        // Slot 0: Both known_dimensions were set
        if has_known_width && has_known_height {
            return 0;
        }

        // Slot 1: width but not height known_dimension was set and the other dimension was either a MaxContent or Definite available space constraint
        // Slot 2: width but not height known_dimension was set and the other dimension was a MinContent constraint
        // mirin: slot 9 when that was a Definite constraint (`CACHE_SIZE`).
        if has_known_width && !has_known_height {
            return match available_space.height {
                MaxContent => 1,
                MinContent => 2,
                Definite(_) => 9,
            };
        }

        // Slot 3: height but not width known_dimension was set and the other dimension was either a MaxContent or Definite available space constraint
        // Slot 4: height but not width known_dimension was set and the other dimension was a MinContent constraint
        // mirin: slot 10 when that was a Definite constraint (`CACHE_SIZE`).
        if has_known_height && !has_known_width {
            return match available_space.width {
                MaxContent => 3,
                MinContent => 4,
                Definite(_) => 10,
            };
        }

        // Slots 5-8: Neither known_dimensions were set and:
        match (available_space.width, available_space.height) {
            // Slot 5: x-axis available space is MaxContent or Definite and y-axis available space is MaxContent or Definite
            (MaxContent | Definite(_), MaxContent | Definite(_)) => 5,
            // Slot 6: x-axis available space is MaxContent or Definite and y-axis available space is MinContent
            (MaxContent | Definite(_), MinContent) => 6,
            // Slot 7: x-axis available space is MinContent and y-axis available space is MaxContent or Definite
            (MinContent, MaxContent | Definite(_)) => 7,
            // Slot 8: x-axis available space is MinContent and y-axis available space is MinContent
            (MinContent, MinContent) => 8,
        }
    }

    /// Try to retrieve a cached result from the cache
    #[inline]
    pub fn get(
        &self,
        known_dimensions: Size<Option<f32>>,
        available_space: Size<AvailableSpace>,
        run_mode: RunMode,
    ) -> Option<LayoutOutput> {
        match run_mode {
            RunMode::PerformLayout => self
                .final_layout_entry
                .filter(|entry| {
                    let cached_size = entry.content.size;
                    (known_dimensions.width == entry.known_dimensions.width
                        || known_dimensions.width == Some(cached_size.width))
                        && (known_dimensions.height == entry.known_dimensions.height
                            || known_dimensions.height == Some(cached_size.height))
                        && (known_dimensions.width.is_some()
                            || entry.available_space.width.is_roughly_equal(available_space.width))
                        && (known_dimensions.height.is_some()
                            || entry.available_space.height.is_roughly_equal(available_space.height))
                })
                .map(|e| e.content),
            RunMode::ComputeSize => {
                for entry in self.measure_entries.iter().flatten() {
                    let cached_size = entry.content;

                    if (known_dimensions.width == entry.known_dimensions.width
                        || known_dimensions.width == Some(cached_size.width))
                        && (known_dimensions.height == entry.known_dimensions.height
                            || known_dimensions.height == Some(cached_size.height))
                        && (known_dimensions.width.is_some()
                            || entry.available_space.width.is_roughly_equal(available_space.width))
                        && (known_dimensions.height.is_some()
                            || entry.available_space.height.is_roughly_equal(available_space.height))
                    {
                        return Some(LayoutOutput::from_outer_size(cached_size));
                    }
                }

                None
            }
            RunMode::PerformHiddenLayout => None,
        }
    }

    /// Store a computed size in the cache
    pub fn store(
        &mut self,
        known_dimensions: Size<Option<f32>>,
        available_space: Size<AvailableSpace>,
        run_mode: RunMode,
        layout_output: LayoutOutput,
    ) {
        self.store_stretchable(known_dimensions, available_space, run_mode, layout_output, None);
    }

    /// mirin: `store`, with the width above which the result holds at any
    /// other width (`get_stretched`), when the flexbox algorithm found one.
    pub fn store_stretchable(
        &mut self,
        known_dimensions: Size<Option<f32>>,
        available_space: Size<AvailableSpace>,
        run_mode: RunMode,
        layout_output: LayoutOutput,
        stretch: Option<f32>,
    ) {
        match run_mode {
            RunMode::PerformLayout => {
                self.is_empty = false;
                self.final_layout_entry =
                    Some(CacheEntry { known_dimensions, available_space, content: layout_output, stretch })
            }
            RunMode::ComputeSize => {
                self.is_empty = false;
                let cache_slot = Self::compute_cache_slot(known_dimensions, available_space);
                self.measure_entries[cache_slot] =
                    Some(CacheEntry { known_dimensions, available_space, content: layout_output.size, stretch });
            }
            RunMode::PerformHiddenLayout => {}
        }
    }

    /// mirin: a result for a query `get` found nothing for, from an entry
    /// for the same query at another width, where the flexbox algorithm
    /// found that width changes nothing but itself (a row whose items
    /// neither grow, shrink nor move with it: `compute_stretch_bound`):
    ///
    /// - a known width, before and now, both above the entry's bound: the
    ///   entry's result at the new width (the items' layouts as they are);
    /// - no known width, under a definite available width before and now:
    ///   the entry's result (a row then takes its content's width).
    ///
    /// The other dimension must be asked as it was.
    pub fn get_stretched(
        &self,
        known_dimensions: Size<Option<f32>>,
        available_space: Size<AvailableSpace>,
        run_mode: RunMode,
    ) -> Option<LayoutOutput> {
        /// How far above its bound a width must be: far more than `f32`
        /// loses in the sums that make the bound.
        const MARGIN: f32 = 1.0 / 64.0;
        // The width to answer with (`None`: the entry's), when the entry holds.
        let width = |entry_known: Size<Option<f32>>, entry_space: Size<AvailableSpace>, size: Size<f32>, stretch| {
            let bound: f32 = stretch?;
            let same_height = known_dimensions.height == entry_known.height
                && (known_dimensions.height.is_some() || entry_space.height.is_roughly_equal(available_space.height));
            if !same_height {
                return None;
            }
            match (entry_known.width, known_dimensions.width) {
                (Some(before), Some(now)) if before > bound + MARGIN && now > bound + MARGIN && size.width == before => {
                    Some(Some(now))
                }
                (None, None)
                    if matches!(entry_space.width, AvailableSpace::Definite(_))
                        && matches!(available_space.width, AvailableSpace::Definite(_)) =>
                {
                    Some(None)
                }
                _ => None,
            }
        };
        let output = match run_mode {
            RunMode::PerformLayout => {
                let entry = self.final_layout_entry.as_ref()?;
                let width = width(entry.known_dimensions, entry.available_space, entry.content.size, entry.stretch)?;
                let mut output = entry.content;
                output.size.width = width.unwrap_or(output.size.width);
                Some(output)
            }
            RunMode::ComputeSize => {
                let slot = Self::compute_cache_slot(known_dimensions, available_space);
                let entry = self.measure_entries[slot].as_ref()?;
                let width = width(entry.known_dimensions, entry.available_space, entry.content, entry.stretch)?;
                let size = Size { width: width.unwrap_or(entry.content.width), height: entry.content.height };
                Some(LayoutOutput::from_outer_size(size))
            }
            RunMode::PerformHiddenLayout => None,
        };
        #[cfg(test)]
        if output.is_some() {
            STRETCHED.with(|count| count.set(count.get() + 1));
        }
        output
    }

    /// Clear all cache entries and reports clear operation outcome ([`ClearState`])
    pub fn clear(&mut self) -> ClearState {
        if self.is_empty {
            return ClearState::AlreadyEmpty;
        }
        self.is_empty = true;
        self.final_layout_entry = None;
        self.measure_entries = [None; CACHE_SIZE];
        ClearState::Cleared
    }

    /// Returns true if all cache entries are None, else false
    pub fn is_empty(&self) -> bool {
        self.final_layout_entry.is_none() && !self.measure_entries.iter().any(|entry| entry.is_some())
    }
}

/// Clear operation outcome. See [`Cache::clear`]
pub enum ClearState {
    /// Cleared some values
    Cleared,
    /// Everything was already cleared
    AlreadyEmpty,
}
