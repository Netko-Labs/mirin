import { Toggle } from "../../src/components/toggle.tsx";
import { Italic } from "../../src/icons/index.ts";

export default function ToggleOutline() {
  return (
    <Toggle variant="outline" aria-label="Toggle italic">
      <Italic />
    </Toggle>
  );
}
