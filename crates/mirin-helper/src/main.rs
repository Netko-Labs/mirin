//! mirin-helper — the CEF subprocess binary (renderer / GPU / plugin / alerts).
//! The dev-bundle script copies it into the five per-type Helper .app shells
//! (docs/architecture.md §1). Adapted from cef-rs's cefsimple_helper.
//!
//! Renderer role: inject the `window.mirin` RPC bootstrap at V8-context creation
//! (docs/architecture.md §4), using the rpc port/token/window-id passed per
//! browser via `extra_info` from the browser process.

use cef::{args::Args, *};
use std::cell::RefCell;
use std::collections::HashMap;

/// JS bootstrap defining `window.mirin` (the transport `mirin/client` expects).
/// `__PORT__` / `__TOKEN__` / `__WEBVIEW__` are substituted per browser.
const BOOTSTRAP: &str = r#"(function(){
  if (window.mirin) return;
  var PORT=__PORT__, TOKEN="__TOKEN__", WEBVIEW=__WEBVIEW__;
  var ws, ready=false, queue=[], nextId=1, pending={}, listeners={};
  function connect(){
    var url="ws://127.0.0.1:"+PORT+"/?token="+encodeURIComponent(TOKEN)+"&webview="+WEBVIEW;
    try { ws=new WebSocket(url); }
    catch(e){ console.error("[mirin] rpc connect failed: "+e); return; }
    ws.onopen=function(){ ready=true; for(var i=0;i<queue.length;i++) ws.send(queue[i]); queue=[]; };
    ws.onmessage=function(ev){
      var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
      if(m.kind==="response"){ var p=pending[m.id]; if(p){ delete pending[m.id]; m.ok?p.resolve(m.result):p.reject(new Error(m.error||"rpc error")); } }
      else if(m.kind==="event"){ var ls=listeners[m.method]||[]; for(var j=0;j<ls.length;j++){ try{ ls[j](m.payload); }catch(e){} } }
    };
    ws.onclose=function(){ ready=false; setTimeout(connect,500); };
    ws.onerror=function(){ try{ ws.close(); }catch(e){} };
  }
  function send(o){ var s=JSON.stringify(o); if(ready) ws.send(s); else queue.push(s); }
  window.mirin={
    webviewId: WEBVIEW,
    call:function(method,input){ var id=nextId++; return new Promise(function(res,rej){ pending[id]={resolve:res,reject:rej}; send({kind:"request",id:id,method:method,input:input}); }); },
    onEvent:function(method,listener){ (listeners[method]=listeners[method]||[]).push(listener); return function(){ var ls=listeners[method]||[]; var i=ls.indexOf(listener); if(i>=0) ls.splice(i,1); }; }
  };
  connect();
})();"#;

#[derive(Clone, Default)]
struct RpcEndpoint {
    port: i32,
    token: String,
    webview: i32,
}

thread_local! {
    /// Per-browser RPC endpoint captured in on_browser_created, consumed in
    /// on_context_created (both run on the renderer thread).
    static ENDPOINTS: RefCell<HashMap<i32, RpcEndpoint>> = RefCell::new(HashMap::new());
}

fn main() {
    let args = Args::new();

    #[cfg(all(target_os = "macos", feature = "sandbox"))]
    let _sandbox = {
        let mut sandbox = cef::sandbox::Sandbox::new();
        sandbox.initialize(args.as_main_args());
        sandbox
    };

    #[cfg(target_os = "macos")]
    let _loader = {
        let loader = library_loader::LibraryLoader::new(&std::env::current_exe().unwrap(), true);
        assert!(loader.load());
        loader
    };

    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    let mut app = MirinHelperApp::new();
    execute_process(
        Some(args.as_main_args()),
        Some(&mut app),
        std::ptr::null_mut(),
    );
}

wrap_app! {
    struct MirinHelperApp {}

    impl App {
        // Must match mirin-core's scheme::register_app_scheme exactly: every
        // process has to register app:// with identical options or the renderer
        // won't treat it as a standard/secure origin.
        fn on_register_custom_schemes(&self, registrar: Option<&mut SchemeRegistrar>) {
            if let Some(reg) = registrar {
                // Must match mirin-core scheme::app_scheme_options (NOT secure,
                // so the RPC ws://127.0.0.1 isn't blocked as mixed content).
                let opts = (SchemeOptions::STANDARD.get_raw()
                    | SchemeOptions::CORS_ENABLED.get_raw()
                    | SchemeOptions::FETCH_ENABLED.get_raw()) as i32;
                reg.add_custom_scheme(Some(&CefString::from("app")), opts);
            }
        }

        fn render_process_handler(&self) -> Option<RenderProcessHandler> {
            Some(MirinRenderProcessHandler::new())
        }
    }
}

wrap_render_process_handler! {
    struct MirinRenderProcessHandler {}

    impl RenderProcessHandler {
        fn on_browser_created(
            &self,
            browser: Option<&mut Browser>,
            extra_info: Option<&mut DictionaryValue>,
        ) {
            let (Some(browser), Some(dict)) = (browser, extra_info) else { return };
            let endpoint = RpcEndpoint {
                port: dict.int(Some(&CefString::from("rpcPort"))),
                token: CefString::from(&dict.string(Some(&CefString::from("rpcToken")))).to_string(),
                webview: dict.int(Some(&CefString::from("windowId"))),
            };
            ENDPOINTS.with(|e| e.borrow_mut().insert(browser.identifier(), endpoint));
        }

        fn on_context_created(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _context: Option<&mut V8Context>,
        ) {
            let (Some(browser), Some(frame)) = (browser, frame) else { return };
            let endpoint = ENDPOINTS.with(|e| e.borrow().get(&browser.identifier()).cloned());
            let Some(endpoint) = endpoint else { return };

            let script = BOOTSTRAP
                .replace("__PORT__", &endpoint.port.to_string())
                .replace("__TOKEN__", &endpoint.token)
                .replace("__WEBVIEW__", &endpoint.webview.to_string());

            frame.execute_java_script(
                Some(&CefString::from(script.as_str())),
                Some(&CefString::from("mirin://preload")),
                0,
            );
        }
    }
}
