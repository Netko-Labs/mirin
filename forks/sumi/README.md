# sumi

sumi (墨, the ink that goes on washi) is the engine mirin Metal draws with:
a retained, GPU-drawn UI engine for one client, Metal's host
(`crates/mirin-metal`). Its users are the patch protocol and
`@mirinjs/metal`, not Rust app authors, so its API changes whenever the host
needs it to. `docs/metal/engine.md` has its direction and what each step
measured.

**The code derives from Zed's GPUI and is modified.** It was forked from the
GPUI crates of the zed repository (Zed Industries) at commit `703b5ac3`
(2026-11-14). Every crate keeps Zed's `Apache-2.0` license: `LICENSE-APACHE`
here is Zed's, each crate links to it, and mirin's changes are under the
same terms. `MIRIN.md` lists what changed up to the fork point; the git
history has what changed since.

## Crates

| Crate | Was | What it is |
| --- | --- | --- |
| `sumi` | `gpui` | The core: elements, styles, layout (taffy), text, the scene, windows, focus and key dispatch. No platform code. |
| `sumi-platform` | `gpui_platform` | Picks the platform crate for the target. |
| `sumi-linux` | `gpui_linux` | Wayland and X11. Dashi's own protocols are its `dashi` module, behind the `dashi` feature. |
| `sumi-wgpu` | `gpui_wgpu` | The wgpu renderer (Vulkan, GL when there is none) and the cosmic-text text system, for Linux. |
| `sumi-macos`, `sumi-apple` | `gpui_macos`, `gpui_apple` | macOS, and the Metal renderer and CoreText it draws with. |
| `sumi-windows` | `gpui_windows` | Windows (DirectX, DirectWrite). |
| `sumi-macros` | `gpui_macros` | The derive and attribute macros. |
| `sumi-util`, `sumi-shared-string` | `gpui_util`, `gpui_shared_string` | Small helpers the crates share. |
| `collections`, `refineable` (with `derive_refineable`), `sum_tree`, `scheduler` | the same | Zed's general crates, under their own names. |

Not here, by decision: iOS, the web, `http_client`, `bench_metrics`,
`ztracing`, the inspector, hot reload and screen capture.

## Building and testing

sumi is built through its one client. The crates are a cargo workspace of
their own (`Cargo.toml` here holds their shared dependencies and lints), but
`crates/mirin-metal` is what pins their versions (its `Cargo.lock`), repeats
the workspace's `[patch.crates-io]` entries and adds mirin's forks of taffy,
wgpu-hal, gpu-allocator and AccessKit:

```sh
cd crates/mirin-metal
cargo build --release --bin mirin-metal-host
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked                        # with Dashi's protocols
cargo test --locked --no-default-features  # for a plain Wayland or X11 desktop
```

Its tests are the engine's tests: they lay out and draw through sumi's test
platform (`render/`, `retain/gpui_tests.rs`, `retain/scene_tests.rs`). An
engine change also passes the gates, which compare layouts and drawings
with a host from before it:

```sh
cd packages/mirin-metal-ui
bun bench/gates.ts <host> --reference=<host before the change>
```

and anything that touches the frame is measured against the budgets in
`docs/metal/engine.md`, section 6. Format the engine with `cargo fmt --all`
from this directory. The unit tests inside these crates were written
against Zed's whole workspace and are not run from here.

## Picking from Zed

About monthly, read Zed's log for the crates sumi came from
(`git log 703b5ac3.. -- crates/gpui crates/gpui_linux …` in a zed checkout)
and take what fixes a bug Metal can hit or follows a platform change (a new
macOS, a Windows API, a Wayland protocol). Most of the value is in the
platform crates, which stay close to Zed's for that reason.

1. Apply the commit's diff by hand, with the paths mapped (`crates/gpui` is
   `crates/sumi`, `gpui::` is `sumi::`): `git format-patch -1 <commit>` in
   the zed checkout, then `git apply --directory=forks/sumi -p1` with the
   names rewritten, or by reading it.
2. Leave out what touches code sumi removed.
3. Build, run the tests and the gates, and measure if it touches the frame.
4. Add a row to `PICKS.md`: the Zed commit, what it fixes, where it landed.

The `forks-upstream-next` branch holds Zed's crates as they were imported,
frozen at `703b5ac3`; a diff against it shows what is sumi's.
