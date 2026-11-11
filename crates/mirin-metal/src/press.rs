//! Which view a press goes to: the innermost one that handles it. A left
//! press fires `onPress` on the deepest view under the pointer that has one,
//! and only there; `onPointer` captures for the deepest view with it; a
//! right press fires the deepest `onContextMenu`. Ancestors with the same
//! handler stay quiet, as on the web when every handled press calls
//! `stopPropagation`, and so do views a sibling is drawn over (an event
//! block over a time slot). Hover is not claimed: every view under the
//! pointer is hovered, as in CSS.
//!
//! GPUI runs mouse listeners in reverse paint order (children paint after
//! their parents, later siblings over earlier ones), so the first view to
//! claim a press during its dispatch is the innermost, topmost one. The
//! claims reset in the capture phase of each press (`pointer.rs`), before any
//! view's listener runs. Views behind an `occlude` view never hear it.

/// The views that took the current presses, by handler.
#[derive(Debug, Default)]
pub(crate) struct Claims {
    /// The `onPress` view the current left press belongs to.
    press: Option<String>,
    /// The `onPointer` view capturing the current left press.
    pointer: Option<String>,
    /// The `onContextMenu` view the current right press belongs to.
    menu: Option<String>,
}

impl Claims {
    /// A left press begins: nobody has it yet.
    pub(crate) fn begin_left(&mut self) {
        self.press = None;
        self.pointer = None;
    }

    /// A right press begins: nobody has it yet.
    pub(crate) fn begin_right(&mut self) {
        self.menu = None;
    }

    /// An `onPress` view heard the left button go down over it. True when the
    /// press is its own: it is the first (innermost) to ask, or asked before.
    pub(crate) fn claim_press(&mut self, id: &str) -> bool {
        claim(&mut self.press, id)
    }

    /// Whether the current left press belongs to `id` (its click may fire).
    pub(crate) fn owns_press(&self, id: &str) -> bool {
        self.press.as_deref() == Some(id)
    }

    /// An `onPointer` view heard the left button go down over it. True when
    /// it is the one to capture the press.
    pub(crate) fn claim_pointer(&mut self, id: &str) -> bool {
        claim(&mut self.pointer, id)
    }

    /// An `onContextMenu` view heard the right button go down over it. True
    /// when the menu is its to open.
    pub(crate) fn claim_menu(&mut self, id: &str) -> bool {
        claim(&mut self.menu, id)
    }
}

fn claim(slot: &mut Option<String>, id: &str) -> bool {
    match slot {
        Some(owner) => owner == id,
        None => {
            *slot = Some(id.to_string());
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Claims;

    #[test]
    fn the_innermost_pressable_takes_the_press() {
        let mut claims = Claims::default();
        claims.begin_left();
        // Deepest first: the checkbox, then the row it sits in.
        assert!(claims.claim_press("checkbox"));
        assert!(!claims.claim_press("row"));
        assert!(claims.owns_press("checkbox"));
        assert!(!claims.owns_press("row"));
    }

    #[test]
    fn each_press_starts_unclaimed() {
        let mut claims = Claims::default();
        claims.begin_left();
        assert!(claims.claim_press("checkbox"));
        // The next press lands on the row only.
        claims.begin_left();
        assert!(!claims.owns_press("checkbox"));
        assert!(claims.claim_press("row"));
        assert!(claims.owns_press("row"));
    }

    #[test]
    fn asking_again_keeps_the_claim() {
        let mut claims = Claims::default();
        claims.begin_left();
        assert!(claims.claim_press("button"));
        assert!(claims.claim_press("button"));
    }

    #[test]
    fn press_pointer_and_menu_are_claimed_apart() {
        let mut claims = Claims::default();
        claims.begin_left();
        claims.begin_right();
        // A slider (onPointer) inside a pressable card: each takes its own.
        assert!(claims.claim_pointer("slider"));
        assert!(claims.claim_press("card"));
        assert!(!claims.claim_pointer("panel"));
        // Right presses are separate: the icon's menu, not the bar's.
        assert!(claims.claim_menu("icon"));
        assert!(!claims.claim_menu("bar"));
        // A new left press leaves the menu's claim alone, and the reverse.
        claims.begin_left();
        assert!(!claims.claim_menu("bar"));
        claims.begin_right();
        assert!(claims.claim_menu("bar"));
        assert!(!claims.owns_press("card"));
    }
}
