"""A family in two static files, Thin and Regular, cut from Noto Sans's static
files (OFL 1.1, no reserved name), with "m" and "w" (a family is usable by
name only with an "m"). Named as Noto's are: the Thin's own family (1) is
"… Thin" with the style "Regular"; the typographic family (16) and style (17)
say what it is."""
import sys
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

thin, regular, out = sys.argv[1], sys.argv[2], sys.argv[3]
FAMILY = "Mirin Test Weights"

def cut(font, text):
    options = Options()
    options.layout_features = []
    options.name_IDs = [0, 1, 2, 3, 4, 6, 13, 14, 16, 17]
    options.notdef_outline = True
    options.hinting = False
    subsetter = Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)

for src, weight, style in ((thin, 100, "Thin"), (regular, 400, "Regular")):
    font = TTFont(src)
    assert "fvar" not in font, "a static file"
    cut(font, "mw")
    own = FAMILY if style == "Regular" else f"{FAMILY} {style}"
    postscript = f"MirinTestWeights-{style}"
    name = font["name"]
    name.names = [n for n in name.names if n.nameID not in (16, 17, 21, 22, 25)]
    for record in name.names:
        value = {1: own, 2: "Regular", 3: f"{postscript};mirin", 4: own, 6: postscript}.get(record.nameID)
        if value:
            record.string = value
    if style != "Regular":
        name.setName(FAMILY, 16, 3, 1, 0x409)
        name.setName(style, 17, 3, 1, 0x409)
    assert font["OS/2"].usWeightClass == weight
    font.save(f"{out}/{postscript}.ttf")
