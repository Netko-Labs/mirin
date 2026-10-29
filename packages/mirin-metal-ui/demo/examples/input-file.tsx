import { Input } from "../../src/components/input.tsx";
import { Label } from "../../src/components/label.tsx";

export default function InputFile() {
  return (
    <div className="grid w-full max-w-sm items-center gap-3">
      <Label htmlFor="picture">Picture</Label>
      <Input id="picture" type="file" />
    </div>
  );
}
