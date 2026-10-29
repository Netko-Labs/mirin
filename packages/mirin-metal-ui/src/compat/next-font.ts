/**
 * `next/font/google` on Metal: font loaders return Next's shape. The class is
 * empty (fonts come from the system); `style.fontFamily` names the family.
 */

interface LoadedFont {
  className: string;
  variable: string;
  style: { fontFamily: string };
}

function loader(family: string) {
  return (_options?: Record<string, unknown>): LoadedFont => ({
    className: "",
    variable: "",
    style: { fontFamily: family },
  });
}

export const Inter = loader("Inter");
export const Geist = loader("Geist");
export const Geist_Mono = loader("Geist Mono");
export const Vazirmatn = loader("Vazirmatn");
export const Noto_Sans = loader("Noto Sans");
