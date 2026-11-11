import { Toggle } from "../../src/components/toggle.tsx";
import { Italic } from "../../src/icons/index.ts";

export default function ToggleWithText() {
  return (
    <Toggle aria-label="Toggle italic">
      <Italic />
      Italic
    </Toggle>
  );
}
