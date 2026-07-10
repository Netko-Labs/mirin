use cef::*;
use std::sync::{Arc, Mutex};

use super::MirinHandler;

wrap_life_span_handler! {
    pub struct MirinLifeSpanHandler {
        inner: Arc<Mutex<MirinHandler>>,
    }

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            self.inner.lock().expect("lock").on_after_created(browser);
        }
        fn do_close(&self, browser: Option<&mut Browser>) -> i32 {
            self.inner.lock().expect("lock").do_close(browser).into()
        }
        fn on_before_close(&self, browser: Option<&mut Browser>) {
            self.inner.lock().expect("lock").on_before_close(browser);
        }
    }
}
