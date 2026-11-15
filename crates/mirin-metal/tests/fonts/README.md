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
