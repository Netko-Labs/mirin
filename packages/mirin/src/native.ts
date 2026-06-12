/**
 * FFI bindings to libmirin_core (docs/architecture.md §3).
 *
 * Loaded in the Bun Worker (commands + event handler) and, separately, in the
 * host's main thread (just `mirin_run`). Both dlopen the same dylib in the same
 * process, so the Rust statics behind these symbols are shared.
 */

import { dlopen, FFIType, ptr, CString, type Pointer } from "bun:ffi";

function nullTerminated(s: string): Uint8Array {
  return new TextEncoder().encode(s + "\0");
}

const symbols = {
  mirin_run: { args: [FFIType.ptr], returns: FFIType.i32 },
  mirin_poll_event: { args: [], returns: FFIType.ptr },
  mirin_set_rpc_endpoint: { args: [FFIType.u16, FFIType.ptr], returns: FFIType.void },
  mirin_is_ready: { args: [], returns: FFIType.i32 },
  mirin_window_create: { args: [FFIType.ptr], returns: FFIType.u32 },
  mirin_window_close: { args: [FFIType.u32], returns: FFIType.void },
  mirin_window_load_url: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
  mirin_window_set_title: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
  mirin_window_control: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
  mirin_window_set_material: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
  mirin_window_set_position: { args: [FFIType.u32, FFIType.f64, FFIType.f64], returns: FFIType.void },
  mirin_app_quit: { args: [], returns: FFIType.void },
  mirin_app_set_dock_visible: { args: [FFIType.i32], returns: FFIType.void },
  mirin_set_app_menu: { args: [FFIType.ptr], returns: FFIType.void },
  mirin_popup_menu: { args: [FFIType.ptr], returns: FFIType.void },
  mirin_tray_create: { args: [FFIType.ptr], returns: FFIType.void },
  mirin_tray_destroy: { args: [FFIType.u32], returns: FFIType.void },
  mirin_shortcut_register: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  mirin_shortcut_unregister: { args: [FFIType.u32], returns: FFIType.void },
  mirin_clipboard_read_text: { args: [], returns: FFIType.ptr },
  mirin_clipboard_write_text: { args: [FFIType.ptr], returns: FFIType.void },
  mirin_dialog_show: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

export type EventListener = (event: string) => void;

export class Core {
  #lib: ReturnType<typeof dlopen<typeof symbols>>;
  #polling = false;

  constructor(libraryPath: string) {
    this.#lib = dlopen(libraryPath, symbols);
  }

  /** Blocks: runs CEF's message loop until quit. Call on the process main thread. */
  run(configJson: string): number {
    const buf = nullTerminated(configJson);
    return this.#lib.symbols.mirin_run(ptr(buf));
  }

  /**
   * Drain native events on an interval and dispatch them. We poll because the
   * host's main thread is blocked in `mirin_run`, so a bun:ffi callback invoked
   * from it never reaches this Worker's loop (see engine::poll_event).
   */
  onEvent(listener: EventListener): void {
    if (this.#polling) return;
    this.#polling = true;
    const drain = () => {
      for (;;) {
        const p = this.#lib.symbols.mirin_poll_event() as Pointer | null;
        if (!p) break;
        listener(new CString(p).toString());
      }
    };
    setInterval(drain, 8);
  }

  setRpcEndpoint(port: number, token: string): void {
    const buf = nullTerminated(token);
    this.#lib.symbols.mirin_set_rpc_endpoint(port, ptr(buf));
  }

  isReady(): boolean {
    return this.#lib.symbols.mirin_is_ready() === 1;
  }

  windowCreate(optsJson: string): number {
    const buf = nullTerminated(optsJson);
    return this.#lib.symbols.mirin_window_create(ptr(buf));
  }

  windowClose(id: number): void {
    this.#lib.symbols.mirin_window_close(id);
  }

  windowLoadUrl(id: number, url: string): void {
    const buf = nullTerminated(url);
    this.#lib.symbols.mirin_window_load_url(id, ptr(buf));
  }

  windowSetTitle(id: number, title: string): void {
    const buf = nullTerminated(title);
    this.#lib.symbols.mirin_window_set_title(id, ptr(buf));
  }

  windowControl(id: number, verb: string): void {
    const buf = nullTerminated(verb);
    this.#lib.symbols.mirin_window_control(id, ptr(buf));
  }

  windowSetMaterial(id: number, specJson: string): void {
    const buf = nullTerminated(specJson);
    this.#lib.symbols.mirin_window_set_material(id, ptr(buf));
  }

  windowSetPosition(id: number, x: number, y: number): void {
    this.#lib.symbols.mirin_window_set_position(id, x, y);
  }

  quit(): void {
    this.#lib.symbols.mirin_app_quit();
  }

  appSetDockVisible(visible: boolean): void {
    this.#lib.symbols.mirin_app_set_dock_visible(visible ? 1 : 0);
  }

  setAppMenu(templateJson: string): void {
    const buf = nullTerminated(templateJson);
    this.#lib.symbols.mirin_set_app_menu(ptr(buf));
  }

  popupMenu(templateJson: string): void {
    const buf = nullTerminated(templateJson);
    this.#lib.symbols.mirin_popup_menu(ptr(buf));
  }

  trayCreate(specJson: string): void {
    const buf = nullTerminated(specJson);
    this.#lib.symbols.mirin_tray_create(ptr(buf));
  }

  trayDestroy(id: number): void {
    this.#lib.symbols.mirin_tray_destroy(id);
  }

  shortcutRegister(id: number, accelerator: string): boolean {
    const buf = nullTerminated(accelerator);
    return this.#lib.symbols.mirin_shortcut_register(id, ptr(buf)) === 1;
  }

  shortcutUnregister(id: number): void {
    this.#lib.symbols.mirin_shortcut_unregister(id);
  }

  clipboardReadText(): string {
    const p = this.#lib.symbols.mirin_clipboard_read_text() as Pointer | null;
    return p ? new CString(p).toString() : "";
  }

  clipboardWriteText(text: string): void {
    const buf = nullTerminated(text);
    this.#lib.symbols.mirin_clipboard_write_text(ptr(buf));
  }

  dialogShow(specJson: string): void {
    const buf = nullTerminated(specJson);
    this.#lib.symbols.mirin_dialog_show(ptr(buf));
  }
}
