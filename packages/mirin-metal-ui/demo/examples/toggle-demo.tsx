import { Toggle } from "../../src/components/toggle.tsx";
import { BookmarkIcon } from "../../src/icons/index.ts";

export default function ToggleDemo() {
  return (
    <Toggle
      aria-label="Toggle bookmark"
      size="sm"
      variant="outline"
      className="data-[state=on]:bg-transparent data-[state=on]:*:[svg]:fill-blue-500 data-[state=on]:*:[svg]:stroke-blue-500"
    >
      <BookmarkIcon />
      Bookmark
    </Toggle>
  );
}
