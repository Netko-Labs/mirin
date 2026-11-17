"""A text test font: U+1F610 NEUTRAL FACE as an outline and a space, cut
from Noto Sans Symbols, with the "m" of `MirinTestStatic-Regular.ttf` (cut
from Noto Sans) copied in, so sumi takes it into a fallback chain (a chain
keeps only faces with an "m"). Both OFL 1.1. A text font that has an emoji
with emoji presentation, ahead of the colour font (`tests/emoji.rs`)."""
import sys
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options
from fontTools.varLib import instancer

src, static, out = sys.argv[1], sys.argv[2], sys.argv[3]
font = instancer.instantiateVariableFont(TTFont(src), {"wght": 400})
options = Options()
options.layout_features = []
options.name_IDs = [0, 1, 2, 3, 4, 6, 13, 14]
options.notdef_outline = True
options.hinting = False
subsetter = Subsetter(options)
subsetter.populate(unicodes=[0x20, 0x1F610])
subsetter.subset(font)
for table in ("STAT", "fvar", "gvar", "avar", "HVAR", "MVAR", "vhea", "vmtx", "VVAR"):
    if table in font:
        del font[table]
# The "m": its outline and advance, copied from the static font.
m = TTFont(static)
source = m.getBestCmap()[0x6D]
glyf, hmtx = font["glyf"], font["hmtx"]  # read before the glyph order grows
order = font.getGlyphOrder() + ["m"]
font.setGlyphOrder(order)
glyf.glyphOrder = order
glyf["m"] = m["glyf"][source]
hmtx["m"] = m["hmtx"][source]
for table in font["cmap"].tables:
    if table.isUnicode():
        table.cmap[0x6D] = "m"
name = font["name"]
name.names = [n for n in name.names if n.nameID not in (16, 17, 21, 22, 25)]
for record in name.names:
    value = {1: "Mirin Test Symbols", 2: "Regular", 3: "MirinTestSymbols;mirin", 4: "Mirin Test Symbols", 6: "MirinTestSymbols-Regular"}.get(record.nameID)
    if value:
        record.string = value
font.save(f"{out}/MirinTestSymbols-Regular.ttf")
