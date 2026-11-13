//! A scroll view's content as a group of the layout map: it moves as one
//! with every scroll, so what is drawn in it is kept by where it sits in the
//! content, and a scroll changes one place (the content's) instead of every
//! node's.

use gpui::{canvas, prelude::*, px, AnyElement};

use crate::tree::ViewProps;
use crate::window::RootView;

/// The group of the content of scroll view `id`: the same for the same view
/// every time, and never a retained subtree's (those count up from one).
pub(crate) fn scroll_group(id: &str) -> u64 {
    // FNV-1a.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in id.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash | 1 << 63
}

/// For a view that scrolls: its content's group, and an element to put
/// first among its children. It is prepainted before them, where the
/// content's top left is now (the view's corner, scrolled), which is where
/// the group is; what the children draw is then placed in it.
pub(crate) fn scroll_frame(props: &ViewProps, view: &RootView) -> Option<(u64, AnyElement)> {
    let id = props.id.as_deref()?;
    if !(props.scroll || props.scroll_x) {
        return None;
    }
    let group = scroll_group(id);
    let (layout, around) = (view.layout.clone(), view.group);
    let marker = canvas(
        move |bounds, _window, _cx| layout.touch_group(group, around, bounds.origin, true),
        |_, (), _, _| {},
    )
    .absolute()
    .top(px(0.0))
    .left(px(0.0))
    .size(px(0.0))
    .into_any_element();
    Some((group, marker))
}
