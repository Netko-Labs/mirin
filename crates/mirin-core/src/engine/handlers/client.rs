use cef::*;
use std::sync::{Arc, Mutex};

use super::context_menu::MirinContextMenuHandler;
use super::display::MirinDisplayHandler;
use super::drag::MirinDragHandler;
use super::lifespan::MirinLifeSpanHandler;
use super::MirinHandler;
use crate::engine::osr;

wrap_client! {
    pub struct MirinHandlerClient {
        inner: Arc<Mutex<MirinHandler>>,
    }

    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(MirinLifeSpanHandler::new(self.inner.clone()))
        }
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(MirinDisplayHandler::new())
        }
        fn drag_handler(&self) -> Option<DragHandler> {
            Some(MirinDragHandler::new(self.inner.clone()))
        }
        fn context_menu_handler(&self) -> Option<ContextMenuHandler> {
            Some(MirinContextMenuHandler::new())
        }
        fn render_handler(&self) -> Option<RenderHandler> {
            Some(osr::render_handler())
        }
    }
}
