"""Two small test fonts cut from Noto Sans (OFL 1.1, no reserved name):
a static Regular with "m" alone, and a variable one with "m" and "w" (wght 400
to 700, with its default moved to 700: a face whose default is not Regular,
as Noto Sans CJK's, Thin, is not)."""
import sys
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options
from fontTools.varLib import instancer

src, out = sys.argv[1], sys.argv[2]

def cut(font, text):
    options = Options()
    options.layout_features = []
    options.name_IDs = [0, 1, 2, 3, 4, 6, 13, 14]
    options.notdef_outline = True
    options.hinting = False
    subsetter = Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)

def rename(font, family, style, postscript):
    name = font["name"]
    name.names = [n for n in name.names if n.nameID not in (16, 17, 21, 22, 25)]
    for record in name.names:
        value = {1: family, 2: style, 3: f"{postscript};mirin", 4: f"{family} {style}".replace(" Regular", ""), 6: postscript}.get(record.nameID)
        if value:
            record.string = value

static = instancer.instantiateVariableFont(TTFont(src), {"wght": 400})
cut(static, "m")
rename(static, "Mirin Test Static", "Regular", "MirinTestStatic-Regular")
static.save(f"{out}/MirinTestStatic-Regular.ttf")

variable = instancer.instantiateVariableFont(TTFont(src), {"wght": (400, 700, 700)})
cut(variable, "mw")
rename(variable, "Mirin Test Variable", "Regular", "MirinTestVariable")
variable["fvar"].instances = []
if "STAT" in variable:
    del variable["STAT"]
variable["OS/2"].usWeightClass = 700
variable.save(f"{out}/MirinTestVariable.ttf")
