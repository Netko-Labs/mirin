//! The tree kept across updates (`published.rs`) against one made from
//! nothing, update after update: what a screen reader has after hearing only
//! the changed nodes is what it would have been handed whole, and where it
//! finds each node is where the element was painted. And what the
//! application is called.

mod changes;
mod frames;
mod random;
mod screen;

use super::app_name;

#[test]
fn the_driver_names_the_app() {
    assert_eq!(
        app_name(Some("Dashi"), "Launcher").as_deref(),
        Some("Dashi")
    );
    assert_eq!(
        app_name(Some(" Text Editor "), "notes.md").as_deref(),
        Some("Text Editor")
    );
}

#[test]
fn else_the_window_title_but_never_the_host() {
    assert_eq!(app_name(None, "Weather").as_deref(), Some("Weather"));
    assert_eq!(app_name(Some(""), "Weather").as_deref(), Some("Weather"));
    assert_eq!(app_name(None, "mirin metal"), None);
    assert_eq!(app_name(None, "mirin metal (alpha)"), None);
    assert_eq!(app_name(None, "  "), None);
}
