import { Label } from "../../src/components/label.tsx";
import { Switch } from "../../src/components/switch.tsx";

export default function SwitchDemo() {
  return (
    <div className="flex items-center space-x-2">
      <Switch id="airplane-mode" />
      <Label htmlFor="airplane-mode">Airplane Mode</Label>
    </div>
  );
}
