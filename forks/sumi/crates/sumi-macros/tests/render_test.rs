#[test]
fn test_derive_render() {
    use sumi_macros::Render;

    #[derive(Render)]
    struct _Element;
}
