use cef::*;

use crate::engine::state;

const MENU_ID_INSPECT: i32 = 26600;

wrap_context_menu_handler! {
    pub struct MirinContextMenuHandler {}

    impl ContextMenuHandler {
        fn on_before_context_menu(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _params: Option<&mut ContextMenuParams>,
            model: Option<&mut MenuModel>,
        ) {
            if !state::is_dev() {
                return;
            }
            if let Some(model) = model {
                model.add_separator();
                model.add_item(MENU_ID_INSPECT, Some(&CefString::from("Inspect Element")));
            }
        }

        fn on_context_menu_command(
            &self,
            browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            params: Option<&mut ContextMenuParams>,
            command_id: i32,
            _event_flags: EventFlags,
        ) -> i32 {
            if command_id != MENU_ID_INSPECT {
                return 0;
            }
            if let Some(host) = browser.and_then(|b| b.host()) {
                let at = params.map(|p| Point {
                    x: p.xcoord(),
                    y: p.ycoord(),
                });
                host.show_dev_tools(None, None, None, at.as_ref());
            }
            1
        }
    }
}
