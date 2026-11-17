"""A one-emoji test font cut from Noto Color Emoji's COLRv1 build (OFL 1.1):
U+1F600 and U+1F610, faces painted with gradients. The family is renamed; the
PostScript name stays "NotoColorEmoji", which is how sumi knows an emoji
font."""
import sys
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

src, out = sys.argv[1], sys.argv[2]
font = TTFont(src)
options = Options()
options.layout_features = []
options.name_IDs = [0, 1, 2, 3, 4, 6, 13, 14]
options.notdef_outline = True
subsetter = Subsetter(options)
subsetter.populate(unicodes=[0x1F600, 0x1F610])
subsetter.subset(font)
for record in font["name"].names:
    value = {1: "Mirin Test Emoji", 3: "MirinTestEmoji;mirin", 4: "Mirin Test Emoji"}.get(record.nameID)
    if value:
        record.string = value
font.save(f"{out}/MirinTestEmoji.ttf")
