use objc2::rc::Retained;
use std::cell::RefCell;
use std::collections::HashMap;

use super::view::MirinOsrView;

thread_local! {
    static OSR_VIEWS: RefCell<HashMap<u32, Retained<MirinOsrView>>> = RefCell::new(HashMap::new());
}

pub(super) fn insert(window_id: u32, view: Retained<MirinOsrView>) {
    OSR_VIEWS.with(|m| {
        m.borrow_mut().insert(window_id, view);
    });
}

pub(super) fn remove(window_id: u32) {
    OSR_VIEWS.with(|m| {
        m.borrow_mut().remove(&window_id);
    });
}

pub(super) fn get(window_id: u32) -> Option<Retained<MirinOsrView>> {
    OSR_VIEWS.with(|m| m.borrow().get(&window_id).cloned())
}

pub(super) fn with_view<R>(window_id: u32, f: impl FnOnce(&MirinOsrView) -> R) -> Option<R> {
    OSR_VIEWS.with(|m| m.borrow().get(&window_id).map(|view| f(view)))
}

pub(super) fn view_size(window_id: u32) -> Option<(i32, i32)> {
    with_view(window_id, |view| {
        let b = view.bounds();
        (b.size.width as i32, b.size.height as i32)
    })
}
