import { Toggle } from "../../src/components/toggle.tsx";
import { Italic } from "../../src/icons/index.ts";

export default function ToggleSm() {
  return (
    <Toggle size="sm" aria-label="Toggle italic">
      <Italic />
    </Toggle>
  );
}
