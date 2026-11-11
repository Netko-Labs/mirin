import { Toggle } from "../../src/components/toggle.tsx";
import { Italic } from "../../src/icons/index.ts";

export default function ToggleLg() {
  return (
    <Toggle size="lg" aria-label="Toggle italic">
      <Italic />
    </Toggle>
  );
}
