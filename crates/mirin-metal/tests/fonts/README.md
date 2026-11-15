# Test fonts

Two fonts for `tests/text_weight.rs`, each a few glyphs cut from Noto Sans
(`NotoSans[wght].ttf`, The Noto Project Authors, SIL Open Font License 1.1:
`OFL.txt`). They are modified versions under the same license, renamed so
they are never mistaken for Noto Sans:

- `MirinTestStatic-Regular.ttf`, family "Mirin Test Static": Regular alone,
  with "m" alone.
- `MirinTestVariable.ttf`, family "Mirin Test Variable": a weight axis from
  400 to 700 with its default at 700, with "m" and "w". A variable face whose
  default weight is not Regular, as Noto Sans CJK's (Thin) is not.

`make.py` made them, with fontTools:
`python make.py '/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf' .`

`MirinTestEmoji.ttf`, family "Mirin Test Emoji", is for `tests/emoji.rs`:
one glyph, U+1F600, cut from Noto Color Emoji's COLRv1 build
(`Noto-COLRv1.ttf`, Google, SIL Open Font License 1.1, the same text as
`OFL.txt` under its own notice, "Copyright 2022 Google Inc.", which the
font's name table keeps). Its PostScript name is still "NotoColorEmoji":
that is how sumi knows an emoji font. `make_emoji.py` made it:
`python make_emoji.py /usr/share/fonts/google-noto-color-emoji-fonts/Noto-COLRv1.ttf .`
