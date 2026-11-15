# Test images

What `src/media/image_tests.rs` hands the host as `image` nodes:

- `ok.png`, `ok.webp`: a 64 × 48 gradient (ImageMagick), in two formats the
  host decodes.
- `ok.svg`: an SVG document of the same size.
- `ok.avif`: the gradient as AVIF (ffmpeg, `libaom-av1`, one still frame),
  a format the host has no decoder for.
- `words.png`: a line of text under a picture's name.
